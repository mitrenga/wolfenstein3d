const { WolfWorld } = await import('./world.js?ver='+window.srcVersion);
// begin code

/**
 * Everything the game draws with, once it has been fetched: the palette,
 * the wall textures, the sprites, the pictures and fonts of VGAGRAPH, the
 * texts, and the tables of the sounds.
 *
 * The files are what `tools/mkdata.mjs` wrote into `data/` - JSON with the
 * pixels in it as base64. Two of them are turned round on the way in:
 *
 * - **wall textures are kept by column.** VSWAP holds them that way because
 *   that is the order the rasteriser wants - one column of a wall is one
 *   run of 64 bytes. `data/gfx/walls.json` holds them by row, which is what
 *   a picture is, so that a PNG of them can be looked at; here they go back
 *   to columns once, at load time.
 * - **sprites keep their rows**, because the sprite drawer walks a column
 *   of the shape and asks for a pixel of a row inside it, and `0xFF` means
 *   see-through.
 *
 * Nothing here decides anything about the game; it is the wardrobe, not the
 * play.
 */
export class WolfAssets {

  static get TEXTURE_SIZE() { return 64; }
  static get TRANSPARENT() { return 0xff; }

  constructor() {
    this.id = 'WolfAssets';
    /** 768 six-bit components, as the game programs the DAC */
    this.palette = null;
    /** `rndtable`, 256 bytes */
    this.rndtable = null;
    /** wall textures by column, 4096 bytes each, or null where absent */
    this.walls = [];
    /** sprites by row, 4096 bytes each */
    this.sprites = [];
    /** the first and last column a sprite has anything in */
    this.spriteBounds = [];
    /** pictures of VGAGRAPH by number and by name */
    this.pictures = [];
    this.pictureByName = {};
    /** the two fonts */
    this.fonts = [];
    /** the 8 x 8 tiles the panels are framed with */
    this.tile8 = [];
    /** the story and help pages, by name */
    this.texts = {};
    /** the two screens the game prints in text mode */
    this.textScreens = {};
    /** the sound tables; the samples themselves stay in the audio manager */
    this.sounds = { adlib: [], speaker: [], digi: [], music: [] };
    /** the recorded demos */
    this.demos = [];
  } // constructor

  /** Base64 into bytes, in a worker, in a page or under Node. */
  static decode(text) {
    return WolfWorld.decodeBase64(text);
  } // decode

  // ------------------------------------------------------------- the files

  /**
   * @param {Object} data - `data/palette.json`.
   */
  loadPalette(data) {
    this.palette = WolfAssets.decode(data.bytes);
    return this;
  } // loadPalette

  /**
   * @param {Object} data - `data/random.json`.
   */
  loadRandom(data) {
    this.rndtable = WolfAssets.decode(data.bytes);
    return this;
  } // loadRandom

  /**
   * The wall textures, turned back into the column order the ray caster
   * reads them in.
   * @param {Object} data - `data/gfx/walls.json`.
   */
  loadWalls(data) {
    var size = WolfAssets.TEXTURE_SIZE;
    this.walls = data.textures.map((encoded) => {
      if (!encoded) return null;
      var rows = WolfAssets.decode(encoded);
      var columns = new Uint8Array(size * size);
      for (var x = 0; x < size; x++) {
        for (var y = 0; y < size; y++) columns[x * size + y] = rows[y * size + x];
      }
      return columns;
    });
    return this;
  } // loadWalls

  /**
   * The sprites, and for each of them the first and last column that has
   * anything in it - the `leftpix` and `rightpix` the original stores in
   * the shape and the drawer walks between.
   * @param {Object} data - `data/gfx/sprites.json`.
   */
  loadSprites(data) {
    var size = WolfAssets.TEXTURE_SIZE;
    var clear = WolfAssets.TRANSPARENT;
    this.sprites = data.sprites.map((encoded) => (encoded ? WolfAssets.decode(encoded) : null));
    this.spriteBounds = this.sprites.map((pixels) => {
      if (!pixels) return null;
      var first = -1;
      var last = 0;
      for (var x = 0; x < size; x++) {
        var any = false;
        for (var y = 0; y < size && !any; y++) any = pixels[y * size + x] !== clear;
        if (any) {
          if (first < 0) first = x;
          last = x;
        }
      }
      return first < 0 ? { left: 0, right: 0 } : { left: first, right: last };
    });
    return this;
  } // loadSprites

