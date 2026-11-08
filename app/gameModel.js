const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { VGAVideoRAMEntity } = await import('./svision/js/platform/canvas2D/vga/vgaVideoRAMEntity.js?ver='+window.srcVersion);
const { VGAControls } = await import('./svision/js/platform/canvas2D/vga/vgaControls.js?ver='+window.srcVersion);
const { ModuleWorker } = await import('./svision/js/moduleWorker.js?ver='+window.srcVersion);
// begin code

/**
 * The game screen: the 320 x 200 the worker draws, shown as a
 * {@link VGAVideoRAMEntity}, and the keyboard on its way back.
 *
 * The game itself runs in `gameWorker.js` at the original's seventy tics a
 * second and sends its whole video memory whenever the picture changed
 * (`app/WORKER-PROTOCOL.md`); this model shows the last frame, hands the
 * worker the controls, fetches what a level needs, and passes what the
 * worker asks to be heard to the {@link AudioManager}.
 *
 * `1` to `4` pick a weapon, the cursor keys walk, `Alt` strafes, `Shift`
 * runs, `Ctrl` fires and space opens. `+` and `-` change the level and `D`
 * plays one of the four recorded demos - debugging conveniences until the
 * menu of the original arrives with W7.
 */
export class GameModel extends AbstractModel {

  /** the modules the worker is glued from, in dependency order */
  static get WORKER_SOURCES() {
    return [
      'svision/js/platform/canvas2D/vga/vgaVideoRAM.js',
      'svision/js/platform/canvas2D/vga/vgaPalette.js',
      'svision/js/audio/chip/opl2.js',
      'wolf/fixed.js',
      'wolf/spriteNumbers.js',
      'wolf/soundNumbers.js',
      'wolf/soundTables.js',
      'wolf/digiMap.js',
      'wolf/stateTable.js',
      'wolf/tables.js',
      'wolf/random.js',
      'wolf/world.js',
      'wolf/assets.js',
      'wolf/player.js',
      'wolf/actors.js',
      'wolf/render.js',
      'wolf/hud.js',
      'wolf/sound.js',
      'wolf/screens.js',
      'wolf/game.js',
      'gameWorker.js'
    ];
  } // WORKER_SOURCES

  constructor(app) {
    super(app);
    this.id = 'GameModel';
    this.autorepeatKeys = false;

    this.screen = null;
    this.paletteVersion = -1;
    /** the worker is up and will take messages */
    this.ready = false;
    this.paused = false;
  } // constructor

  init() {
    super.init();
    if (this.borderEntity != null) this.borderEntity.bkColor = '#000000';
    this.desktopEntity.bkColor = '#000000';

    this.screen = new VGAVideoRAMEntity(this.desktopEntity, 0, 0);
    this.screen.clear(0);
    this.desktopEntity.addEntity(this.screen);

    // three buses, as the card had three jobs: the FM effects on voice 0,
    // the music on voices 1 to 8 and the digitised sounds on the DAC. On one
    // bus every shot cut the music dead
    this.sendEvent(0, {id: 'openAudioBus', bus: 'sounds', options: {muted: false}});
    this.sendEvent(0, {id: 'openAudioBus', bus: 'music', options: {muted: false}});
    this.sendEvent(0, {id: 'openAudioBus', bus: 'digi', options: {muted: false}});
    this.app.audioManager.model = this;
    this.startWorker();
  } // init

  shutdown() {
    this.sendWorkerMessage({id: 'reset'});
    super.shutdown();
  } // shutdown

  // ------------------------------------------------------------------ worker

  startWorker() {
    if (this.app.worker) {
      this.app.worker.onmessage = (event) => this.handleWorkerMessage(event);
      this.ready = true;
      this.loadLevel(this.app.levelNumber);
      return;
    }
    ModuleWorker.create(this.app, GameModel.WORKER_SOURCES).then((worker) => {
      this.app.worker = worker;
      worker.onmessage = (event) => this.handleWorkerMessage(event);
      worker.onerror = (event) => this.app.showErrorMessage('game worker: '+event.message, 'restart');
      this.ready = true;
      this.sendWorkerMessage({id: 'init', seed: Date.now() >>> 0});
      this.app.whenDataReady(() => this.dataReady());
    }).catch((error) => this.app.showErrorMessage(error.message, 'restart'));
  } // startWorker

  sendWorkerMessage(event) {
    if (this.app.worker && this.ready) this.app.worker.postMessage(event);
  } // sendWorkerMessage

  handleWorkerMessage(event) {
    var data = event.data;
    switch (data.id) {
      case 'frame':
        if (data.paletteVersion !== this.paletteVersion) {
          this.paletteVersion = data.paletteVersion;
          this.screen.palette.load(data.palette);
        }
        this.screen.restore(data.vram);
        if (data.sound && data.sound.length) this.app.audioManager.playFrame(data.sound, this);
        break;
      case 'ready':
        break;
      case 'levelDone':
        this.levelDone(data);
        break;
    }
  } // handleWorkerMessage

