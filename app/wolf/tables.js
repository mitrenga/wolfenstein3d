const { WolfFixed } = await import('./fixed.js?ver='+window.srcVersion);
// begin code

/**
 * The tables the whole engine reads: the sines, the tangents, the angle of
 * every column of the view, and the numbers the projection is scaled by.
 *
 * This is the only floating point in the game, and it is here for the same
 * reason it is in the original: the tables are built once, at the start,
 * with `sin`, `tan` and `atan`, and from then on nothing but integers is
 * touched. What matters for `match*` is that the **rounding is the
 * original's**, so three details are kept that a fresh implementation would
 * get wrong:
 *
 * - **PI is 3.141592657**, the value `WL_DEF.H` spells out, not the one the
 *   library has. Every angle in the tables comes out of it.
 * - **`radtoint` is a 32 bit float** (`const float radtoint`), so the
 *   division that makes an angle out of a table index is done at single
 *   precision. `Math.fround` puts that back.
 * - **the angle of `sintable` accumulates in a 32 bit float** - the original
 *   adds `anglestep` 900 times to a `float`, and the error that builds up is
 *   part of the table.
 *
 * Nothing is rounded to nearest anywhere: a `long` takes what `double`
 * arithmetic gives it, towards zero.
 *
 * `sintable` is signed magnitude (bit 31 is the sign) because the multiply
 * routine wants it that way - see {@link WolfFixed}.
 */
export class WolfTables {

  /** the tables are the same for every view size */
  constructor() {
    this.id = 'WolfTables';

    var fine = WolfFixed.FINEANGLES;
    var quad = WolfFixed.ANGLEQUAD;
    var angles = WolfFixed.ANGLES;
    /** radians to fine angle steps, at the precision the original has it */
    this.radToInt = Math.fround(fine / 2 / WolfFixed.PI);

    /** tan of every fine angle of the first quadrant, times 65536 */
    this.finetangent = new Int32Array(fine / 4);
    for (var i = 0; i < fine / 8; i++) {
      var tang = Math.tan((i + 0.5) / this.radToInt);
      this.finetangent[i] = Math.trunc(tang * WolfFixed.TILEGLOBAL);
      this.finetangent[fine / 4 - 1 - i] = Math.trunc((1 / tang) * WolfFixed.TILEGLOBAL);
    }

    /** sin of every whole degree, signed magnitude, 450 entries */
    this.sintable = new Int32Array(angles + angles / 4);
    var angle = 0;
    var anglestep = Math.fround(WolfFixed.PI / 2 / quad);
    for (var step = 0; step <= quad; step++) {
      var value = Math.trunc(WolfFixed.TILEGLOBAL * Math.sin(angle));
      this.sintable[step] = value;
      this.sintable[step + angles] = value;
      this.sintable[angles / 2 - step] = value;
      this.sintable[angles - step] = value | 0x80000000;
      this.sintable[angles / 2 + step] = value | 0x80000000;
      angle = Math.fround(angle + anglestep);
    }

    /** the projection, filled in by {@link WolfTables#calcProjection} */
    this.viewWidth = 0;
    this.viewHeight = 0;
    this.centerX = 0;
    this.focalLength = 0;
    this.scale = 0;
    this.heightNumerator = 0;
    this.minHeightDiv = 0;
    this.maxSlope = 0;
    this.pixelangle = new Int16Array(WolfFixed.ANGLES * 0 + 320);
    /** the tallest a wall may be drawn - `SetupScaling (viewwidth*1.5)` */
    this.maxScale = 0;
    /** one entry per scale height: which texture row lands on which line */
    this.scalers = [];
  } // constructor

  /**
   * `costable` is `sintable` shifted a quarter turn; the original simply
   * points into the same array.
   * @param {number} angle - 0..359.
   * @returns {number} Signed magnitude cosine.
   */
  cos(angle) {
    return this.sintable[angle + WolfFixed.ANGLES / 4];
  } // cos

  /**
   * @param {number} angle - 0..359.
   * @returns {number} Signed magnitude sine.
   */
  sin(angle) {
    return this.sintable[angle];
  } // sin

