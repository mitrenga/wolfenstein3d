const { VGAVideoRAM } = await import('./svision/js/platform/canvas2D/vga/vgaVideoRAM.js?ver='+window.srcVersion);
const { WolfAssets } = await import('./wolf/assets.js?ver='+window.srcVersion);
const { WolfGame } = await import('./wolf/game.js?ver='+window.srcVersion);
const { WolfPlayer } = await import('./wolf/player.js?ver='+window.srcVersion);
const { WolfScreens } = await import('./wolf/screens.js?ver='+window.srcVersion);
// begin code

/**
 * The game program. It runs in a web worker glued out of this module and
 * the ones it imports (svision's `ModuleWorker`), at the original's 70 tics
 * a second, and sends the model its video memory whenever the picture
 * changed. The same class runs under Node for the tools - `new
 * GameWorker(post)` with `handleMessage()` and `tick()`, no timers at all
 * (`app/WORKER-PROTOCOL.md`).
 *
 * The clock is the one thing worth reading twice. The original counts in
 * **tics of 1/70 s** and multiplies every movement by how many of them the
 * last frame took, so the same keys give a different game on a faster
 * machine. Here:
 *
 * - **playing**, the worker asks for a frame as often as it can and works
 *   out the tics from the wall clock, capped at ten - the game the original
 *   gave a fast 386;
 * - **a demo** and every tool run at a fixed four tics a frame
 *   (`DEMOTICS`), which is what makes a run repeatable and `match*`
 *   possible at all.
 */
export class GameWorker {

  /** the clock of the original */
  static get TICKBASE() { return 70; }
  /** how long one tic is in milliseconds */
  static get TIC_MS() { return 1000 / GameWorker.TICKBASE; }

  /**
   * @param {Function} post - Sends a message to the model (`postMessage`).
   */
  constructor(post) {
    this.post = post;
    this.assets = new WolfAssets();
    this.game = null;
    /** what goes to the model */
    this.screen = new VGAVideoRAM();
    /** what the game draws, before the fade has let it through */
    this.buffer = new VGAVideoRAM();
    /** the panels between levels and the pages of story */
    this.screens = null;
    /** 'play', 'fizzle' or 'panel' */
    this.mode = 'play';
    /** the fade in hand, or null */
    this.fade = null;
    /** what the panel after a level says */
    this.panel = null;

    this.running = false;
    this.paused = false;
    this.dirty = false;
    this.timer = null;
    this.lastTime = 0;
    this.accumulator = 0;
    /** the seed of the run, which is all the entropy the game has (R-009) */
    this.seed = 0;
    /** the level being played */
    this.levelNumber = 0;
    /** the palette as it was last sent */
    this.paletteVersion = 0;
    this.lastPalette = null;
  } // constructor

  // ---------------------------------------------------------------- messages

  /**
   * One message from the model.
   * @param {Object} msg - `{id, ...}`.
   */
  handleMessage(msg) {
    switch (msg.id) {
      case 'init':
        this.seed = msg.seed === undefined ? 0 : msg.seed >>> 0;
        break;
      case 'assets':
        this.loadAssets(msg);
        break;
      case 'level':
        this.startLevel(msg.number, msg.level, msg.difficulty, msg.demo);
        if (!msg.headless) this.start();
        break;
      case 'controls':
        this.setControl(msg.action, msg.value);
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'continue':
        this.paused = false;
        this.lastTime = 0;
        break;
      case 'reset':
        this.stop();
        this.game = null;
        break;
      case 'ack':
        // a key on the panel between levels
        this.mode = 'play';
        this.panel = null;
        break;
      case 'tick':
        // headless: exactly one frame of the tics asked for, and a frame back
        this.tick(msg.tics === undefined ? WolfGame.DEMOTICS : msg.tics);
        this.postFrame(true);
        break;
    }
  } // handleMessage

  /**
   * The data files, which arrive once. They are big - the sprites alone are
   * a megabyte - so they are sent as they came off the server and decoded
   * here, in the worker, off the main thread.
   */
  loadAssets(msg) {
    var assets = this.assets;
    if (msg.palette) assets.loadPalette(msg.palette);
    if (msg.random) assets.loadRandom(msg.random);
    if (msg.walls) assets.loadWalls(msg.walls);
    if (msg.sprites) assets.loadSprites(msg.sprites);
    if (msg.pics) assets.loadPictures(msg.pics);
    if (msg.fonts) assets.loadFonts(msg.fonts);
    if (msg.tile8) assets.loadTile8(msg.tile8);
    if (msg.texts) assets.loadTexts(msg.texts);
    if (msg.demos) assets.loadDemos(msg.demos);
    if (!this.screens) this.screens = new WolfScreens(assets);
    if (assets.ready && !this.game) this.game = new WolfGame(assets);
    if (this.game) {
      if (msg.adlib) this.game.sound.loadTable(msg.adlib);
      // only how long each digitised sound is: the samples themselves are
      // two hundred kilobytes of PCM and belong to the audio manager, not
      // to the game
      if (msg.digi) this.game.sound.loadDigi(msg.digi);
    }
    this.post({id: 'ready', ready: assets.ready});
  } // loadAssets

