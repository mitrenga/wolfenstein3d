const { WolfFixed } = await import('./fixed.js?ver='+window.srcVersion);
const { RIGHTTABLE, LEFTTABLE, ATABLEMAX } = await import('./soundTables.js?ver='+window.srcVersion);
const { DIGI_MAP } = await import('./digiMap.js?ver='+window.srcVersion);
// begin code

/**
 * What the game asks to be played, and the one rule that decides whether it
 * gets played: **priority**.
 *
 * The card of 1992 could make one noise at a time. Every effect carries a
 * priority in its own data (the byte pair in front of the AdLib and the PC
 * speaker versions alike), and a new sound is only started if it is at
 * least as important as the one already going. A guard's shout loses
 * against the player's own gun; the gun loses against the level being
 * finished. Get that wrong and the game sounds busy in the wrong places.
 *
 * How long a sound holds the card is not a guess either: an effect is one
 * byte per 1/140 s, so a sound of `length` bytes lasts `length/2` tics of
 * the game. That number is what `SD_SoundPlaying` answers with, and the
 * game reads it - the player does not thump a wall while anything else is
 * playing, and BJ's face freezes while the chain gun is being picked up.
 *
 * This class is the **queue and the bookkeeping only**; it runs inside the
 * worker with no audio anywhere near it. What comes out is a short list per
 * frame of what to start, which the model hands to the audio manager, and
 * that is where a sound becomes an OPL2 register stream or a sample
 * (`app/audioManager.js`).
 *
 * The machine this build is a model of is an **AdLib-compatible card with
 * a DAC** - a Sound Blaster, which is what most of the machines that ran
 * this game had. That is two settings, not one, and the original keeps them
 * apart:
 *
 * - `SoundMode = AdLib`: the music is IMF and an effect is the AdLib one
 *   from AUDIOT, played on voice 0 of the OPL2;
 * - `DigiMode = SoundBlaster`: the twenty effects that **have** a digitised
 *   version in VSWAP ({@link DIGI_MAP}) come out of the DAC instead, and
 *   their AdLib version is not played at all.
 *
 * A door, a gunshot, a shout and a scream are all in those twenty, so on a
 * Sound Blaster most of what the player hears is a recording and the FM
 * part is left with the beeps and the pickups. An AdLib-only machine is
 * `digiMode = OFF` and still plays everything.
 *
 * The two have **priorities of their own**, again as the original does: the
 * DAC and voice 0 are separate pieces of hardware and one does not silence
 * the other. `SD_SoundPlaying`, which the game asks before it lets the
 * player thump a wall, answers for the FM sound only - so a digitised
 * sound does not hold the game up.
 */
export class WolfSound {

  /** the three ways an effect can be made, as the original names them */
  static get MODE() { return { OFF: 0, PC: 1, ADLIB: 2 }; }
  /**
   * What the OPL2's output is multiplied by on the way out, for the effects
   * and the music alike.
   *
   * One voice of a YM3812 at full tilt is a small part of the range a sample
   * has, and an AdLib had an amplifier behind the chip; without a factor the
   * game would play at about a twentieth of the volume of everything else in
   * the browser. Four brings a gunshot to roughly a third of full scale and
   * still leaves the loudest chords of the music room.
   *
   * It lives here, in the game, and not in the library: how loud a game is,
   * is the game's decision, and `AdlibSound` and `AdlibIMF` default to one
   * like every other chip in svision. The audio manager and the `match*`
   * tools both take it from here, so there is one number, in one place.
   */
  static get OPL_GAIN() { return 4; }
  /** and the three the digitised sounds can come out of */
  static get DIGI() { return { OFF: 0, SOUNDSOURCE: 1, SOUNDBLASTER: 2, PC: 3 }; }
  /** an effect is one byte per 1/140 s, so two of them to a tic */
  static get TICSPERBYTE() { return 0.5; }
  /** and a tic is 1/70 s, which is what a digitised sound is measured in */
  static get TICRATE() { return 70; }

