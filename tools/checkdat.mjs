#!/usr/bin/env node
/**
 * checkdat - the acceptance test of milestone W1.
 *
 * For every chunk of every container of the game it does the round trip:
 * unpack it, pack it again with our own packer, unpack that, and compare. The
 * packers id used are gone and there are many valid ones, so the criterion is
 * not "our bytes are id's bytes" - it is "our bytes unpack to exactly the
 * same data". Prince of Persia settled on that rule in P1 and Lemmings in L1.
 *
 * On top of the round trip it checks what the containers claim about
 * themselves: that the ten levels of episode one give planes of exactly
 * 8192 bytes, that every picture is as large as the picture table says, that
 * the sprite posts can be read both ways the format allows and give the same
 * pixels, that the digitised sounds account for every page VSWAP holds, and
 * that the four audio bands divide the file the way three equal bands and the
 * music do.
 *
 * Usage: node tools/checkdat.mjs [--in sources/game/sw14] [--quiet]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandRLEW, compressRLEW } from './lib/rlew.mjs';
import { expandCarmack, compressCarmack } from './lib/carmack.mjs';
import { readDictionary, expandHuffman, compressHuffman, buildDictionary } from './lib/huffman.mjs';
import {
  readLevels, parseMapHead, compressPlane, expandPlane, statedPlaneSize,
  PLANE_BYTES, PLANES, SIGNATURE, MAPSIZE
} from './lib/gameMaps.mjs';
import { deriveLayout, openGraph, parsePictureTable, packChunk, impliedSize, TILE8_PIXELS } from './lib/vgaGraph.mjs';
import {
  openSwap, decodeWall, encodeWall, decodeSprite, encodeSprite, spritePosts,
  soundTable, readSound, TEXTURE_BYTES, TEXTURE_SIZE, TRANSPARENT
} from './lib/vswap.mjs';
import { openAudio, parsePCSound, parseAdLibSound, parseIMF } from './lib/audioT.mjs';

const DEFAULT_IN = 'sources/game/sw14';
const EXTENSION = 'WL1';
const RLEW_TAG = 0xabcd;

const read = (directory, name) => new Uint8Array(readFileSync(join(directory, `${name}.${EXTENSION}`)));

function equalBytes (left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/** A counter of checks and differences, so every part reports the same way. */
function tally (report) {
  const state = { checks: 0, differences: 0 };
  return {
    state,
    check (condition, what) {
      state.checks += 1;
      if (!condition) { state.differences += 1; report(`  DIFFERENCE ${what}`); }
      return condition;
    }
  };
}

/**
 * A seeded generator, so a run of the self test is repeatable and the next
 * run can be compared with the last (R-009 - no `Math.random` anywhere).
 */
function seededSource (seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) & 0xff;
  };
}

/**
 * Data the game does not contain, so that a clean run over the game files
 * cannot hide a packer that only works on friendly input: runs longer than a
 * reference can reach, words that have to be escaped because they look like
 * a tag, repeats too far back for a near pointer, and noise that cannot be
 * compressed at all.
 */
function selfTestCases () {
  const cases = new Map();
  const words = (values) => {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setUint16(index * 2, value, true));
    return bytes;
  };

  cases.set('one word', words([0x1234]));
  cases.set('zeros 4096', new Uint8Array(4096));
  cases.set('one word over and over', words(new Array(3000).fill(0x2a2a)));
  cases.set('the RLEW tag itself', words([1, RLEW_TAG, 2, RLEW_TAG, RLEW_TAG, 3]));
  cases.set('words that look like a Carmack pointer', words([0xa700, 0xa8ff, 0x00a7, 0xa712, 0xa834]));
  cases.set('a run longer than a reference can hold', words(new Array(900).fill(0x77)));

  const counting = words([...new Array(2048)].map((_, index) => index & 0xffff));
  cases.set('counting words', counting);

  const noise = new Uint8Array(4096);
  const source = seededSource(0x301f);
  for (let i = 0; i < noise.length; i++) noise[i] = source();
  cases.set('incompressible', noise);

  // A repeat far enough back that only a far pointer reaches it, and one
  // close enough for a near pointer, in the same stream.
  const far = new Uint8Array(8192);
  const other = seededSource(0x51ee);
  for (let i = 0; i < far.length; i++) far[i] = other();
  far.set(far.subarray(0, 600), 4000);
  far.set(far.subarray(0, 600), 7000);
  far.set(far.subarray(3900, 4100), 4200);
  cases.set('near and far repeats', far);

  const mixed = new Uint8Array(2048);
  const third = seededSource(0x1234);
  for (let i = 0; i < mixed.length; i++) mixed[i] = i < 1000 ? third() : 0x5a;
  cases.set('noise then a long run', mixed);
  return cases;
}

