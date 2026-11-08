const { AbstractApp } = await import('./svision/js/abstractApp.js?ver='+window.srcVersion);
const { VGAFonts8x16 } = await import('./svision/js/platform/canvas2D/vga/vgaFonts8x16.js?ver='+window.srcVersion);
const { DOSBootModel } = await import('./svision/js/platform/canvas2D/vga/dosBootModel.js?ver='+window.srcVersion);
const { VGAControls } = await import('./svision/js/platform/canvas2D/vga/vgaControls.js?ver='+window.srcVersion);
const { GameModel } = await import('./gameModel.js?ver='+window.srcVersion);
const { AudioManager } = await import('./audioManager.js?ver='+window.srcVersion);
const { Version } = await import('./version.js?ver='+window.srcVersion);
const { LEVEL_SONGS } = await import('./wolf/soundNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * The application: boots "MS-DOS", then runs the game.
 *
 * The boot is the one of the era - a memory count, a DOS prompt and
 * `WOLF3D` typed at it - and it is the library's own `DOSBootModel`
 * (R-029), so the only thing this file says about it is what the machine
 * had in it. Any key skips it.
 *
 * The menu, the story screens and the intermission of the original come
 * with W7; until then the game model starts a level straight away.
 *
 * **The data is downloaded here**, not in the game model, because it starts
 * the moment the application does - while the boot screen is still counting
 * memory. Two and a bit megabytes take about as long as the boot, so by the
 * time the game model comes up it usually finds everything in hand
 * (`loadData`).
 */
export class MainApp extends AbstractApp {

  constructor(platform, importPath, wsURL) {
    super(platform, 'bodyApp', importPath, wsURL);
    this.id = 'MainApp';
    this.version = Version;
    this.copyright = '©2026 L. Mitrenga, CC BY-NC-SA 4.0';

    this.fonts = {};
    this.fonts.vgaFonts8x16Mono = new VGAFonts8x16(this, false);

    /** the AdLib of the original: effects on one bus, music on another */
    this.audioManager = new AudioManager(this);

    /** the keyboard of the original */
    this.controlsOptions = VGAControls.controlsOptions(VGAControls.PRINCE);
    this.controls = {
      keyboard: VGAControls.defaultControls('keyboard', VGAControls.PRINCE),
      mouse: VGAControls.defaultControls('mouse', VGAControls.PRINCE),
      gamepads: VGAControls.defaultControls('gamepads', VGAControls.PRINCE),
      /** the on-screen controls come with the touch layout (W7) */
      touchscreen: {supported: false, type: false}
    };

    /** the game worker, made by the game model out of the glued modules */
    this.worker = null;
    /** which level to start on, and on which setting */
    this.levelNumber = 0;
    this.difficulty = 1;
    /** which recorded demo `D` plays next */
    this.demoNumber = 0;

    this.loadData();
    this.setModel('BootModel');
  } // constructor

  // -------------------------------------------------------------------- data

  /**
   * The data files the game needs before the first level. The list lives
   * here and not in the game model because the **download starts while the
   * machine is still booting** - there is no game model yet.
   */
  static get DATA_FILES() {
    return [
      {key: 'palette', file: 'palette'},
      {key: 'random', file: 'random'},
      {key: 'walls', file: 'gfx/walls'},
      {key: 'sprites', file: 'gfx/sprites'},
      {key: 'pics', file: 'gfx/pics'},
      {key: 'fonts', file: 'gfx/fonts'},
      {key: 'tile8', file: 'gfx/tile8'},
      {key: 'texts', file: 'texts'},
      {key: 'demos', file: 'demos'},
      {key: 'adlib', file: 'sounds/adlib'},
      {key: 'digi', file: 'sounds/digi'},
      {key: 'music', file: 'music'}
    ];
  } // DATA_FILES

  /** The small files, which are worth fetching before the big ones. */
  static get SMALL_FILES() { return ['palette', 'random', 'adlib', 'digi', 'music']; }

  /**
   * Asks for everything the game needs - **during the boot screen**.
   *
   * The original had nothing to download: it read its files off the disk in
   * the second the machine spent on the title screen. Here the same two and
   * a bit megabytes come over a line, and the boot of `DOSBootModel` is some
   * five seconds of counting memory that would otherwise be spent waiting.
   * So the whole load runs behind it - assets, the first level and the music
   * alike - and the game model, when it comes up, usually finds everything
   * already in hand.
   *
   * The order is not the order of the list:
   *
   *  - the **small files** first, because they are the palette and the tables;
   *  - then the **tune of the first level**, because rendering it takes the
   *    music worker some five seconds and those five seconds are free while
   *    the rest is still downloading;
   *  - then the megabytes of sprites and pictures;
   *  - then the **first level**, so that the game can start;
   *  - and the rest of the music last, behind everything.
   *
   * Everything goes through **one queue**, one file at a time, because the
   * library matches a reply to a request by an id it keeps on the receiver -
   * two requests in flight would tread on each other.
   */
  loadData() {
    var self = this;
    /** what has arrived, by key, ready for the worker */
    this.data = {};
    /** the levels that have been fetched, by number */
    this.levels = {};
    /** the queue, the job in hand, and who is waiting for what */
    this.dataQueue = [];
    this.dataJob = null;
    this.dataReady = false;
    this.dataWaiting = [];
    this.levelWanted = null;
    /** the library wants an object with an id to hand the answer back to */
    this.dataReceiver = {
      id: 'MainAppData',
      fetchDataId: '',
      setData: function(data) { self.dataArrived(data); },
      errorData: function(error) { self.dataFailed(error); }
    };

    // the whole plan first and **then** the pump: a file that is already in
    // local storage answers on the spot, so a queue that is pumped as it is
    // written drains each job before the next one is added and the order
    // above turns into the order the jobs happened to be thought of in
    var files = MainApp.DATA_FILES;
    var small = files.filter((file) => MainApp.SMALL_FILES.indexOf(file.key) >= 0);
    var rest = files.filter((file) => MainApp.SMALL_FILES.indexOf(file.key) < 0);
    for (var i = 0; i < small.length; i++) {
      this.dataQueue.push({kind: 'asset', key: small[i].key, file: small[i].file});
    }
    var track = LEVEL_SONGS[this.levelNumber % LEVEL_SONGS.length];
    if (track !== undefined) {
      this.dataQueue.push({kind: 'track', file: MainApp.trackFile(track)});
    }
    for (var r = 0; r < rest.length; r++) {
      this.dataQueue.push({kind: 'asset', key: rest[r].key, file: rest[r].file});
    }
    this.dataQueue.push({kind: 'level', number: this.levelNumber});
    // and the rest of the music behind the level, which is what `assetsDone`
    // queues when it comes round
    this.dataQueue.push({kind: 'assetsDone'});
    this.pumpData();
  } // loadData

  /** The file one track lives in. */
  static trackFile(index) {
    return 'music/track'+(index < 10 ? '0'+index : index);
  } // trackFile

  /**
   * Puts one file in the queue.
   * @param {Object} job - `{kind, file, ...}`; `kind` says what to do with
   *        what comes back.
   */
  queueData(job) {
    this.dataQueue.push(job);
    this.pumpData();
  } // queueData

  /** Starts the next file, if none is in flight. */
  pumpData() {
    if (this.dataJob || !this.dataQueue.length) return;
    var job = this.dataQueue.shift();
    if (job.kind === 'assetsDone') {
      this.assetsArrived();
      this.pumpData();
      return;
    }
    if (job.kind === 'level' && this.levels[job.number]) {
      this.levelArrived(job.number);
      this.pumpData();
      return;
    }
    this.dataJob = job;
    var file = job.kind === 'level'
      ? 'levels/level'+(job.number < 10 ? '0'+job.number : job.number)
      : job.file;
    this.dataReceiver.fetchDataId = this.fetchData(file+'.data',
      {key: 'wolf.'+file.replace(/\//g, '.'), when: 'required'}, {}, this.dataReceiver);
  } // pumpData

  /** A file arrived; what it is, is in the job that asked for it. */
  dataArrived(data) {
    var job = this.dataJob;
    this.dataJob = null;
    if (!job) return;
    switch (job.kind) {
      case 'asset':
        this.data[job.key] = data.data;
        break;
      case 'level':
        this.levels[job.number] = data.data;
        this.levelArrived(job.number);
        break;
      case 'track':
        this.audioManager.loadTrack(data.data);
        break;
    }
    this.pumpData();
  } // dataArrived

  /** A file did not arrive. The game cannot go on without its data. */
  dataFailed(error) {
    var job = this.dataJob;
    this.dataJob = null;
    var what = job ? (job.kind === 'level' ? 'level '+job.number : job.file) : 'data';
    if (job && job.kind === 'track') {           // the game plays without music
      this.pumpData();
      return;
    }
    this.showErrorMessage(what+': '+(error && error.message ? error.message : error), 'restart');
  } // dataFailed

  /**
   * Everything the game needs is here. The audio manager gets its sounds at
   * once - it can start rendering - and whoever waits for the data (the game
   * model, if it has come up already) is told.
   */
  assetsArrived() {
    this.dataReady = true;
    this.audioManager.loadSounds(this.data.adlib, this.data.music, this.data.digi);
    this.queueTracks(this.data.music);
    var waiting = this.dataWaiting;
    this.dataWaiting = [];
    for (var i = 0; i < waiting.length; i++) waiting[i]();
  } // assetsArrived

  /**
   * Calls back once every asset is in hand - now, if it already is.
   * @param {Function} callback
   */
  whenDataReady(callback) {
    if (this.dataReady) callback();
    else this.dataWaiting.push(callback);
  } // whenDataReady

  /**
   * The game model wants a level. If the boot fetched it, it is handed over
   * on the spot; otherwise its file jumps the queue.
   * @param {number} number - 0..9.
   * @param {number|null} demo - Play this recorded demo instead.
   * @param {Function} deliver - Called with the level's data.
   */
  wantLevel(number, demo, deliver) {
    this.levelWanted = {number: number, demo: demo === undefined ? null : demo, deliver: deliver};
    if (this.levels[number]) { this.levelArrived(number); return; }
    for (var i = 0; i < this.dataQueue.length; i++) {
      if (this.dataQueue[i].kind === 'level' && this.dataQueue[i].number === number) {
        this.dataQueue.unshift(this.dataQueue.splice(i, 1)[0]);
        this.pumpData();
        return;
      }
    }
    this.dataQueue.unshift({kind: 'level', number: number});
    this.pumpData();
  } // wantLevel

  /** A level is in hand; hand it to whoever asked for it. */
  levelArrived(number) {
    var wanted = this.levelWanted;
    if (!wanted || wanted.number !== number) return;
    this.levelWanted = null;
    wanted.deliver(this.levels[number], wanted.demo);
  } // levelArrived

  /** The rest of the music, behind everything else. */
  queueTracks(music) {
    if (!music) return;
    var tracks = music.tracks.filter((track) => track && track.present);
    for (var i = 0; i < tracks.length; i++) {
      if (this.audioManager.tracks[tracks[i].index]) continue;     // already here
      var file = tracks[i].file;
      if (this.queuedTrack(file)) continue;                        // already asked for
      this.queueData({kind: 'track', file: file});
    }
  } // queueTracks

  /** Is this track already in the queue or in flight? */
  queuedTrack(file) {
    if (this.dataJob && this.dataJob.kind === 'track' && this.dataJob.file === file) return true;
    for (var i = 0; i < this.dataQueue.length; i++) {
      if (this.dataQueue[i].kind === 'track' && this.dataQueue[i].file === file) return true;
    }
    return false;
  } // queuedTrack

  /**
   * The audio manager wants a track it has not been given yet - the tune of
   * the level that has just started. Its file jumps the queue, so that the
   * music starts as soon as one track can be fetched and rendered rather
   * than after all of them.
   * @param {number} index - The track number.
   */
  wantTrack(index) {
    var file = MainApp.trackFile(index);
    for (var i = 0; i < this.dataQueue.length; i++) {
      if (this.dataQueue[i].kind === 'track' && this.dataQueue[i].file === file) {
        if (i > 0) this.dataQueue.unshift(this.dataQueue.splice(i, 1)[0]);
        this.pumpData();
        return;
      }
    }
    if (!this.dataJob || this.dataJob.file !== file) {
      this.dataQueue.unshift({kind: 'track', file: file});
      this.pumpData();
    }
  } // wantTrack

  // ------------------------------------------------------------------ models

  /**
   * Switches models: shuts the current one down, makes the next, and lays
   * it out.
   * @param {string} model - 'BootModel' or 'GameModel'.
   */
  setModel(model) {
    var needResizeApp = false;
    if (this.model) {
      this.model.shutdown();
      needResizeApp = true;
    }
    switch (model) {
      case 'BootModel':
        this.model = new DOSBootModel(this, {
          nextModel: 'GameModel',
          skipKeys: 'any',
          memoryKB: 640,
          extendedKB: 3072,
          dos: {
            commands: [
              {command: 'CD WOLF3D', prompt: 'C:\\WOLF3D>'},
              {command: 'WOLF3D'}
            ]
          }
        });
        break;
      case 'GameModel':
        this.model = new GameModel(this);
        break;
    }
    this.model.init();
    if (needResizeApp) this.resizeApp();
  } // setModel

} // MainApp