  /**
   * A level ended. After one that was finished the worker draws the panel
   * with the time and the ratios and holds it there; a key moves on. After
   * a death the same level starts again, which is what the original does
   * once the dying is over.
   * @param {Object} data - The `levelDone` message.
   */
  levelDone(data) {
    this.panelUp = data.reason === 'completed' || data.reason === 'secretlevel';
    this.nextLevel = data.reason === 'died'
      ? this.app.levelNumber
      : (data.reason === 'secretlevel' ? 9 : Math.min(9, this.app.levelNumber+1));
    if (!this.panelUp) this.startNextLevel();
  } // levelDone

  /** Off the panel and into the next level. */
  startNextLevel() {
    this.panelUp = false;
    this.sendWorkerMessage({id: 'ack'});
    this.app.levelNumber = this.nextLevel;
    this.loadLevel(this.app.levelNumber);
  } // startNextLevel

  // -------------------------------------------------------------------- data

  /**
   * The files are **not fetched here**. They are downloaded by the
   * application while the machine boots (`MainApp.loadData`), so all this
   * model does is take what is there: the assets go to the worker in one
   * message and the level follows.
   *
   * Should the game model somehow come up first, `whenDataReady` waits.
   */
  dataReady() {
    var data = this.app.data;
    this.sendWorkerMessage({
      id: 'assets',
      palette: data.palette, random: data.random,
      walls: data.walls, sprites: data.sprites,
      pics: data.pics, fonts: data.fonts, tile8: data.tile8,
      texts: data.texts, demos: data.demos, adlib: data.adlib,
      digi: GameModel.digiLengths(data.digi)
    });
    this.loadLevel(this.app.levelNumber);
  } // dataReady

  /**
   * How long each digitised sound is - and nothing else. The worker decides
   * whether a sound plays as a recording and for how long it holds the DAC
   * (`WolfSound.loadDigi`); the samples themselves are two hundred
   * kilobytes of PCM and stay with the audio manager.
   * @param {Object} [digi] - `data/sounds/digi.json`.
   * @returns {Object|null} `{rate, seconds: []}`.
   */
  static digiLengths(digi) {
    if (!digi || !digi.sounds) return null;
    return {rate: digi.rate, seconds: digi.sounds.map((sound) => (sound ? sound.seconds : 0))};
  } // digiLengths

  /**
   * Asks the application for a level and tells the worker to play it.
   * @param {number} number - 0..9.
   * @param {number} [demo] - Play this recorded demo instead.
   */
  loadLevel(number, demo) {
    this.app.wantLevel(number, demo, (level, playDemo) => {
      this.sendWorkerMessage({
        id: 'level', number: number, level: level,
        difficulty: this.app.difficulty, demo: playDemo
      });
    });
  } // loadLevel

  // ------------------------------------------------------------------ events

  handleEvent(event) {
    if (super.handleEvent(event)) return true;
    switch (event.id) {
      case 'keyPress':
        if (this.paused) {
          this.paused = false;
          this.sendWorkerMessage({id: 'continue'});
          this.sendEvent(0, {id: 'continueAllAudioBuses'});
        }
        return this.keyChanged(event.key, true);
      case 'keyRelease':
        return this.keyChanged(event.key, false);
      case 'blurWindow':
        this.paused = true;
        this.sendWorkerMessage({id: 'pause'});
        this.sendEvent(0, {id: 'pauseAllAudioBuses'});
        return true;
    }
    return false;
  } // handleEvent

  /** The keys of the original, and a few of our own for debugging. */
  keyChanged(key, value) {
    if (this.panelUp) {
      // any key takes the panel between levels away
      if (value) this.startNextLevel();
      return true;
    }
    var action = GameModel.ACTION_OF[key];
    if (action) {
      this.sendWorkerMessage({id: 'controls', action: action, value: value});
      return true;
    }
    if (!value) return false;
    switch (key) {
      case '+':
        this.app.levelNumber = Math.min(9, this.app.levelNumber+1);
        this.loadLevel(this.app.levelNumber);
        return true;
      case '-':
        this.app.levelNumber = Math.max(0, this.app.levelNumber-1);
        this.loadLevel(this.app.levelNumber);
        return true;
      case 'd':
      case 'D':
        this.app.demoNumber = ((this.app.demoNumber || 0)+1) % 4;
        this.loadLevel(0, this.app.demoNumber);
        return true;
      case 'b':
      case 'B':
        this.app.setModel('BootModel');
        return true;
    }
    return false;
  } // keyChanged

  /** Which key does what, in the shape the worker wants it. */
  static get ACTION_OF() {
    return {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'forward', ArrowDown: 'back',
      Control: 'fire', Alt: 'strafe', Shift: 'run', ' ': 'use',
      '1': 'weapon1', '2': 'weapon2', '3': 'weapon3', '4': 'weapon4'
    };
  } // ACTION_OF

  loopModel(timestamp) {
    super.loopModel(timestamp);
    this.drawModel();
  } // loopModel

} // GameModel
