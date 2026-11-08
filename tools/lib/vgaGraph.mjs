/**
 * VGAHEAD / VGADICT / VGAGRAPH - pictures, fonts, texts and the demos.
 *
 * VGAHEAD is a list of offsets into VGAGRAPH, three bytes each, one more
 * than there are chunks: the last one ends the last chunk, because no length
 * is stored anywhere. An offset of 0xFFFFFF means the chunk is missing and
 * the next real offset ends the one before it.
 *
 * Every chunk is Huffman compressed with the table in VGADICT and carries
 * its expanded size as an INT32LE in front of the bit stream. The tile8
 * chunk is the exception the game makes: its size is implicit, so the four
 * bytes are data, not a size.
 *
 * Chunk zero is the picture table - a width and a height per picture. How
 * many pictures there are, and where the tile8 chunk sits, is compiled into
 * WOLF3D.EXE in the original; here it is derived from the data and checked
 * against it, because the numbers in id's GFXV_WL1.H are those of an earlier
 * shareware release and do not describe v1.4.
 */

import { readDictionary, expandHuffman, compressHuffman, ROOT } from './huffman.mjs';

export const MISSING = 0xffffff;
export const TILE8_PIXELS = 64;        // 8 x 8, one byte per pixel

/** The offsets of VGAHEAD; the count of chunks is one less than the list. */
export function readHead (bytes) {
  if (bytes.length % 3 !== 0) throw new Error(`VGAHEAD is ${bytes.length} bytes, not a whole number of three byte offsets`);
  const offsets = [];
  for (let at = 0; at < bytes.length; at += 3) {
    const value = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    offsets.push(value === MISSING ? -1 : value);
  }
  return offsets;
}

/** Where every chunk starts and ends, skipping the ones that are missing. */
export function chunkRanges (offsets) {
  const ranges = [];
  for (let chunk = 0; chunk + 1 < offsets.length; chunk++) {
    const start = offsets[chunk];
    if (start < 0) { ranges.push(null); continue; }
    let next = chunk + 1;
    while (next < offsets.length && offsets[next] < 0) next += 1;
    if (next >= offsets.length) throw new Error(`chunk ${chunk} has no offset after it to end it`);
    ranges.push({ start, end: offsets[next] });
  }
  return ranges;
}

/**
 * The whole container, ready to be asked for chunks. `tile8` is the index of
 * the chunk whose expanded size is implicit; `deriveLayout` finds it.
 */
export function openGraph (headBytes, dictBytes, graphBytes, tile8 = null, tile8Size = 0) {
  const offsets = readHead(headBytes);
  const nodes = readDictionary(dictBytes);
  const ranges = chunkRanges(offsets);

  const compressedOf = (chunk) => {
    const range = ranges[chunk];
    if (!range) return null;
    if (range.end > graphBytes.length) throw new Error(`chunk ${chunk} ends at ${range.end}, past the ${graphBytes.length} bytes of VGAGRAPH`);
    return graphBytes.subarray(range.start, range.end);
  };

  const expand = (chunk) => {
    const raw = compressedOf(chunk);
    if (raw === null) return null;
    if (chunk === tile8) return expandHuffman(raw, nodes, tile8Size);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const expanded = view.getInt32(0, true);
    if (expanded < 0) throw new Error(`chunk ${chunk} states a negative expanded size ${expanded}`);
    return expandHuffman(raw.subarray(4), nodes, expanded);
  };

  return { offsets, ranges, nodes, count: ranges.length, compressedOf, expand, tile8, tile8Size, graphBytes };
}

/** Packs a chunk the way the container holds it: size word, then the bits. */
export function packChunk (data, nodes, implicitSize = false) {
  const bits = compressHuffman(data, nodes);
  if (implicitSize) return bits;
  const out = new Uint8Array(4 + bits.length);
  new DataView(out.buffer).setInt32(0, data.length, true);
  out.set(bits, 4);
  return out;
}

/** The width and height of every picture, out of chunk zero. */
export function parsePictureTable (bytes) {
  if (bytes.length % 4 !== 0) throw new Error(`the picture table is ${bytes.length} bytes, not a whole number of entries`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pictures = [];
  for (let at = 0; at < bytes.length; at += 4) {
    pictures.push({ width: view.getUint16(at, true), height: view.getUint16(at + 2, true) });
  }
  return pictures;
}

/**
 * How long a chunk is that does not say so - the tile8 chunk.
 *
 * The bit stream is walked to its end and every point at which a byte comes
 * out is a possible size; the real one is the only one that both lands in the
 * last byte of the chunk, with nothing but padding bits left, and is a whole
 * number of 8 x 8 tiles. That is how the size of this chunk is read off the
 * data instead of being taken from a header of another release.
 */
export function impliedSize (raw, nodes, multipleOf = TILE8_PIXELS) {
  const total = raw.length * 8;
  const candidates = [];
  let node = ROOT;
  let bits = 0;
  let count = 0;
  while (bits < total) {
    const value = (raw[bits >> 3] & (1 << (bits & 7))) === 0 ? nodes[node * 2] : nodes[node * 2 + 1];
    bits += 1;
    if (value < 256) {
      count += 1;
      node = ROOT;
      if (bits > total - 8 && count % multipleOf === 0) candidates.push(count);
    } else {
      node = value - 256;
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`the implicit size of this chunk is not unique: ${candidates.join(', ') || 'nothing fits'}`);
  }
  return candidates[0];
}

/**
 * Works out which chunks are what, from the data rather than from a header
 * of the game. The shape is id's: chunk 0 is the picture table, then the
 * fonts, then one chunk per picture, then the single tile8 chunk, then the
 * externals - texts and the recorded demos.
 *
 * The pictures are the anchor: a picture chunk states an expanded size of
 * exactly width * height, so the run of chunks that matches the table tells
 * us where the pictures begin and end. The chunk right after them is tile8
 * if its bits expand to 72 * 64 bytes and use up the whole chunk.
 */
export function deriveLayout (headBytes, dictBytes, graphBytes) {
  const graph = openGraph(headBytes, dictBytes, graphBytes);
  const pictures = parsePictureTable(graph.expand(0));

  let startPics = -1;
  for (let first = 1; first + pictures.length <= graph.count && startPics < 0; first++) {
    let all = true;
    for (let i = 0; i < pictures.length && all; i++) {
      const raw = graph.compressedOf(first + i);
      if (!raw) { all = false; break; }
      const stated = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(0, true);
      all = stated === pictures[i].width * pictures[i].height;
    }
    if (all) startPics = first;
  }
  if (startPics < 0) throw new Error('no run of chunks matches the picture table');

  const startTile8 = startPics + pictures.length;
  let tile8 = null;
  let tile8Size = 0;
  const raw = startTile8 < graph.count ? graph.compressedOf(startTile8) : null;
  if (raw) {
    const stated = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt32(0, true);
    // A chunk that states a size it cannot have is the one whose size is
    // implicit; everything else in VGAGRAPH carries its size in front.
    if (stated <= 0 || stated > graphBytes.length) {
      tile8 = startTile8;
      tile8Size = impliedSize(raw, graph.nodes);
    }
  }

  return {
    chunks: graph.count,
    pictures,
    startFont: 1,
    fonts: startPics - 1,
    startPics,
    startTile8: tile8,
    tile8Size,
    tile8Count: tile8Size / TILE8_PIXELS,
    startExterns: tile8 === null ? startTile8 : startTile8 + 1
  };
}
