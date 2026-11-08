const { AbstractAudioManager } = await import('./svision/js/audio/abstractAudioManager.js?ver='+window.srcVersion);
const { AudioSampleHandler } = await import('./svision/js/audio/audioSampleHandler.js?ver='+window.srcVersion);
const { PCMSample } = await import('./svision/js/audio/pcmSample.js?ver='+window.srcVersion);
const { OPL2 } = await import('./svision/js/audio/chip/opl2.js?ver='+window.srcVersion);
const { AdlibSound } = await import('./svision/js/audio/chip/adlibSound.js?ver='+window.srcVersion);
const { AdlibIMF } = await import('./svision/js/audio/chip/adlibIMF.js?ver='+window.srcVersion);
const { WolfSound } = await import('./wolf/sound.js?ver='+window.srcVersion);
const { ModuleWorker } = await import('./svision/js/moduleWorker.js?ver='+window.srcVersion);
// begin code

/**
 * The sound of the machine, as an AdLib made it.
 *
 * The card of the original had **nine voices and played both at once**: the
 * music took voices one to eight and a sound effect took voice zero. That is
 * not a guess - it is why every IMF stream of the game keys on channels 1 to
 * 8 and never 0, and why the effect driver writes voice 0 and nothing else.
 *
 * Here they are two **buses**: `sounds` for the effects, one at a time as a
 * DAC (which is what the priority in {@link WolfSound} decides), and `music`
 * of its own. Before that they shared one bus and **every shot cut the music
 * dead** (reported 2026-09-17). A bus each is the small fix; the faithful one
 * is a single chip rendering both, which is a bigger question (`NOTES.md` §8).
 *
 * Both kinds of sound are the same OPL2 in the end, and both drivers are
 * the library's - the formats are id Software's and Apogee's, not this
 * game's, so they sit in svision next to the MIDI one (`AdlibSound`,
 * `AdlibIMF`); what is left here is when to play what, and how loud:
 *
 * - an **effect** is an instrument and one byte of note per 1/140 s
 *   (`data/sounds/adlib.json`), rendered the first time it is heard and
 *   kept as a sample afterwards - a few tens of milliseconds of work;
 * - the **music** is IMF, a recording of the register writes themselves
 *   (`data/music/trackNN.json`), rendered **in a worker of its own**
 *   (`app/musicWorker.js`) and played as one long sample. A track is a
 *   minute of chip and some five seconds of processor; rendered in the page
 *   between frames, with a budget small enough not to stutter the game, the
 *   first tune of a level was ready after a minute and a half - which is
 *   what "the music does not play" turned out to mean (2026-09-17). Where
 *   there is no worker to be had, the page falls back to the slices;
 * - a **digitised** sound is a recording out of VSWAP, unsigned eight bit
 *   at 7 000 Hz, and needs no rendering at all: it is a `PCMSample` the
 *   moment the data arrives. Which effects have one and when they are
 *   played instead of the AdLib version is the game's decision
 *   (`app/wolf/digiMap.js`, `WolfSound.play`) - a machine with a Sound
 *   Blaster played the twenty recordings and made the rest with FM, and
 *   that is the machine this build is a model of.
 */
export class AudioManager extends AbstractAudioManager {

  constructor(app) {
    super(app);
    this.id = 'AudioManager';

    /** the AdLib effects as they are on disk */
    this.effects = [];
    /** the digitised sounds, by their own numbering (`app/wolf/digiMap.js`) */
    this.digi = [];
    /** the IMF streams by track number */
    this.tracks = {};
    /** what has been rendered: `PCMSample` by key */
    this.samples = {};
    /** the track that should be playing, -1 for none */
    this.musicRequested = -1;
    /** the tracks still to render, and the one in hand */
    this.musicQueue = [];
    this.rendering = null;
    this.renderTimer = 0;
    /** the worker that renders them, once it is built */
    this.renderWorker = null;
    this.renderWorkerFailed = false;
    this.renderingIndex = null;
    /** whether the data has arrived */
    this.loaded = false;
  } // constructor

