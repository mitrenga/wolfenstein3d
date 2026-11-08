/**
 * The two tables that live in WOLF3D.EXE rather than in a data file: the
 * palette the game programs the DAC with, and the 256 bytes of "randomness"
 * every fight in the game is decided by.
 *
 * Both are found by what is in them, not by an address - the address would
 * only hold for one build of one release, and the point of looking in the
 * program at all is that the numbers come from the game the operator has.
 *
 *   gamepal    768 six-bit components, the first sixteen of them the EGA
 *              colours the whole era started from, nothing above 63 anywhere
 *   rndtable   256 bytes starting 0, 8, 109, 220, 222, 241, 149, 107, which
 *              is how ID_US_A.ASM has it
 *
 * The program is LZEXE-packed, so it is unpacked first (lib/lzexe.mjs).
 */

import { loadImage } from './lzexe.mjs';

export const PALETTE_BYTES = 768;
export const RND_BYTES = 256;

/** The first sixteen registers of the game palette: the EGA colours in 6 bits. */
export const PALETTE_HEAD = [
  0, 0, 0, 0, 0, 42, 0, 42, 0, 0, 42, 42, 42, 0, 0, 42, 0, 42,
  42, 21, 0, 42, 42, 42, 21, 21, 21, 21, 21, 63, 21, 63, 21, 21, 63, 63,
  63, 21, 21, 63, 21, 63, 63, 63, 21, 63, 63, 63
];

/** The first eight bytes of `rndtable`. */
export const RND_HEAD = [0, 8, 109, 220, 222, 241, 149, 107];

function findAll (image, head) {
  const at = [];
  for (let i = 0; i + head.length <= image.length; i++) {
    let same = true;
    for (let k = 0; k < head.length && same; k++) same = image[i + k] === head[k];
    if (same) at.push(i);
  }
  return at;
}

/**
 * The palette, as 768 six-bit components in the order the DAC takes them.
 * @param {Uint8Array} image - The unpacked program.
 */
export function findPalette (image) {
  const candidates = findAll(image, PALETTE_HEAD).filter((at) => {
    if (at + PALETTE_BYTES > image.length) return false;
    for (let i = 0; i < PALETTE_BYTES; i++) if (image[at + i] > 63) return false;
    return true;
  });
  if (candidates.length !== 1) {
    throw new Error(`${candidates.length} places in the program look like the palette, expected one`);
  }
  return { at: candidates[0], bytes: image.slice(candidates[0], candidates[0] + PALETTE_BYTES) };
}

/**
 * `rndtable`. Two thirds of the 256 byte values turn up in it and no value
 * more than a handful of times, which is what tells a real table from a
 * piece of code that happens to start the same way.
 * @param {Uint8Array} image - The unpacked program.
 */
export function findRndTable (image) {
  const candidates = findAll(image, RND_HEAD).filter((at) => at + RND_BYTES <= image.length);
  const whole = candidates.filter((at) => {
    const seen = new Set(image.subarray(at, at + RND_BYTES));
    return seen.size >= 128;
  });
  if (whole.length !== 1) {
    throw new Error(`${whole.length} places in the program look like rndtable, expected one`);
  }
  return { at: whole[0], bytes: image.slice(whole[0], whole[0] + RND_BYTES) };
}

/** Both tables out of the program the operator has. */
export function readExeTables (exeBytes) {
  const { image, info, tokens } = loadImage(exeBytes);
  const palette = findPalette(image);
  const random = findRndTable(image);
  return {
    image,
    packed: info !== null,
    tokens,
    imageBytes: image.length,
    palette: palette.bytes,
    paletteAt: palette.at,
    rndtable: random.bytes,
    rndtableAt: random.at
  };
}