  constructor(game) {
    this.id = 'WolfSound';
    this.game = game;
    /** which card the effects come out of; AdLib by default */
    this.mode = WolfSound.MODE.ADLIB;
    /** and where the digitised ones come out of: a Sound Blaster's DAC */
    this.digiMode = WolfSound.DIGI.SOUNDBLASTER;
    /** which digitised sound stands for which effect, or -1 */
    this.digiMap = DIGI_MAP;
    /** how long each digitised sound is, in tics; filled by `loadDigi` */
    this.digiTable = [];

    /** the digitised sound holding the DAC, how important, how much is left */
    this.digiNumber = 0;
    this.digiPriority = 0;
    this.digiTics = 0;

    /** the sound holding the card, and how important it is */
    this.soundNumber = 0;
    this.soundPriority = 0;
    /** how many tics of it are left */
    this.soundTics = 0;
    /** where the sound is, when it is somewhere */
    this.positioned = false;
    this.soundx = 0;
    this.soundy = 0;
    /** the ears, 0 to 8 each */
    this.leftchannel = 8;
    this.rightchannel = 8;

    /** what to tell the model this frame */
    this.queue = [];
    /** the tune that should be playing */
    this.music = -1;

    /** the priorities and lengths of the effects, from `data/sounds/adlib.json` */
    this.table = [];
  } // constructor

  /**
   * The table of effects the priorities come out of.
   * @param {Object} data - `data/sounds/adlib.json`.
   */
  loadTable(data) {
    this.table = data.sounds.map((sound) => (sound
      ? { priority: sound.priority, length: sound.length, name: sound.name }
      : null));
    return this;
  } // loadTable

  /**
   * How long the digitised sounds are.
   * @param {Object} digi - `{rate, seconds: []}`, from `data/sounds/digi.json`.
   */
  loadDigi(digi) {
    this.digiTable = (digi && digi.seconds ? digi.seconds : []).map(
      (seconds) => (seconds ? Math.ceil(seconds*WolfSound.TICRATE) : 0));
    return this;
  } // loadDigi

  /**
   * Which digitised sound an effect plays as, or -1 for none - which is
   * every effect when the DAC is switched off, and every effect the data
   * has no digitised version of.
   * @param {number} number - The sound number.
   * @returns {number}
   */
  digiOf(number) {
    if (this.digiMode === WolfSound.DIGI.OFF) return -1;
    var digi = this.digiMap[number];
    if (digi === undefined || digi < 0) return -1;
    // a slot the shareware data leaves empty is no sound at all
    return this.digiTable[digi] ? digi : -1;
  } // digiOf

  /** A new level: nothing is playing. */
  reset() {
    this.soundNumber = 0;
    this.soundPriority = 0;
    this.soundTics = 0;
    this.digiNumber = 0;
    this.digiPriority = 0;
    this.digiTics = 0;
    this.positioned = false;
    this.queue = [];
  } // reset

  /**
   * `SD_PlaySound`: start a sound if it is at least as important as what is
   * already playing.
   * @param {number} number - Which effect ({@link SOUND}).
   * @returns {boolean} Whether it was started.
   */
  play(number) {
    if (number === undefined || number < 0) return false;
    var entry = this.table[number];
    if (!entry) return false;

    // The DAC first, as the original does: an effect with a digitised
    // version is played as a recording **and the AdLib one is not played**.
    // It has its own priority, because it is its own piece of hardware.
    var digi = this.digiOf(number);
    if (digi >= 0) {
      if (entry.priority < this.digiPriority) {
        this.leftchannel = this.rightchannel = 8;
        this.positioned = false;
        return false;
      }
      this.digiNumber = number;
      this.digiPriority = entry.priority;
      this.digiTics = this.digiTable[digi];
      this.queue.push({
        sound: number, digi: digi, priority: entry.priority,
        left: this.leftchannel, right: this.rightchannel,
        positioned: this.positioned
      });
      this.leftchannel = this.rightchannel = 8;
      this.positioned = false;
      return true;
    }

    if (this.mode === WolfSound.MODE.OFF) return false;
    if (entry.priority < this.soundPriority) {
      this.leftchannel = this.rightchannel = 8;
      this.positioned = false;
      return false;
    }
    this.soundNumber = number;
    this.soundPriority = entry.priority;
    this.soundTics = Math.ceil(entry.length * WolfSound.TICSPERBYTE);
    this.queue.push({
      sound: number, priority: entry.priority,
      left: this.leftchannel, right: this.rightchannel,
      positioned: this.positioned
    });
    this.leftchannel = this.rightchannel = 8;
    this.positioned = false;
    return true;
  } // play