  /**
   * What the effects are rendered at. The card's output stage rolls off at
   * 7 kHz, so 22 050 keeps everything there is and a sound effect is a few
   * tens of kilobytes rather than a few hundred.
   */
  static get EFFECT_RATE() { return 22050; }
  /**
   * Three buses, because a Sound Blaster was three things at once: the FM
   * effects on voice 0, the music on voices 1 to 8, and the DAC. A shot and
   * a door can overlap on the real card, so they do here.
   */
  static get SOUND_BUS() { return 'sounds'; }
  static get MUSIC_BUS() { return 'music'; }
  static get DIGI_BUS() { return 'digi'; }
  /** And the music, which is minutes rather than seconds long. */
  static get MUSIC_RATE() { return Math.round(OPL2.SAMPLE_RATE / 2); }
  /** How long a slice of background rendering may take, and how long it rests. */
  static get RENDER_BUDGET_MS() { return 8; }
  static get RENDER_PAUSE_MS() { return 100; }
  static get SLICE_SAMPLES() { return 4096; }

  createAudioHandler(bus, options) {
    return new AudioSampleHandler(this.app);
  } // createAudioHandler

  /**
   * Takes the sound data in.
   * @param {Object} adlib - `data/sounds/adlib.json`.
   * @param {Object} music - `data/music.json`, the index of the tracks.
   * @param {Object} [digi] - `data/sounds/digi.json`, if it was fetched.
   */
  loadSounds(adlib, music, digi) {
    this.effects = (adlib.sounds || []).map((sound) => (sound ? {
      name: sound.name, priority: sound.priority, octave: sound.octave,
      instrument: Uint8Array.from(sound.instrument),
      data: AudioManager.fromBase64(sound.data)
    } : null));
    if (digi) {
      this.digi = (digi.sounds || []).map((sound) => (sound
        ? PCMSample.fromUnsigned8(AudioManager.fromBase64(sound.pcm), digi.rate)
        : null));
    }
    this.musicIndex = music;
    this.loaded = true;
  } // loadSounds

  /**
   * One track's stream, as it arrives from the server.
   * @param {Object} track - `data/music/trackNN.json`.
   */
  loadTrack(track) {
    this.tracks[track.index] = AudioManager.fromBase64(track.stream);
    if (this.musicQueue.indexOf(track.index) < 0 && !this.samples['music' + track.index]) {
      // the one the game is waiting for goes to the front of the queue
      if (this.musicRequested === track.index) this.musicQueue.unshift(track.index);
      else this.musicQueue.push(track.index);
    }
    this.pumpMusic();
  } // loadTrack

  get ready() {
    return this.loaded;
  } // ready

  /**
   * The sample of whatever the bus is asked to play. Effects are rendered
   * here, the first time each one is heard.
   */
  audioData(bus, sound, options) {
    var cached = super.audioData(bus, sound, options);
    if (cached !== false) return cached;
    var sample = this.samples[sound];
    if (!sample && typeof sound === 'string' && sound.indexOf('fx') === 0) {
      sample = this.renderEffect(parseInt(sound.substring(2), 10));
    }
    if (!sample && typeof sound === 'string' && sound.indexOf('digi') === 0) {
      sample = this.digi[parseInt(sound.substring(4), 10)] || null;
    }
    if (!sample) return false;
    if (bus in this.audioDataCache) this.audioDataCache[bus][sound] = sample;
    return sample;
  } // audioData

  /**
   * An effect, rendered and kept.
   * @param {number} number - The sound number.
   * @returns {PCMSample|null}
   */
  renderEffect(number) {
    var key = 'fx' + number;
    if (this.samples[key]) return this.samples[key];
    var effect = this.effects[number];
    if (!effect || !effect.data.length) return null;
    var driver = new AdlibSound({ sampleRate: AudioManager.EFFECT_RATE, gain: WolfSound.OPL_GAIN });
    driver.play(effect);
    this.samples[key] = new PCMSample(driver.renderAll(), driver.sampleRate);
    return this.samples[key];
  } // renderEffect

