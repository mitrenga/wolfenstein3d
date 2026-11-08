// begin code

/**
 * The randomness of Wolfenstein: a table of 256 bytes and an index into it.
 *
 * There is no generator anywhere in the game. `US_RndT` steps the index on
 * by one, wraps it at 256 and hands back the byte it lands on; every shot
 * that misses, every guard that takes a step and every face BJ pulls comes
 * out of that one walk through the table. `US_InitRndT(false)` puts the
 * index back to zero - which is what a demo does, and why a demo plays the
 * same fight every time - and `US_InitRndT(true)` starts it from the clock.
 *
 * This is R-009 met without a generator of our own: the table is the
 * original's 256 bytes, read out of WOLF3D.EXE by `tools/mkdata.mjs`, and
 * the only entropy in the game is the index it starts at. Nothing here ever
 * calls `Math.random` - the seed comes in from outside, so a tool can put
 * the same one back and replay the same game.
 */
export class WolfRandom {

  static get SIZE() { return 256; }

  /**
   * @param {Uint8Array|number[]} table - The 256 bytes of `rndtable`.
   */
  constructor(table) {
    this.id = 'WolfRandom';
    if (!table || table.length !== WolfRandom.SIZE) {
      throw new Error('rndtable must be 256 bytes, the ones out of the game');
    }
    /** the table itself, never written to */
    this.table = Uint8Array.from(table);
    /** where in it the game is now */
    this.index = 0;
  } // constructor

  /**
   * `US_InitRndT`.
   * @param {boolean} randomize - False puts the index at zero (demos and
   *        the tools); true starts it from the seed.
   * @param {number} [seed=0] - Stands in for the clock the original reads;
   *        only its low byte matters.
   */
  init(randomize, seed) {
    this.index = randomize ? (seed === undefined ? 0 : seed) & 0xff : 0;
  } // init

  /**
   * `US_RndT`: the next byte of the table.
   * @returns {number} 0..255.
   */
  next() {
    this.index = (this.index + 1) & 0xff;
    return this.table[this.index];
  } // next

  /** The state a tool compares, and what a saved game keeps. */
  snapshot() {
    return { index: this.index };
  } // snapshot

  /** Puts a snapshot back. */
  restore(state) {
    this.index = state.index & 0xff;
  } // restore

} // WolfRandom