  /**
   * @param {Object} data - `data/gfx/pics.json`.
   */
  loadPictures(data) {
    this.pictures = data.pictures.map((picture) => {
      if (!picture) return null;
      var made = {
        index: picture.index, chunk: picture.chunk, name: picture.name,
        width: picture.width, height: picture.height, pixels: WolfAssets.decode(picture.pixels)
      };
      if (picture.name) this.pictureByName[picture.name] = made;
      return made;
    });
    return this;
  } // loadPictures

  /**
   * @param {Object} data - `data/gfx/fonts.json`.
   */
  loadFonts(data) {
    this.fonts = data.fonts.map((font) => ({
      height: font.height,
      glyphs: font.glyphs.map((glyph) => (glyph
        ? { code: glyph.code, width: glyph.width, pixels: WolfAssets.decode(glyph.pixels) }
        : null))
    }));
    return this;
  } // loadFonts

  /**
   * @param {Object} data - `data/gfx/tile8.json`.
   */
  loadTile8(data) {
    this.tile8 = data.tiles.map((tile) => WolfAssets.decode(tile));
    return this;
  } // loadTile8

  /**
   * @param {Object} data - `data/texts.json`.
   */
  loadTexts(data) {
    for (var i = 0; i < data.texts.length; i++) {
      this.texts[data.texts[i].name || ('CHUNK' + data.texts[i].chunk)] = data.texts[i].text;
    }
    for (var s = 0; s < (data.textScreens || []).length; s++) {
      var screen = data.textScreens[s];
      this.textScreens[screen.name || ('CHUNK' + screen.chunk)] = WolfAssets.decode(screen.cells);
    }
    return this;
  } // loadTexts

  /**
   * @param {Object} data - `data/demos.json`.
   */
  loadDemos(data) {
    this.demos = data.demos.map((demo) => ({
      number: demo.number, name: demo.name, level: demo.level,
      record: WolfAssets.decode(demo.record)
    }));
    return this;
  } // loadDemos

  // ------------------------------------------------------------ the pixels

  /**
   * One column of a wall texture.
   * @param {number} page - Which texture; the ray caster works these out of
   *        `horizwall`/`vertwall` and the door pages.
   * @param {number} column - 0..63.
   * @returns {Uint8Array|null} 64 bytes, top to bottom.
   */
  wallColumn(page, column) {
    var wall = this.walls[page];
    if (!wall) return null;
    return wall.subarray(column * 64, column * 64 + 64);
  } // wallColumn

  /**
   * One sprite, row by row, `0xFF` where it is see-through.
   * @param {number} number - The sprite number ({@link SPRITE}).
   * @returns {Uint8Array|null}
   */
  sprite(number) {
    return this.sprites[number] || null;
  } // sprite

  /** The first column a sprite has anything in (`leftpix`). */
  spriteLeft(number) {
    var bounds = this.spriteBounds[number];
    return bounds ? bounds.left : 0;
  } // spriteLeft

  /** The last one (`rightpix`). */
  spriteRight(number) {
    var bounds = this.spriteBounds[number];
    return bounds ? bounds.right : 63;
  } // spriteRight

  /**
   * A picture of VGAGRAPH by the name the game gives it, such as
   * `STATUSBARPIC` or `H_BJPIC`.
   * @param {string} name
   * @returns {Object|null} `{width, height, pixels}`.
   */
  picture(name) {
    return this.pictureByName[name] || null;
  } // picture

  /** Whether everything a level needs has arrived. */
  get ready() {
    return !!(this.palette && this.rndtable && this.walls.length && this.sprites.length);
  } // ready

} // WolfAssets