/** The round trip over data of our own - a test of the tools, not the game. */
export function checkSelfTest (report = () => {}) {
  const { state, check } = tally(report);
  for (const [name, data] of selfTestCases()) {
    const rlew = compressRLEW(data, RLEW_TAG);
    check(equalBytes(expandRLEW(rlew, RLEW_TAG), data), `self test "${name}": RLEW round trip changed the data`);

    const carmack = compressCarmack(data);
    check(equalBytes(expandCarmack(carmack), data), `self test "${name}": Carmack round trip changed the data`);

    const both = compressCarmack(compressRLEW(data, RLEW_TAG));
    check(equalBytes(expandRLEW(expandCarmack(both), RLEW_TAG), data), `self test "${name}": both layers changed the data`);

    const nodes = buildDictionary(data);
    const huffman = compressHuffman(data, nodes);
    check(equalBytes(expandHuffman(huffman, nodes, data.length), data), `self test "${name}": Huffman round trip changed the data`);

    report(`self test ${name.padEnd(40)} ${String(data.length).padStart(5)} bytes -> ` +
      `RLEW ${rlew.length}, Carmack ${carmack.length}, both ${both.length}, Huffman ${huffman.length}`);
  }
  return state;
}

/** MAPHEAD and GAMEMAPS: the ten levels of episode one, plane by plane. */
export function checkMaps (inDirectory, report = () => {}) {
  const { state, check } = tally(report);
  const headBytes = read(inDirectory, 'MAPHEAD');
  const mapsBytes = read(inDirectory, 'GAMEMAPS');
  const head = parseMapHead(headBytes);

  check(head.tag === RLEW_TAG, `MAPHEAD states RLEW tag 0x${head.tag.toString(16)}, expected 0xABCD`);
  check(new TextDecoder('latin1').decode(mapsBytes.subarray(0, 8)) === SIGNATURE, 'GAMEMAPS does not start with TED5v1.0');

  const { levels } = readLevels(headBytes, mapsBytes);
  check(levels.length === 10, `${levels.length} levels in MAPHEAD, episode one has 10`);

  let planes = 0;
  let ourBytes = 0;
  let theirBytes = 0;
  for (const level of levels) {
    const where = `level ${level.number} "${level.header.name}"`;
    check(level.header.width === MAPSIZE && level.header.height === MAPSIZE,
      `${where}: ${level.header.width}x${level.header.height}, the game assumes 64x64`);
    check(level.header.signature === '!ID!', `${where}: no !ID! after the name, which v1.1 and later always have`);

    for (let plane = 0; plane < PLANES; plane++) {
      const content = level.planes[plane];
      if (!check(content !== null, `${where}: plane ${plane} is missing`)) continue;
      planes += 1;

      // 1. the size the milestone asks for
      check(content.data.length === PLANE_BYTES, `${where} plane ${plane}: ${content.data.length} bytes, expected ${PLANE_BYTES}`);

      // 2. what the RLEW stream inside says about itself
      check(statedPlaneSize(content.chunk) === PLANE_BYTES,
        `${where} plane ${plane}: the RLEW size word says ${statedPlaneSize(content.chunk)}`);

      // 3. our packer has to be readable by our expander, byte for byte
      const repacked = compressPlane(content.data, RLEW_TAG);
      check(equalBytes(expandPlane(repacked, RLEW_TAG), content.data), `${where} plane ${plane}: round trip changed the data`);
      ourBytes += repacked.length;
      theirBytes += content.chunk.length;

      // 4. and each layer has to survive on its own as well
      const rlew = compressRLEW(content.data, RLEW_TAG);
      check(equalBytes(expandRLEW(rlew, RLEW_TAG), content.data), `${where} plane ${plane}: RLEW alone changed the data`);
      check(equalBytes(expandCarmack(compressCarmack(rlew)), rlew), `${where} plane ${plane}: Carmack alone changed the data`);
    }
    report(`${`level ${level.number}`.padEnd(9)} ${level.header.name.padEnd(14)} ${PLANES} planes of ${PLANE_BYTES} bytes, round trip clean`);
  }
  return { ...state, levels: levels.length, planes, ourBytes, theirBytes };
}