  /**
   * `CalcProjection` and `SetupScaling`: everything that depends on how big
   * the view window is. The full view of the original is 320 x 160 - the
   * screen without the 40 line status bar.
   *
   * @param {number} viewWidth - Columns of the view, 320 at most.
   * @param {number} viewHeight - Lines of the view.
   * @param {number} [focal=FOCALLENGTH] - How far in front of the player
   *        the projection plane sits.
   */
  calcProjection(viewWidth, viewHeight, focal) {
    var focalLength = focal === undefined ? WolfFixed.FOCALLENGTH : focal;
    var faceDist = focalLength + WolfFixed.MINDIST;
    var halfView = Math.floor(viewWidth / 2);

    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
    this.centerX = halfView - 1;
    this.focalLength = focalLength;
    this.scale = Math.trunc((halfView * faceDist) / (WolfFixed.VIEWGLOBAL / 2));
    this.heightNumerator = (WolfFixed.TILEGLOBAL * this.scale) >> 6;
    this.minHeightDiv = Math.trunc(this.heightNumerator / 0x7fff) + 1;

    this.pixelangle = new Int16Array(viewWidth);
    for (var i = 0; i < halfView; i++) {
      // the whole division by the view width is an integer one, and only
      // then does the distance come in - the original writes it
      // `(long)i*VIEWGLOBAL/viewwidth/facedist`
      var tang = Math.floor((i * WolfFixed.VIEWGLOBAL) / viewWidth) / faceDist;
      var intang = Math.trunc(Math.fround(Math.atan(tang)) * this.radToInt);
      this.pixelangle[halfView - 1 - i] = intang;
      this.pixelangle[halfView + i] = -intang;
    }
    this.maxSlope = this.finetangent[this.pixelangle[0]] >> 8;

    this.setupScaling(Math.trunc(viewWidth * 1.5));
  } // calcProjection

  /**
   * `SetupScaling` and `BuildCompScale`: for every height a wall or a
   * sprite can be drawn at, which of the 64 texture rows lands on which
   * line of the view.
   *
   * The original compiles a little program per height; here the same thing
   * is a pair of arrays - `first[src]` where texture row `src` starts on
   * the screen and `width[src]` how many lines it covers, before clipping.
   * `width` is what the sprite drawer reads to know how wide a column of
   * the shape is, so it has to be the same table.
   *
   * @param {number} maxScaleHeight - `viewwidth*1.5` in the original.
   */
  setupScaling(maxScaleHeight) {
    var half = Math.floor(maxScaleHeight / 2);   // one scaler every two pixels
    this.maxScale = half - 1;
    this.scalers = new Array(half + 1);
    for (var i = 1; i <= half; i++) this.scalers[i] = this.buildCompScale(i * 2);
    this.scalers[0] = this.scalers[1];
  } // setupScaling

  /**
   * One scaler: a 64 tall picture squeezed into `height` lines, centred on
   * the view.
   * @param {number} height - An even number of lines.
   * @returns {{height: number, top: number, first: Int16Array, width: Uint8Array}}
   */
  buildCompScale(height) {
    var step = Math.floor((height * 65536) / 64);
    var top = Math.floor((this.viewHeight - height) / 2);
    var first = new Int16Array(65);
    var width = new Uint8Array(65);
    var fix = 0;
    for (var src = 0; src <= 64; src++) {
      var startPix = fix >> 16;
      fix += step;
      var endPix = fix >> 16;
      first[src] = startPix + top;
      width[src] = endPix > startPix ? endPix - startPix : 0;
    }
    return { height: height, top: top, first: first, width: width };
  } // buildCompScale

  /**
   * The scaler a wall of this height uses. The low three bits of a wall
   * height are fractional, so the height in lines is twice `height>>3`.
   * @param {number} height - `wallheight[]`, or an actor's `viewheight`.
   * @returns {Object|null} The scaler, or null when the thing is too close
   *          or too far to draw.
   */
  scalerOf(height) {
    var scale = height >> 3;
    if (!scale || scale > this.maxScale) return null;
    return this.scalers[scale];
  } // scalerOf

} // WolfTables
