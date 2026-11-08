const { WolfFixed } = await import('./fixed.js?ver='+window.srcVersion);
const { WolfTables } = await import('./tables.js?ver='+window.srcVersion);
const { WolfRandom } = await import('./random.js?ver='+window.srcVersion);
const { WolfWorld } = await import('./world.js?ver='+window.srcVersion);
const { WolfPlayer } = await import('./player.js?ver='+window.srcVersion);
const { WolfActors } = await import('./actors.js?ver='+window.srcVersion);
const { WolfRender } = await import('./render.js?ver='+window.srcVersion);
const { WolfHud } = await import('./hud.js?ver='+window.srcVersion);
const { WolfSound } = await import('./sound.js?ver='+window.srcVersion);
const { STATES } = await import('./stateTable.js?ver='+window.srcVersion);
const { SOUND, MUSIC, LEVEL_SONGS } = await import('./soundNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * The game itself: one tic of Wolfenstein, and everything that has to
 * happen in it, in the order the original does it.
 *
 *   the controls are read          (or the next step of a demo)
 *   the doors move, the secret walls move
 *   every actor thinks, the player first
 *   the palette shifts are counted down
 *   the frame is drawn
 *   the clock moves on by the tics of the frame
 *
 * That order is not a detail. Guards are thought about in the order they
 * were spawned, and each of them takes bytes out of `rndtable` as it goes;
 * change the order and every fight comes out differently. The same goes for
 * `tics`: the original works out how many 1/70ths of a second the last
 * frame took and multiplies everything by it, so the same input on a faster
 * machine gives a different game. A demo is recorded at a fixed four tics a
 * step for exactly that reason, and so is `match*`.
 *
 * What is not here: the menu, the intermission and the story screens (they
 * are in {@link WolfScreens}), and the sound hardware (the game only says
 * *what* to play, {@link WolfSound} keeps the queue, and the audio manager
 * on the main thread makes the noise).
 */
export class WolfGame {

  /** a tic is a seventieth of a second */
  static get TICKBASE() { return 70; }
  /** a demo plays four tics to a step, whatever the machine does */
  static get DEMOTICS() { return 4; }
  /** how far a key held for one tic asks the player to walk or turn */
  static get BASEMOVE() { return 35; }
  static get RUNMOVE() { return 70; }
  /** never more than this many tics in one frame */
  static get MAXTICS() { return 10; }
  /** the view: the screen without the status bar */
  static get VIEWWIDTH() { return 320; }
  static get VIEWHEIGHT() { return 160; }
  /** how the red and white flashes are built and how long they last */
  static get NUMREDSHIFTS() { return 6; }
  static get REDSTEPS() { return 8; }
  static get NUMWHITESHIFTS() { return 3; }
  static get WHITESTEPS() { return 20; }
  static get WHITETICS() { return 6; }

  /** Which track plays on which level ({@link LEVEL_SONGS}). */
  static get SONGS() { return LEVEL_SONGS; }

  /**
   * @param {WolfAssets} assets - The data, already loaded.
   */
  constructor(assets) {
    this.id = 'WolfGame';
    this.assets = assets;

    this.tables = new WolfTables();
    this.tables.calcProjection(WolfGame.VIEWWIDTH, WolfGame.VIEWHEIGHT);
    this.random = new WolfRandom(assets.rndtable);
    this.world = new WolfWorld();
    this.agent = new WolfPlayer(this);
    this.actorsLogic = new WolfActors(this);
    this.render = new WolfRender(this.tables, assets, this.world);
    this.hud = new WolfHud(this, assets);
    this.sound = new WolfSound(this);
    this.states = { player: STATES.s_player, attack: STATES.s_attack, deathcam: STATES.s_deathcam };

    /** the actors, the player first, in the order they were spawned */
    this.actors = [];
    /** the player's own record */
    this.player = null;

    /** everything the game keeps about how well it is going */
    this.gamestate = WolfGame.newGameState();
    /** how many tics this frame is worth */
    this.tics = 1;
    /** how far the view may be off centre and still count as "in front" */
    this.shootdelta = Math.floor(WolfGame.VIEWWIDTH / 10);

    /** the buttons this frame, and which of them were already held */
    this.buttonstate = new Array(8).fill(false);
    this.buttonheld = new Array(8).fill(false);
    /** what the player is holding down right now, from the model */
    this.buttonsDown = new Array(8).fill(false);
    /** the four direction keys, likewise */
    this.keys = { left: false, right: false, forward: false, back: false };
    this.controlx = 0;
    this.controly = 0;
    /** someone fired or shouted this frame, so the guards can hear it */
    this.madenoise = false;

    /** what ended the level, if anything: '', 'completed', 'died', ... */
    this.playstate = '';
    this.killerobj = null;
    this.godmode = false;
    this.noclip = false;
    this.gotgatgun = 0;

    /** the flashes: white for a bonus, red for a wound */
    this.bonuscount = 0;
    this.damagecount = 0;
    this.palshifted = false;

    /** a demo being played back, or null */
    this.demo = null;
    this.demoplayback = false;
    this.demorecord = false;

    /** the frame counter, which is what `match*` counts by */
    this.frame = 0;
  } // constructor

  /** `gamestate`, as `NewGame` leaves it. */
  static newGameState() {
    return {
      difficulty: 1, mapon: 0, oldscore: 0, score: 0, nextextra: WolfPlayer.EXTRAPOINTS,
      lives: 3, health: 100, ammo: WolfPlayer.STARTAMMO, keys: 0,
      bestweapon: WolfPlayer.WEAPON.PISTOL, weapon: WolfPlayer.WEAPON.PISTOL,
      chosenweapon: WolfPlayer.WEAPON.PISTOL,
      faceframe: 0, attackframe: 0, attackcount: 0, weaponframe: 0,
      episode: 0, secretcount: 0, treasurecount: 0, killcount: 0,
      secrettotal: 0, treasuretotal: 0, killtotal: 0,
      TimeCount: 0, killx: 0, killy: 0, victoryflag: false
    };
  } // newGameState

  /** `NewGame`: a fresh start on one of the four settings. */
  newGame(difficulty, episode) {
    this.gamestate = WolfGame.newGameState();
    this.gamestate.difficulty = difficulty;
    this.gamestate.episode = episode || 0;
    this.playstate = '';
  } // newGame

  // -------------------------------------------------------------- the level

  /**
   * `SetupGameLevel`: builds the world out of the level data and puts
   * everything in it. The table of randomness starts from zero for a demo
   * and from the clock otherwise - that one line is the whole difference
   * between a repeatable game and a fresh one (R-009).
   *
   * @param {Object} level - `data/levels/levelNN.json`.
   * @param {number} [seed] - Stands in for the clock when not a demo.
   */
  setupLevel(level, seed) {
    this.random.init(!(this.demoplayback || this.demorecord), seed);
    this.gamestate.secrettotal = 0;
    this.gamestate.killtotal = 0;
    this.gamestate.treasuretotal = 0;
    this.gamestate.secretcount = 0;
    this.gamestate.killcount = 0;
    this.gamestate.treasurecount = 0;
    this.gamestate.TimeCount = 0;
    this.gamestate.victoryflag = false;
    this.playstate = '';
    this.frame = 0;
    this.bonuscount = this.damagecount = 0;

    this.actors = [];
    this.player = WolfActors.newActor();
    this.actors.push(this.player);
    this.agent.anglefrac = 0;
    this.agent.facecount = 0;

    var self = this;
    this.render.onBonus = function (statobj) { self.agent.getBonus(statobj); };
    this.world.setupLevel(level, this);
    this.world.connectAreas();
    this.sound.reset();
  } // setupLevel

  /**
   * `ScanInfoPlane`: what each number of plane 1 puts on the level. The
   * ranges are the original's: the same kind of guard turns up three times
   * over, once for each setting from "don't hurt me" up, and the harder
   * ones are simply skipped on an easier game.
   * @param {number} tile - The number in plane 1.
   */
  spawnThing(tile, x, y) {
    var actors = this.actorsLogic;
    var enemy = WolfActors.ENEMY;
    var difficulty = this.gamestate.difficulty;

    // the player, facing one of four ways
    if (tile >= 19 && tile <= 22) {
      this.agent.spawn(this.player, x, y, tile - 19);
      return;
    }
    // the things on the floor
    if (tile >= 23 && tile <= 74) {
      this.world.spawnStatic(x, y, tile - 23);
      return;
    }
    // a secret wall counts towards the secrets of the level
    if (tile === WolfWorld.PUSHABLETILE) {
      this.gamestate.secrettotal++;
      return;
    }
    if (tile === 124) {
      actors.spawnDeadGuard(x, y);
      return;
    }
    if (tile === 214) {
      actors.spawnBoss(x, y);
      return;
    }

    // the guards. Each block of four is one kind facing four ways, and the
    // three blocks are the three settings it appears from
    var groups = [
      { base: 108, kind: enemy.guard, patrol: false },
      { base: 112, kind: enemy.guard, patrol: true },
      { base: 116, kind: enemy.officer, patrol: false },
      { base: 120, kind: enemy.officer, patrol: true },
      { base: 126, kind: enemy.ss, patrol: false },
      { base: 130, kind: enemy.ss, patrol: true },
      { base: 134, kind: enemy.dog, patrol: false },
      { base: 138, kind: enemy.dog, patrol: true }
    ];
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      for (var level = 0; level < 3; level++) {
        var base = group.base + level * 36;
        if (tile >= base && tile < base + 4) {
          // level 0 is every game, 1 needs "bring 'em on", 2 needs "death incarnate"
          if (level === 1 && difficulty < 2) return;
          if (level === 2 && difficulty < 3) return;
          var dir = tile - base;
          if (group.patrol) actors.spawnPatrol(group.kind, x, y, dir);
          else actors.spawnStand(group.kind, x, y, dir);
          return;
        }
      }
    }

    // the mutants, whose three blocks are eighteen apart rather than 36
    var mutantGroups = [{ base: 216, patrol: false }, { base: 220, patrol: true }];
    for (var m = 0; m < mutantGroups.length; m++) {
      for (var step = 0; step < 3; step++) {
        var mbase = mutantGroups[m].base + step * 18;
        if (tile >= mbase && tile < mbase + 4) {
          if (step === 1 && difficulty < 2) return;
          if (step === 2 && difficulty < 3) return;
          var mdir = tile - mbase;
          if (mutantGroups[m].patrol) actors.spawnPatrol(enemy.mutant, x, y, mdir);
          else actors.spawnStand(enemy.mutant, x, y, mdir);
          return;
        }
      }
    }
  } // spawnThing

  /** The tune this level plays. */
  levelSong() {
    return WolfGame.SONGS[this.gamestate.mapon % WolfGame.SONGS.length];
  } // levelSong

  // ---------------------------------------------------------------- one tic

  /**
   * One frame of the game (`PlayLoop`), in the original's order.
   * @param {VGAVideoRAM} screen - Where to draw it.
   * @param {number} [tics] - How many tics this frame is worth; a demo and
   *        the tools always pass four.
   */
  playFrame(screen, tics) {
    this.tics = tics === undefined ? 1 : Math.min(tics, WolfGame.MAXTICS);
    this.pollControls();
    this.madenoise = false;

    this.world.moveDoors(this.tics);
    this.world.movePWalls(this.tics);

    // the player first, then everyone else in the order they were spawned;
    // an actor may remove itself, so the list is walked by index
    for (var i = 0; i < this.actors.length; i++) {
      var actor = this.actors[i];
      var before = this.actors.length;
      this.actorsLogic.doActor(actor);
      if (this.actors.length < before && this.actors[i] !== actor) i--;
    }

    this.updatePaletteShifts();
    this.sound.tick(this.tics);
    this.render.refresh(screen, this.player, this.actors, this.gamestate.mapon, this.gamestate);
    this.hud.draw(screen);
    this.gamestate.TimeCount += this.tics;
    this.frame++;
  } // playFrame

  /**
   * `PollControls`: what the player asked for this frame. In a demo it is
   * read out of the recording instead, three bytes at a time, and the turn
   * and the walk are multiplied by the four tics the step lasts.
   */
  pollControls() {
    this.controlx = 0;
    this.controly = 0;
    for (var i = 0; i < this.buttonstate.length; i++) {
      this.buttonheld[i] = this.buttonstate[i];
      this.buttonstate[i] = false;
    }

    if (this.demoplayback) {
      var demo = this.demo;
      if (demo.at + 3 > demo.end) {
        this.playstate = 'completed';
        return;
      }
      var buttonbits = demo.record[demo.at++];
      for (var button = 0; button < 8; button++) {
        this.buttonstate[button] = (buttonbits & 1) !== 0;
        buttonbits >>= 1;
      }
      this.controlx = WolfGame.signed(demo.record[demo.at++]) * this.tics;
      this.controly = WolfGame.signed(demo.record[demo.at++]) * this.tics;
      if (demo.at >= demo.end) this.playstate = 'completed';
      return;
    }

    for (var b = 0; b < this.buttonstate.length; b++) this.buttonstate[b] = this.buttonsDown[b];
    // `PollKeyboardMove`: a key held for one tic is worth 35 units, or 70
    // with the run button down
    var move = this.buttonstate[WolfPlayer.BUTTON.RUN] ? WolfGame.RUNMOVE : WolfGame.BASEMOVE;
    if (this.keys.forward) this.controly -= move * this.tics;
    if (this.keys.back) this.controly += move * this.tics;
    if (this.keys.left) this.controlx -= move * this.tics;
    if (this.keys.right) this.controlx += move * this.tics;
    // the original bounds a frame's movement so that a slow frame cannot
    // throw the player across the room
    var max = 100 * this.tics;
    if (this.controlx > max) this.controlx = max;
    else if (this.controlx < -max) this.controlx = -max;
    if (this.controly > max) this.controly = max;
    else if (this.controly < -max) this.controly = -max;
  } // pollControls

  /** A byte of a demo read as the signed number it is. */
  static signed(value) {
    return value > 127 ? value - 256 : value;
  } // signed

  /**
   * Starts a recorded demo (`PlayDemo`): the level it plays is in the first
   * byte, the length in the two after it, and the steps start at the fourth.
   * @param {Object} demo - An entry of `data/demos.json`, decoded.
   */
  startDemo(demo) {
    var record = demo.record;
    var length = record[1] | (record[2] << 8);
    this.demo = { record: record, at: 4, end: Math.min(length, record.length), level: record[0] };
    this.demoplayback = true;
    this.gamestate.mapon = record[0];
    this.gamestate.difficulty = 3;             // a demo is always played on hard
    return this.demo;
  } // startDemo

  /** How many tics a frame is worth right now. */
  ticsOfFrame() {
    return this.demoplayback || this.demorecord ? WolfGame.DEMOTICS : this.tics;
  } // ticsOfFrame

  // ------------------------------------------------------- what the game asks

  /** `StartBonusFlash`: the screen goes white for a moment. */
  startBonusFlash() {
    this.bonuscount = WolfGame.NUMWHITESHIFTS * WolfGame.WHITETICS;
  } // startBonusFlash

  /** `StartDamageFlash`: and red when he is hit, the more the harder. */
  startDamageFlash(damage) {
    this.damagecount += damage;
  } // startDamageFlash

  /**
   * `UpdatePaletteShifts`: how far towards red or white the palette is this
   * frame. Red wins over white when both are running.
   */
  updatePaletteShifts() {
    var white = 0;
    var red = 0;
    if (this.bonuscount) {
      white = Math.floor(this.bonuscount / WolfGame.WHITETICS) + 1;
      if (white > WolfGame.NUMWHITESHIFTS) white = WolfGame.NUMWHITESHIFTS;
      this.bonuscount -= this.tics;
      if (this.bonuscount < 0) this.bonuscount = 0;
    }
    if (this.damagecount) {
      red = Math.floor(this.damagecount / 10) + 1;
      if (red > WolfGame.NUMREDSHIFTS) red = WolfGame.NUMREDSHIFTS;
      this.damagecount -= this.tics;
      if (this.damagecount < 0) this.damagecount = 0;
    }
    this.shift = red ? { color: 'red', step: red } : (white ? { color: 'white', step: white } : null);
    this.palshifted = this.shift !== null;
  } // updatePaletteShifts

  /**
   * The palette as the DAC should have it this frame: the game palette, or
   * that palette faded towards red or towards white.
   *
   * The original builds these six red and three white palettes once at the
   * start; here they are built the same way, in six bit components, and
   * cached.
   * @returns {Uint8Array} 768 six-bit components.
   */
  paletteBytes() {
    var base = this.assets.palette;
    if (!this.shift) return base;
    if (!this.shifts) this.shifts = this.buildShifts(base);
    var table = this.shift.color === 'red' ? this.shifts.red : this.shifts.white;
    return table[this.shift.step - 1];
  } // paletteBytes

  /** `InitRedShifts`: the two ramps, in the card's own six bits. */
  buildShifts(base) {
    var red = [];
    var white = [];
    var step;
    var i;
    for (step = 1; step <= WolfGame.NUMREDSHIFTS; step++) {
      var toRed = new Uint8Array(768);
      for (i = 0; i < 256; i++) {
        toRed[i * 3] = base[i * 3] + Math.trunc(((64 - base[i * 3]) * step) / WolfGame.REDSTEPS);
        toRed[i * 3 + 1] = base[i * 3 + 1] + Math.trunc((-base[i * 3 + 1] * step) / WolfGame.REDSTEPS);
        toRed[i * 3 + 2] = base[i * 3 + 2] + Math.trunc((-base[i * 3 + 2] * step) / WolfGame.REDSTEPS);
      }
      red.push(toRed);
    }
    for (step = 1; step <= WolfGame.NUMWHITESHIFTS; step++) {
      var toWhite = new Uint8Array(768);
      for (i = 0; i < 256; i++) {
        toWhite[i * 3] = base[i * 3] + Math.trunc(((64 - base[i * 3]) * step) / WolfGame.WHITESTEPS);
        toWhite[i * 3 + 1] = base[i * 3 + 1] + Math.trunc(((62 - base[i * 3 + 1]) * step) / WolfGame.WHITESTEPS);
        toWhite[i * 3 + 2] = base[i * 3 + 2] + Math.trunc((-base[i * 3 + 2] * step) / WolfGame.WHITESTEPS);
      }
      white.push(toWhite);
    }
    return { red: red, white: white };
  } // buildShifts

  /** `VictoryTile`: the player stepped onto the tile that ends an episode. */
  victoryTile() {
    this.actorsLogic.spawnBJVictory();
    this.gamestate.victoryflag = true;
  } // victoryTile

  // ---------------------------------------------------- the rest of the game

  /** What the player's logic calls when it hits something. */
  damageActor(ob, damage) {
    this.actorsLogic.damageActor(ob, damage);
  } // damageActor

  checkLine(ob) {
    return this.actorsLogic.checkLine(ob);
  } // checkLine

  /** A sound with no place: the menu, the weapon, the player's own noises. */
  playSound(number) {
    this.sound.play(number);
  } // playSound

  /** A sound somewhere in the level, which is quieter the further it is. */
  playSoundLocTile(number, tilex, tiley) {
    this.sound.playAt(number, (tilex << 16) + 0x8000, (tiley << 16) + 0x8000);
  } // playSoundLocTile

  playSoundLocActor(number, ob) {
    this.sound.playAt(number, ob.x, ob.y);
  } // playSoundLocActor

  /** What is playing, if anything - the game asks before it thumps a wall. */
  soundPlaying() {
    return this.sound.playing();
  } // soundPlaying

  /**
   * The state a tool compares after every tic (`matchdemo`): the player,
   * the clock, the index into the table of randomness, and every actor.
   */
  snapshot() {
    var actors = [];
    for (var i = 1; i < this.actors.length; i++) {
      var ob = this.actors[i];
      actors.push({
        obclass: ob.obclass, x: ob.x, y: ob.y, tilex: ob.tilex, tiley: ob.tiley,
        dir: ob.dir, distance: ob.distance, hitpoints: ob.hitpoints, ticcount: ob.ticcount,
        flags: ob.flags, speed: ob.speed, temp1: ob.temp1, temp2: ob.temp2,
        state: this.stateNameOf(ob.state)
      });
    }
    return {
      frame: this.frame,
      tics: this.tics,
      time: this.gamestate.TimeCount,
      rndindex: this.random.index,
      player: {
        x: this.player.x, y: this.player.y, angle: this.player.angle,
        tilex: this.player.tilex, tiley: this.player.tiley,
        areanumber: this.player.areanumber, anglefrac: this.agent.anglefrac,
        health: this.gamestate.health, ammo: this.gamestate.ammo,
        score: this.gamestate.score, keys: this.gamestate.keys,
        weapon: this.gamestate.weapon, weaponframe: this.gamestate.weaponframe,
        attackframe: this.gamestate.attackframe, attackcount: this.gamestate.attackcount,
        state: this.stateNameOf(this.player.state)
      },
      counts: {
        kill: this.gamestate.killcount, killtotal: this.gamestate.killtotal,
        secret: this.gamestate.secretcount, secrettotal: this.gamestate.secrettotal,
        treasure: this.gamestate.treasurecount, treasuretotal: this.gamestate.treasuretotal
      },
      doors: Array.from(this.world.doorposition.subarray(0, this.world.doors.length)),
      pwall: { state: this.world.pwallstate, pos: this.world.pwallpos, x: this.world.pwallx, y: this.world.pwally },
      actors: actors
    };
  } // snapshot

  /** The name of a state, for a report or a snapshot. */
  stateNameOf(state) {
    if (!state) return null;
    var names = Object.keys(STATES);
    for (var i = 0; i < names.length; i++) if (STATES[names[i]] === state) return names[i];
    return null;
  } // stateNameOf

} // WolfGame