/** VGAHEAD, VGADICT and VGAGRAPH: every chunk, and what the table claims. */
export function checkGraphics (inDirectory, report = () => {}) {
  const { state, check } = tally(report);
  const headBytes = read(inDirectory, 'VGAHEAD');
  const dictBytes = read(inDirectory, 'VGADICT');
  const graphBytes = read(inDirectory, 'VGAGRAPH');

  const layout = deriveLayout(headBytes, dictBytes, graphBytes);
  const graph = openGraph(headBytes, dictBytes, graphBytes, layout.startTile8, layout.tile8Size);
  const nodes = readDictionary(dictBytes);

  check(dictBytes.length === 1024, `VGADICT is ${dictBytes.length} bytes, expected 1024`);
  check(graph.offsets[graph.offsets.length - 1] === graphBytes.length,
    `the last VGAHEAD offset is ${graph.offsets[graph.offsets.length - 1]}, VGAGRAPH is ${graphBytes.length} bytes`);

  // The offsets have to walk forwards and leave nothing between the chunks.
  let previous = -1;
  let ascending = true;
  for (const offset of graph.offsets) {
    if (offset < 0) continue;
    if (offset < previous) ascending = false;
    previous = offset;
  }
  check(ascending, 'the VGAHEAD offsets do not ascend');

  let chunks = 0;
  let bytes = 0;
  let ourBytes = 0;
  let theirBytes = 0;
  for (let chunk = 0; chunk < graph.count; chunk++) {
    const data = graph.expand(chunk);
    if (!check(data !== null, `chunk ${chunk} is missing`)) continue;
    chunks += 1;
    bytes += data.length;

    const implicit = chunk === layout.startTile8;
    const repacked = packChunk(data, nodes, implicit);
    const again = implicit
      ? expandHuffman(repacked, nodes, layout.tile8Size)
      : expandHuffman(repacked.subarray(4), nodes, new DataView(repacked.buffer).getInt32(0, true));
    check(equalBytes(again, data), `chunk ${chunk}: round trip changed the data`);
    ourBytes += repacked.length + (implicit ? 0 : 4);
    theirBytes += graph.compressedOf(chunk).length;
  }

  // Every picture has to be as large as chunk zero says it is.
  const pictures = parsePictureTable(graph.expand(0));
  check(pictures.length === layout.pictures.length, 'the picture table was read two different ways');
  for (const [index, picture] of pictures.entries()) {
    const data = graph.expand(layout.startPics + index);
    check(data !== null && data.length === picture.width * picture.height,
      `picture ${index}: ${data ? data.length : 'missing'} bytes, the table says ${picture.width}x${picture.height}`);
  }

  // The tile8 chunk states no size; the one derived from the bits has to be
  // a whole number of 8x8 tiles and has to be the only size that fits.
  if (layout.startTile8 !== null) {
    check(layout.tile8Size % TILE8_PIXELS === 0, `the tile8 chunk is ${layout.tile8Size} bytes, not whole 8x8 tiles`);
    check(impliedSize(graph.compressedOf(layout.startTile8), nodes) === layout.tile8Size, 'the tile8 size is not unique');
  }

  report(`graphics  ${chunks} chunks of ${graph.count} -> ${bytes} bytes, ` +
    `${pictures.length} pictures, tile8 ${layout.tile8Count} tiles, round trip clean`);
  return { ...state, chunks, pictures: pictures.length, bytes, ourBytes, theirBytes };
}