  /**
   * `PlaySoundLocGlobal`: a sound somewhere in the level. Where it is in
   * the **view** is what decides how loud each ear hears it, so a guard
   * behind the player is quiet in both.
   */
  playAt(number, gx, gy) {
    this.setSoundLoc(gx, gy);
    this.positioned = true;
    if (this.play(number)) {
      this.soundx = gx;
      this.soundy = gy;
    }
  } // playAt

  /**
   * `SetSoundLoc`: the point, turned into view coordinates and looked up in
   * the two panning tables.
   */
  setSoundLoc(gx, gy) {
    var render = this.game.render;
    var dx = gx - render.viewx;
    var dy = gy - render.viewy;
    var x = (WolfFixed.byFrac(dx, render.viewcos) - WolfFixed.byFrac(dy, render.viewsin)) >> 16;
    var y = (WolfFixed.byFrac(dy, render.viewcos) + WolfFixed.byFrac(dx, render.viewsin)) >> 16;

    if (y >= ATABLEMAX) y = ATABLEMAX - 1;
    else if (y <= -ATABLEMAX) y = -ATABLEMAX;
    if (x < 0) x = -x;
    if (x >= ATABLEMAX) x = ATABLEMAX - 1;
    this.leftchannel = LEFTTABLE[x][y + ATABLEMAX];
    this.rightchannel = RIGHTTABLE[x][y + ATABLEMAX];
  } // setSoundLoc

  /**
   * `UpdateSoundLoc`: a sound that is somewhere keeps being panned as the
   * player turns, for as long as it lasts.
   */
  updateSoundLoc() {
    if (!this.positionedPlaying) return null;
    this.setSoundLoc(this.soundx, this.soundy);
    return { left: this.leftchannel, right: this.rightchannel };
  } // updateSoundLoc

  /**
   * `SD_SoundPlaying`: which effect is playing, or 0 for none. The game
   * asks this, so the counting down has to happen whether anyone is
   * listening or not.
   * @returns {number}
   */
  playing() {
    return this.soundTics > 0 ? this.soundNumber : 0;
  } // playing

  /** `SD_StopSound`: both of them, the DAC and voice 0. */
  stop() {
    this.soundTics = 0;
    this.soundNumber = 0;
    this.soundPriority = 0;
    this.digiTics = 0;
    this.digiNumber = 0;
    this.digiPriority = 0;
    this.queue.push({ stop: true });
  } // stop

  /**
   * The tics of a frame go by. The two run down separately: a digitised
   * sound ending is `SDL_DigitizedDone` clearing `DigiNumber` and
   * `DigiPriority`, and it says nothing about voice 0.
   */
  tick(tics) {
    if (this.digiTics > 0) {
      this.digiTics -= tics;
      if (this.digiTics <= 0) {
        this.digiTics = 0;
        this.digiNumber = 0;
        this.digiPriority = 0;
      }
    }
    if (this.soundTics > 0) {
      this.soundTics -= tics;
      if (this.soundTics <= 0) {
        this.soundTics = 0;
        this.soundNumber = 0;
        this.soundPriority = 0;
        this.positionedPlaying = false;
      }
    }
  } // tick

  /** `StartMusic`: the tune of this level. */
  startMusic(track) {
    this.music = track;
    this.queue.push({ music: track });
  } // startMusic

  /** Everything that happened this frame, and an empty queue after it. */
  takeQueue() {
    var queue = this.queue;
    this.queue = [];
    return queue;
  } // takeQueue

} // WolfSound