  /**
   * What the worker decided this frame: a list of sounds to start, a track
   * to play, or an order to stop.
   * @param {Array} queue - From `WolfSound.takeQueue()`.
   * @param {AbstractModel} model - Who sends the bus its orders.
   */
  playFrame(queue, model) {
    if (!queue || !queue.length) return;
    for (var i = 0; i < queue.length; i++) {
      var entry = queue[i];
      if (entry.stop) {
        // `SD_StopSound` stops both: the DAC and voice 0
        model.sendEvent(0, {id: 'stopAudioBus', bus: AudioManager.SOUND_BUS});
        model.sendEvent(0, {id: 'stopAudioBus', bus: AudioManager.DIGI_BUS});
        continue;
      }
      if (entry.music !== undefined) {
        this.playMusic(entry.music, model);
        continue;
      }
      if (entry.sound === undefined) continue;
      // the game has already decided which of the two this is
      if (entry.digi !== undefined && entry.digi >= 0) {
        if (!this.digi[entry.digi]) continue;
        model.sendEvent(0, {id: 'playSound', bus: AudioManager.DIGI_BUS, sound: 'digi' + entry.digi, options: {repeat: 1}});
        continue;
      }
      if (!this.renderEffect(entry.sound)) continue;
      model.sendEvent(0, {id: 'playSound', bus: AudioManager.SOUND_BUS, sound: 'fx' + entry.sound, options: {repeat: 1}});
    }
  } // playFrame

  /**
   * The tune of the level. A track that is not rendered yet is started as
   * soon as it is - the game does not wait for it.
   * @param {number} index - The track number, or -1 to stop.
   */
  playMusic(index, model) {
    this.musicRequested = index;
    if (index < 0) return;
    var sample = this.samples['music' + index];
    if (!sample) {
      // not rendered yet: to the front of the queue, and if it has not even
      // been fetched, ask the application to fetch that one first. The level
      // then starts in silence for as long as one track takes, instead of
      // waiting behind every other track of the episode
      this.musicQueue = this.musicQueue.filter((queued) => queued !== index);
      this.musicQueue.unshift(index);
      if (!this.tracks[index] && this.app.wantTrack) this.app.wantTrack(index);
      this.pumpMusic();
      return;
    }
    if (model) {
      model.sendEvent(0, {id: 'playSound', bus: AudioManager.MUSIC_BUS, sound: 'music' + index, options: {repeat: true}});
    }
  } // playMusic

  stopMusic() {
    this.musicRequested = -1;
  } // stopMusic

  // --------------------------------------------------------------- the music

  /**
   * The renderer. It is built once, when the first track arrives, and every
   * track goes through it one after another - the one the level wants
   * first, so that the tune starts as soon as it possibly can.
   */
  startRenderWorker() {
    if (this.renderWorker || this.renderWorkerFailed) return;
    this.renderWorker = true;                   // being built; do not build twice
    ModuleWorker.create(this.app, AudioManager.MUSIC_WORKER_SOURCES).then((worker) => {
      this.renderWorker = worker;
      worker.onmessage = (event) => this.rendererSaid(event.data);
      worker.onerror = () => this.fallBackToSlices();
      this.pumpMusic();
    }).catch(() => this.fallBackToSlices());
  } // startRenderWorker

  /** The modules the render worker is glued from, in dependency order. */
  static get MUSIC_WORKER_SOURCES() {
    return [
      'svision/js/audio/chip/opl2.js',
      'svision/js/audio/chip/adlibIMF.js',
      'musicWorker.js'
    ];
  } // MUSIC_WORKER_SOURCES