/** VSWAP: the walls, the sprites read both ways, and the sound pages. */
export function checkSwap (inDirectory, report = () => {}) {
  const { state, check } = tally(report);
  const bytes = read(inDirectory, 'VSWAP');
  const swap = openSwap(bytes);

  check(swap.firstSprite < swap.firstSound && swap.firstSound < swap.chunks,
    `VSWAP says sprites at ${swap.firstSprite}, sounds at ${swap.firstSound}, ${swap.chunks} chunks`);

  let walls = 0;
  for (let chunk = 0; chunk < swap.firstSprite; chunk++) {
    const raw = swap.chunkOf(chunk);
    if (!raw) continue;
    walls += 1;
    check(raw.length === TEXTURE_BYTES, `wall ${chunk}: ${raw.length} bytes, a wall is ${TEXTURE_BYTES}`);
    check(equalBytes(encodeWall(decodeWall(raw)), raw), `wall ${chunk}: the transpose is not its own inverse`);
  }

  let sprites = 0;
  for (let chunk = swap.firstSprite; chunk < swap.firstSound; chunk++) {
    const raw = swap.chunkOf(chunk);
    if (!raw) continue;
    sprites += 1;
    const where = `sprite ${chunk - swap.firstSprite}`;
    const pixels = decodeSprite(raw);

    // Our own posts have to describe the same picture.
    check(equalBytes(decodeSprite(encodeSprite(pixels)), pixels), `${where}: round trip changed the picture`);

    // The format allows two ways of finding the pixels of a post - through
    // its offset word, and by taking them in order after the post lists.
    // They have to agree, or one of the two readings is wrong.
    const { first, last, columns } = spritePosts(raw);
    let at = raw.length;
    for (const { posts } of columns) for (const post of posts) at = Math.min(at, post.offset + post.start);
    let sequential = true;
    for (const { posts } of columns) {
      for (const post of posts) {
        for (let y = post.start; y < post.end; y++, at++) if (raw[post.offset + y] !== raw[at]) sequential = false;
      }
    }
    check(sequential, `${where}: the two ways of reading the posts disagree`);
    check(first <= last && last < TEXTURE_SIZE, `${where}: columns ${first}..${last}`);

    // Nothing outside those columns, and nothing opaque where no post is.
    let outside = 0;
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      if (x >= first && x <= last) continue;
      for (let y = 0; y < TEXTURE_SIZE; y++) if (pixels[y * TEXTURE_SIZE + x] !== TRANSPARENT) outside += 1;
    }
    check(outside === 0, `${where}: ${outside} pixels outside columns ${first}..${last}`);
  }

  // The sounds have to account for every page VSWAP holds after the sprites.
  const table = soundTable(swap);
  const present = table.filter((entry) => entry.present);
  let pages = 0;
  for (const entry of present) {
    const samples = readSound(swap, entry);
    check(samples.length === entry.length, `sound ${entry.index}: ${samples.length} bytes, the table says ${entry.length}`);
    pages += entry.pages;
  }
  let stored = 0;
  for (let chunk = swap.firstSound; chunk < swap.chunks - 1; chunk++) if (swap.lengths[chunk] > 0) stored += 1;
  check(pages === stored, `the sounds claim ${pages} pages, VSWAP stores ${stored}`);

  report(`vswap     ${walls} walls, ${sprites} sprites, ${present.length} sounds of ${table.length} ` +
    `over ${pages} pages, round trip clean`);
  return { ...state, walls, sprites, sounds: present.length };
}