  /**
   * Starts a level, either to play or as one of the recorded demos.
   * @param {number} number - 0..9.
   * @param {Object} level - `data/levels/levelNN.json`.
   * @param {number} [difficulty=1] - 0 baby to 3 death incarnate.
   * @param {number} [demo] - Which recorded demo to play, if any.
   */
  startLevel(number, level, difficulty, demo) {
    if (!this.game) throw new Error('the data has not arrived yet');
    var game = this.game;
    game.newGame(difficulty === undefined ? 1 : difficulty, 0);
    game.demoplayback = false;
    game.demorecord = false;
    if (demo !== undefined && demo !== null && this.assets.demos[demo]) {
      game.startDemo(this.assets.demos[demo]);
      number = game.gamestate.mapon;
    } else {
      game.gamestate.mapon = number;
    }
    this.levelNumber = number;
    game.setupLevel(level, this.seed);
    game.sound.startMusic(game.levelSong());
    // the original comes into a level through the fizzle fade
    this.screen.fill(0);
    this.fade = WolfScreens.fizzleFade(this.screen, this.buffer, 20);
    this.mode = 'fizzle';
    this.panel = null;
    this.dirty = true;
  } // startLevel

  /** A control from the model: a button, or one of the four directions. */
  setControl(action, value) {
    if (!this.game) return;
    var game = this.game;
    var button = WolfPlayer.BUTTON;
    switch (action) {
      case 'left': game.keys.left = !!value; break;
      case 'right': game.keys.right = !!value; break;
      case 'forward': game.keys.forward = !!value; break;
      case 'back': game.keys.back = !!value; break;
      case 'fire': game.buttonsDown[button.ATTACK] = !!value; break;
      case 'strafe': game.buttonsDown[button.STRAFE] = !!value; break;
      case 'run': game.buttonsDown[button.RUN] = !!value; break;
      case 'use': game.buttonsDown[button.USE] = !!value; break;
      case 'weapon1': game.buttonsDown[button.READYKNIFE] = !!value; break;
      case 'weapon2': game.buttonsDown[button.READYPISTOL] = !!value; break;
      case 'weapon3': game.buttonsDown[button.READYMACHINEGUN] = !!value; break;
      case 'weapon4': game.buttonsDown[button.READYCHAINGUN] = !!value; break;
    }
  } // setControl

  // ------------------------------------------------------------------ frames

  /**
   * One frame of the game.
   * @param {number} tics - How many tics it is worth.
   */
  tick(tics) {
    if (!this.game || !this.game.world.doors) return;
    var game = this.game;
    if (this.mode === 'panel') return;              // the panel waits for a key
    if (game.playstate) return;

    game.playFrame(this.buffer, game.demoplayback ? WolfGame.DEMOTICS : tics);
    this.dirty = true;

    if (this.mode === 'fizzle') {
      // the level dissolves in over about twenty frames
      if (this.fade(this.screen)) {
        this.mode = 'play';
        this.fade = null;
      }
    } else {
      this.screen.restore(this.buffer.bytes);
    }

    if (game.playstate) {
      var state = this.summary();
      if (game.playstate === 'completed' || game.playstate === 'secretlevel') {
        // the panel with the time, the par and the three ratios
        this.panel = this.screens.levelCompleted(this.screen, state);
        this.mode = 'panel';
      }
      this.post({
        id: 'levelDone', reason: game.playstate, level: this.levelNumber,
        panel: this.panel, state: state
      });
    }
  } // tick

  /** What the model shows on the panels between levels. */
  summary() {
    var state = this.game.gamestate;
    return {
      mapon: state.mapon, score: state.score, lives: state.lives, health: state.health,
      ammo: state.ammo, keys: state.keys, time: state.TimeCount,
      kill: state.killcount, killtotal: state.killtotal,
      secret: state.secretcount, secrettotal: state.secrettotal,
      treasure: state.treasurecount, treasuretotal: state.treasuretotal
    };
  } // summary

  /** Sends the picture when it changed (or when asked to). */
  postFrame(always) {
    if (!this.game || (!this.dirty && !always)) return;
    this.dirty = false;
    var game = this.game;
    var palette = game.paletteBytes();
    if (palette !== this.lastPalette) {
      this.lastPalette = palette;
      this.paletteVersion++;
    }
    this.post({
      id: 'frame',
      frame: game.frame,
      level: this.levelNumber,
      vram: this.screen.bytes.slice(),
      palette: palette.slice(),
      paletteVersion: this.paletteVersion,
      sound: game.sound.takeQueue(),
      state: this.summary()
    });
  } // postFrame

  // -------------------------------------------------------------------- clock

  start() {
    if (this.running) {
      this.postFrame(true);
      return;
    }
    this.running = true;
    this.lastTime = 0;
    this.accumulator = 0;
    this.postFrame(true);
    this.loop();
  } // start

  stop() {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  } // stop

  /**
   * The loop: how many tics the wall clock owes since the last frame, then
   * one frame worth that many. A demo ignores the clock and always takes
   * four, which is what the original does when it plays one back.
   */
  loop() {
    if (!this.running) return;
    var now = GameWorker.now();
    if (this.lastTime) this.accumulator += now - this.lastTime;
    this.lastTime = now;
    if (this.paused) {
      this.accumulator = 0;
    } else {
      var tics = Math.floor(this.accumulator / GameWorker.TIC_MS);
      if (tics > 0) {
        if (tics > WolfGame.MAXTICS) {
          // the tab was asleep: do not run a minute of game in one frame
          this.accumulator = 0;
          tics = WolfGame.MAXTICS;
        } else {
          this.accumulator -= tics * GameWorker.TIC_MS;
        }
        this.tick(tics);
        this.postFrame(false);
      }
    }
    var self = this;
    this.timer = setTimeout(function () { self.loop(); }, 4);
  } // loop

  static now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  } // now

} // GameWorker

// In the worker the program wires itself up; under Node (the tools) and on
// the main thread it stays a class.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.document === 'undefined') {
  var gameWorker = new GameWorker(function (msg) { self.postMessage(msg); });
  self.onmessage = function (event) { gameWorker.handleMessage(event.data); };
}
