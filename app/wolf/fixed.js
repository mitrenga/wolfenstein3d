// begin code

/**
 * The arithmetic Wolfenstein is built on: 16.16 fixed point, and the two
 * multiplications the original does in assembly.
 *
 * Everything in the simulation - where the player is, where a ray crosses a
 * wall, how tall a wall is on the screen - is an integer here, exactly as it
 * is on a 286. A `Math.sin` or a floating point coordinate anywhere in the
 * game logic would let a demo drift after a few hundred tics and make
 * `match*` meaningless (`ZADANI.md` para 2), so there are none: the only
 * floating point in the whole remake is in {@link WolfTables}, which builds
 * the tables once at the start, the same way the original builds them.
 *
 * ## Signed magnitude, not two's complement
 *
 * The one thing that surprises a reader: `sintable` does not hold negative
 * numbers. A value is a magnitude with **bit 31 as the sign**, because the
 * multiply routine of the original is written for that shape - it takes the
 * sign off, multiplies unsigned, and puts the sign back. Rounding therefore
 * goes **towards zero for both signs**, which is not what `(a*b)>>16` does
 * in two's complement, and the difference is a whole unit on half the
 * multiplications. That is why this is a routine of its own instead of a
 * shift.
 */
export class WolfFixed {

  /** one tile in global coordinates, and the shift that gets there */
  static get TILEGLOBAL() { return 1 << 16; }
  static get TILESHIFT() { return 16; }
  /** one pixel of a 64 x 64 texture */
  static get PIXGLOBAL() { return (1 << 16) / 64; }
  /** the player's radius: how close to a wall the middle of him may come */
  static get MINDIST() { return 0x5800; }
  /** the closest two actors' centres may come */
  static get MINACTORDIST() { return 0x10000; }
  /** the map is 64 x 64 tiles, always */
  static get MAPSIZE() { return 64; }
  /** the circle in whole degrees and in the fine steps the tables have */
  static get ANGLES() { return 360; }
  static get ANGLEQUAD() { return 90; }
  static get FINEANGLES() { return 3600; }
  static get ANG90() { return 900; }
  static get ANG180() { return 1800; }
  static get ANG270() { return 2700; }
  static get ANG360() { return 3600; }
  /** the value of PI the original computes its tables with (WL_DEF.H) */
  static get PI() { return 3.141592657; }
  /** how far in front of the player the projection plane sits */
  static get FOCALLENGTH() { return 0x5700; }
  /** one tile wide at the projection plane */
  static get VIEWGLOBAL() { return 0x10000; }

  /**
   * `FixedByFrac`: a 16.16 number times a fraction held in signed magnitude
   * (bit 31 the sign, the low word the fraction). This is how the original
   * turns a distance into its component along the view direction.
   * @param {number} a - A 16.16 number, negative in the usual way.
   * @param {number} b - Signed magnitude: bit 31 sign, bits 0-15 fraction.
   * @returns {number} a * fraction(b), rounded towards zero.
   */
  static byFrac(a, b) {
    var negative = (b & 0x80000000) !== 0;
    var value = a;
    if (value < 0) {
      value = -value;
      negative = !negative;
    }
    // (|a| * fraction) >> 16 with no rounding, the way the multiply of the
    // original accumulates the two halves of the product
    var result = Math.floor((value * (b & 0xffff)) / 65536);
    return negative ? -result : result;
  } // byFrac

  /**
   * `xpartialbyystep`: a signed 16.16 step times an unsigned 16 bit
   * fraction of a tile. Same shape as {@link WolfFixed.byFrac}, but the
   * sign is the step's own.
   * @param {number} step - A 16.16 step, may be negative.
   * @param {number} partial - 0..65535, how much of the tile is left.
   * @returns {number} step * partial / 65536, rounded towards zero.
   */
  static byPartial(step, partial) {
    var negative = step < 0;
    var value = negative ? -step : step;
    var result = Math.floor((value * (partial & 0xffff)) / 65536);
    return negative ? -result : result;
  } // byPartial

  /**
   * What a 16 bit signed register would hold.
   * @param {number} value
   * @returns {number} -32768..32767.
   */
  static int16(value) {
    return (value << 16) >> 16;
  } // int16

  /**
   * What a 16 bit unsigned register would hold - the game reads the low
   * word of a coordinate as "how far into the tile" all over the place.
   * @param {number} value
   * @returns {number} 0..65535.
   */
  static word(value) {
    return value & 0xffff;
  } // word

  /** The tile a global coordinate is in. */
  static tileOf(value) {
    return value >> 16;
  } // tileOf

} // WolfFixed