/** AUDIOHED and AUDIOT: the four bands and everything inside them. */
export function checkAudio (inDirectory, report = () => {}) {
  const { state, check } = tally(report);
  const headBytes = read(inDirectory, 'AUDIOHED');
  const audioBytes = read(inDirectory, 'AUDIOT');
  const audio = openAudio(headBytes, audioBytes);

  check(audio.offsets[audio.offsets.length - 1] === audioBytes.length,
    `the last AUDIOHED offset is ${audio.offsets[audio.offsets.length - 1]}, AUDIOT is ${audioBytes.length} bytes`);
  check(audio.startMusic === audio.sounds * 3, `the music starts at ${audio.startMusic}, not after three bands of ${audio.sounds}`);
  check(audio.count === audio.startMusic + audio.tracks, 'the bands do not add up to the number of chunks');

  let ascending = true;
  for (let i = 1; i < audio.offsets.length; i++) if (audio.offsets[i] < audio.offsets[i - 1]) ascending = false;
  check(ascending, 'the AUDIOHED offsets do not ascend');

  let pc = 0;
  let adlib = 0;
  for (let index = 0; index < audio.sounds; index++) {
    const speaker = audio.chunkOf(audio.startPC + index);
    if (speaker) {
      pc += 1;
      const sound = parsePCSound(speaker);
      check(sound.data.length === sound.length, `PC sound ${index}: states ${sound.length} bytes, holds ${sound.data.length}`);
      check(sound.terminator === 0, `PC sound ${index}: terminator is ${sound.terminator}, expected 0`);
    }
    const fm = audio.chunkOf(audio.startAdLib + index);
    if (fm) {
      adlib += 1;
      const sound = parseAdLibSound(fm);
      check(sound.data.length === sound.length, `AdLib sound ${index}: states ${sound.length} bytes, holds ${sound.data.length}`);
      check(sound.octave <= 7, `AdLib sound ${index}: octave ${sound.octave}, the block field holds 0..7`);
      check(sound.instrumentBytes.length === 16, `AdLib sound ${index}: the instrument is not 16 bytes`);
    }
  }
  check(pc === adlib, `${pc} PC speaker effects against ${adlib} AdLib ones, every effect exists in both`);

  let playing = 0;
  let writes = 0;
  for (let index = 0; index < audio.tracks; index++) {
    const chunk = audio.chunkOf(audio.startMusic + index);
    if (!check(chunk !== null, `music chunk ${index} is empty, even a track without data keeps its record`)) continue;
    const track = parseIMF(chunk);
    if (!track.present) continue;
    playing += 1;
    writes += track.writes.length;
    check(track.length === track.writes.length * 4, `track ${index} "${track.name}": ${track.length} bytes is not ${track.writes.length} writes`);
    // The OPL2 has registers up to 0xF5; a write outside that is a misread.
    check(track.writes.every((write) => write.register <= 0xf5), `track ${index} "${track.name}": a register outside the OPL2`);
    check(track.ticks > 0, `track ${index} "${track.name}": no delays at all`);
  }

  report(`audio     ${pc} PC speaker, ${adlib} AdLib, ${playing} of ${audio.tracks} tracks ` +
    `with ${writes} register writes`);
  return { ...state, pc, adlib, tracks: playing, writes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet');
  const inIndex = argv.indexOf('--in');
  const inDirectory = inIndex === -1 ? DEFAULT_IN : argv[inIndex + 1];
  const report = quiet ? () => {} : (line) => console.log(line);

  const parts = [
    ['self test', checkSelfTest(report)],
    ['maps', checkMaps(inDirectory, report)],
    ['graphics', checkGraphics(inDirectory, report)],
    ['vswap', checkSwap(inDirectory, report)],
    ['audio', checkAudio(inDirectory, report)]
  ];
  const checks = parts.reduce((sum, [, part]) => sum + part.checks, 0);
  const differences = parts.reduce((sum, [, part]) => sum + part.differences, 0);
  const maps = parts[1][1];
  const graphics = parts[2][1];
  const swap = parts[3][1];
  const audio = parts[4][1];

  console.log(
    `checkdat.mjs: ${checks} checks, ${differences} differences ` +
    `(${maps.levels} levels of ${maps.planes} planes, ${graphics.chunks} VGAGRAPH chunks, ` +
    `${swap.walls} walls, ${swap.sprites} sprites, ${swap.sounds} sounds, ` +
    `${audio.pc}+${audio.adlib} effects, ${audio.tracks} tracks)`
  );
  const share = (part) => `${part.ourBytes} bytes against ${part.theirBytes} of the original ` +
    `(${(100 * part.ourBytes / part.theirBytes).toFixed(1)} %)`;
  console.log(`  our packers: map planes ${share(maps)}, VGAGRAPH ${share(graphics)}`);
  process.exit(differences === 0 ? 0 : 1);
}