  /** No worker to be had: render in the page, a slice at a time. */
  fallBackToSlices() {
    this.renderWorker = null;
    this.renderWorkerFailed = true;
    this.pumpMusic();
  } // fallBackToSlices

  /** A track came back from the renderer. */
  rendererSaid(message) {
    this.renderingIndex = null;
    if (message.id === 'rendered') {
      this.samples['music'+message.index] = new PCMSample(message.samples, message.sampleRate);
      if (this.musicRequested === message.index && this.model) {
        this.playMusic(message.index, this.model);
      }
    }
    this.pumpMusic();
  } // rendererSaid

  /**
   * Keeps the renderer busy: the track the game is waiting for first, then
   * the rest, one at a time.
   */
  pumpWorker() {
    if (!this.renderWorker || this.renderWorker === true || this.renderingIndex !== null) return;
    var next = this.musicQueue.shift();
    while (next !== undefined && (this.samples['music'+next] || !this.tracks[next])) {
      next = this.musicQueue.shift();
    }
    if (next === undefined) return;
    this.renderingIndex = next;
    this.renderWorker.postMessage({
      id: 'render', index: next, stream: this.tracks[next],
      sampleRate: AudioManager.MUSIC_RATE, gain: WolfSound.OPL_GAIN
    });
  } // pumpWorker

  /**
   * A slice of background rendering **in the page**: only used where a
   * worker could not be made. A few milliseconds of work, then a rest,
   * until every track that has arrived is a sample.
   */
  pumpMusic() {
    if (!this.renderWorkerFailed) {
      this.startRenderWorker();
      this.pumpWorker();
      return;
    }
    if (this.renderTimer) return;
    var until = AudioManager.now() + AudioManager.RENDER_BUDGET_MS;
    while (AudioManager.now() < until) {
      if (this.rendering === null && !this.startRendering()) return;
      this.renderSlice(AudioManager.SLICE_SAMPLES);
    }
    var self = this;
    this.renderTimer = setTimeout(function () {
      self.renderTimer = 0;
      self.pumpMusic();
    }, AudioManager.RENDER_PAUSE_MS);
  } // pumpMusic

  /** Takes the next track out of the queue. */
  startRendering(index) {
    var next = index === undefined ? this.musicQueue.shift() : index;
    if (next === undefined || !this.tracks[next]) return false;
    var player = new AdlibIMF({ sampleRate: AudioManager.MUSIC_RATE, gain: WolfSound.OPL_GAIN });
    // `data/music/` holds the writes and nothing else (`mkdata.mjs` took the
    // length word off), so the stream goes in as it is - `AdlibIMF.stream()`
    // is for a raw file, where the shape has to be guessed at
    player.play(this.tracks[next]);
    var length = Math.max(1, Math.round(player.pieceSeconds * player.sampleRate));
    this.rendering = { index: next, player: player, out: new Float32Array(length), at: 0 };
    return true;
  } // startRendering

  /**
   * Renders the next samples of the track in hand, and keeps it once it is
   * whole. A track that is wanted right now starts playing the moment it is
   * finished.
   * @returns {boolean} True while the track is not finished.
   */
  renderSlice(count) {
    var job = this.rendering;
    if (job === null) return false;
    var chunk = Math.min(count, job.out.length - job.at);
    job.player.render(job.out, chunk, job.at);
    job.at += chunk;
    if (job.at >= job.out.length) {
      this.samples['music' + job.index] = new PCMSample(job.out, job.player.sampleRate);
      var wanted = this.musicRequested === job.index;
      this.rendering = null;
      if (wanted && this.model) this.playMusic(job.index, this.model);
      return false;
    }
    return true;
  } // renderSlice

  /** The clock the rendering budget is measured on. */
  static now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  } // now

  /** Base64 to bytes, in the browser and under Node alike. */
  static fromBase64(text) {
    if (typeof atob === 'function') {
      var binary = atob(text || '');
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(text || '', 'base64'));
  } // fromBase64

} // AudioManager
