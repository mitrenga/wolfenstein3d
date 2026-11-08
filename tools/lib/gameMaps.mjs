/**
 * MAPHEAD / GAMEMAPS - the levels, as TED5 wrote them.
 *
 * MAPHEAD is the RLEW tag and 100 offsets into GAMEMAPS, one per level slot;
 * a slot that is zero or negative holds no level. The shareware v1.4 files
 * fill ten of them - episode one, nine levels and the secret one.
 *
 * GAMEMAPS opens with the string "TED5v1.0" and then holds, in no particular
 * order, a 38 byte header per level and the compressed planes it points at.
 * Wolfenstein writes "!ID!" after the name, which makes the header 42 bytes
 * on disk, but the four bytes are not part of it.
 *
 * The planes of v1.4 are carmackized RLEW: Carmack first, then RLEW, and the
 * game ignores the width and height in the header and assumes 64 x 64.
 */

import { expandRLEW, compressRLEW } from './rlew.mjs';
import { expandCarmack, compressCarmack } from './carmack.mjs';

export const LEVEL_SLOTS = 100;
export const MAPSIZE = 64;                        // WL_DEF.H: the game assumes it
export const PLANE_BYTES = MAPSIZE * MAPSIZE * 2;
export const HEADER_SIZE = 38;
export const SIGNATURE = 'TED5v1.0';
export const PLANES = 3;

const text = (bytes) => {
  const end = bytes.indexOf(0);
  return new TextDecoder('latin1').decode(end === -1 ? bytes : bytes.subarray(0, end));
};

/** The tag and the level offsets. */
export function parseMapHead (bytes) {
  if (bytes.length < 2 + LEVEL_SLOTS * 4) throw new Error(`MAPHEAD is ${bytes.length} bytes, expected at least 402`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets = [];
  for (let i = 0; i < LEVEL_SLOTS; i++) offsets.push(view.getInt32(2 + i * 4, true));
  return {
    tag: view.getUint16(0, true),
    offsets,
    used: offsets.map((offset, index) => ({ offset, index })).filter(({ offset }) => offset > 0),
    tileInfo: bytes.subarray(2 + LEVEL_SLOTS * 4)
  };
}

/** One level header out of GAMEMAPS, at the offset MAPHEAD points to. */
export function parseLevelHeader (bytes, at) {
  if (at + HEADER_SIZE > bytes.length) throw new Error(`level header at ${at} runs past the end of GAMEMAPS`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const planeOffsets = [];
  const planeLengths = [];
  for (let i = 0; i < PLANES; i++) planeOffsets.push(view.getInt32(at + i * 4, true));
  for (let i = 0; i < PLANES; i++) planeLengths.push(view.getUint16(at + 12 + i * 2, true));
  return {
    at,
    planeOffsets,
    planeLengths,
    width: view.getUint16(at + 18, true),
    height: view.getUint16(at + 20, true),
    name: text(bytes.subarray(at + 22, at + 38)),
    // Not part of the header, but it tells v1.1 and later from v1.0.
    signature: text(bytes.subarray(at + 38, at + 42))
  };
}

/**
 * One plane: Carmack off, then RLEW off. The expanded size is taken as
 * 64 * 64 * 2 the way the game takes it, not from the size word of the RLEW
 * stream - `checkPlaneSizes` in checkdat compares the two.
 */
export function expandPlane (chunk, tag, expectedBytes = PLANE_BYTES) {
  const rlew = expandCarmack(chunk);
  return expandRLEW(rlew, tag, expectedBytes);
}

/** The same two layers the other way round, for the round trip of W1. */
export function compressPlane (plane, tag) {
  return compressCarmack(compressRLEW(plane, tag));
}

/** The size word the RLEW stream carries inside the carmackized chunk. */
export function statedPlaneSize (chunk) {
  const rlew = expandCarmack(chunk);
  return rlew[0] | (rlew[1] << 8);
}

/** Every level the header points at, with its three planes expanded. */
export function readLevels (mapHeadBytes, gameMapsBytes) {
  const head = parseMapHead(mapHeadBytes);
  const levels = [];
  for (const { offset, index } of head.used) {
    const header = parseLevelHeader(gameMapsBytes, offset);
    const planes = [];
    for (let plane = 0; plane < PLANES; plane++) {
      const length = header.planeLengths[plane];
      if (length === 0) { planes.push(null); continue; }
      const start = header.planeOffsets[plane];
      const chunk = gameMapsBytes.subarray(start, start + length);
      planes.push({ chunk, data: expandPlane(chunk, head.tag) });
    }
    levels.push({ number: index, header, planes });
  }
  return { tag: head.tag, levels };
}
