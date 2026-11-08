#!/usr/bin/env node
/**
 * dumpdat - takes the containers of the game apart.
 *
 * This is milestone W1, so it stops where the compression stops: every chunk
 * of every file comes out as the bytes the game itself would have in memory,
 * into `build/chunks/`, outside version control, with a manifest describing
 * what was found. Turning those bytes into textures, sprites, levels and
 * sounds in open formats is W2, and that goes to `data/`.
 *
 * The four groups are the four the game has:
 *
 *   maps      MAPHEAD + GAMEMAPS   Carmack off, then RLEW off
 *   graphics  VGAHEAD + VGADICT + VGAGRAPH   Huffman off
 *   vswap     VSWAP                walls, sprites and the digitised sounds
 *   audio     AUDIOHED + AUDIOT    PC speaker, AdLib and the IMF music
 *
 * Usage:
 *   node tools/dumpdat.mjs [--in sources/game/sw14] [--out build/chunks]
 *                          [--what all|maps|graphics|vswap|audio] [--quiet]
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readLevels, PLANE_BYTES, PLANES, SIGNATURE } from './lib/gameMaps.mjs';
import { deriveLayout, openGraph } from './lib/vgaGraph.mjs';
import { openSwap, decodeWall, decodeSprite, soundTable, readSound, SOUND_RATE, TEXTURE_BYTES } from './lib/vswap.mjs';
import { openAudio, parsePCSound, parseAdLibSound, parseIMF } from './lib/audioT.mjs';

const DEFAULT_IN = 'sources/game/sw14';
const DEFAULT_OUT = 'build/chunks';
const EXTENSION = 'WL1';                  // shareware v1.4 - ZADANI.md para 5

function parseArguments (argv) {
  const options = { in: DEFAULT_IN, out: DEFAULT_OUT, what: 'all', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--in': options.in = argv[++i]; break;
      case '--out': options.out = argv[++i]; break;
      case '--what': options.what = argv[++i]; break;
      case '--quiet': options.quiet = true; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!['all', 'maps', 'graphics', 'vswap', 'audio'].includes(options.what)) {
    throw new Error(`--what ${options.what}: expected all, maps, graphics, vswap or audio`);
  }
  return options;
}

const read = (directory, name) => new Uint8Array(readFileSync(join(directory, `${name}.${EXTENSION}`)));
const number = (value, width = 3) => String(value).padStart(width, '0');

function write (directory, name, bytes) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), bytes);
}

// ------------------------------------------------------------------ the maps

export function dumpMaps (inDirectory, outDirectory, report) {
  const { tag, levels } = readLevels(read(inDirectory, 'MAPHEAD'), read(inDirectory, 'GAMEMAPS'));
  const out = join(outDirectory, 'maps');
  const described = [];

  for (const level of levels) {
    for (let plane = 0; plane < PLANES; plane++) {
      const content = level.planes[plane];
      if (!content) continue;
      write(out, `level${number(level.number, 2)}.plane${plane}.bin`, content.data);
    }
    described.push({
      number: level.number,
      name: level.header.name,
      width: level.header.width,
      height: level.header.height,
      signature: level.header.signature,
      planeBytes: level.planes.map((plane) => (plane ? plane.data.length : 0)),
      compressedBytes: level.header.planeLengths
    });
    report(`level ${number(level.number, 2)} ${level.header.name.padEnd(14)} ` +
      `${level.header.width}x${level.header.height}, planes ${level.header.planeLengths.join('/')} -> ${PLANE_BYTES} bytes each`);
  }
  return { tag, signature: SIGNATURE, levels: described };
}

// -------------------------------------------------------------- the graphics

export function dumpGraphics (inDirectory, outDirectory, report) {
  const head = read(inDirectory, 'VGAHEAD');
  const dict = read(inDirectory, 'VGADICT');
  const graph = read(inDirectory, 'VGAGRAPH');
  const layout = deriveLayout(head, dict, graph);
  const container = openGraph(head, dict, graph, layout.startTile8, layout.tile8Size);
  const out = join(outDirectory, 'graphics');

  let bytes = 0;
  for (let chunk = 0; chunk < container.count; chunk++) {
    const data = container.expand(chunk);
    if (!data) continue;
    write(out, `chunk${number(chunk)}.bin`, data);
    bytes += data.length;
  }
  write(out, 'vgadict.bin', dict);

  report(`graphics    ${container.count} chunks -> ${bytes} bytes ` +
    `(${layout.pictures.length} pictures from ${layout.startPics}, ${layout.fonts} fonts, ` +
    `tile8 ${layout.startTile8} = ${layout.tile8Count} tiles, ${container.count - layout.startExterns} externals)`);

  return {
    chunks: container.count,
    startFont: layout.startFont,
    fonts: layout.fonts,
    startPics: layout.startPics,
    pictures: layout.pictures,
    startTile8: layout.startTile8,
    tile8Count: layout.tile8Count,
    startExterns: layout.startExterns,
    externs: container.count - layout.startExterns,
    bytes
  };
}

// ------------------------------------------------- the walls, sprites, sounds

export function dumpSwap (inDirectory, outDirectory, report) {
  const swap = openSwap(read(inDirectory, 'VSWAP'));
  const out = join(outDirectory, 'vswap');

  let walls = 0;
  for (let chunk = 0; chunk < swap.firstSprite; chunk++) {
    const raw = swap.chunkOf(chunk);
    if (!raw) continue;
    write(out, `wall${number(chunk)}.bin`, decodeWall(raw));
    walls += 1;
  }

  let sprites = 0;
  for (let chunk = swap.firstSprite; chunk < swap.firstSound; chunk++) {
    const raw = swap.chunkOf(chunk);
    if (!raw) continue;
    write(out, `sprite${number(chunk - swap.firstSprite)}.bin`, decodeSprite(raw));
    sprites += 1;
  }

  const table = soundTable(swap);
  const sounds = [];
  for (const entry of table) {
    if (!entry.present) continue;
    const samples = readSound(swap, entry);
    write(out, `sound${number(entry.index, 2)}.u8`, samples);
    sounds.push({ index: entry.index, startPage: entry.start, bytes: samples.length, seconds: samples.length / SOUND_RATE });
  }

  report(`vswap       ${swap.chunks} chunks: ${walls} walls of ${swap.firstSprite}, ` +
    `${sprites} sprites of ${swap.firstSound - swap.firstSprite}, ` +
    `${sounds.length} sounds of ${table.length} in the table`);

  return {
    chunks: swap.chunks,
    firstSprite: swap.firstSprite,
    firstSound: swap.firstSound,
    walls,
    sprites,
    textureBytes: TEXTURE_BYTES,
    sampleRate: SOUND_RATE,
    sounds
  };
}

// ----------------------------------------------------------------- the audio

export function dumpAudio (inDirectory, outDirectory, report) {
  const audio = openAudio(read(inDirectory, 'AUDIOHED'), read(inDirectory, 'AUDIOT'));
  const out = join(outDirectory, 'audio');

  let pc = 0;
  let adlib = 0;
  for (let index = 0; index < audio.sounds; index++) {
    const speaker = audio.chunkOf(audio.startPC + index);
    if (speaker) { write(out, `pc${number(index)}.bin`, parsePCSound(speaker).data); pc += 1; }
    const fm = audio.chunkOf(audio.startAdLib + index);
    if (fm) { write(out, `adlib${number(index)}.bin`, parseAdLibSound(fm).data); adlib += 1; }
  }

  const tracks = [];
  for (let index = 0; index < audio.tracks; index++) {
    const chunk = audio.chunkOf(audio.startMusic + index);
    if (!chunk) continue;
    const track = parseIMF(chunk);
    if (track.present) write(out, `music${number(index, 2)}.imf`, chunk.subarray(0, 2 + track.length));
    tracks.push({ index, name: track.name, present: track.present, writes: track.writes.length, seconds: track.seconds });
  }

  const playing = tracks.filter((track) => track.present);
  report(`audio       ${audio.count} chunks: ${pc} PC speaker, ${adlib} AdLib, ` +
    `${playing.length} of ${audio.tracks} tracks with data ` +
    `(${playing.reduce((sum, track) => sum + track.seconds, 0).toFixed(0)} s)`);

  return {
    chunks: audio.count,
    sounds: audio.sounds,
    startAdLib: audio.startAdLib,
    startDigitised: audio.startDigitised,
    startMusic: audio.startMusic,
    digitisedTag: audio.digitisedTag,
    pc,
    adlib,
    tracks
  };
}

// ------------------------------------------------------------------------ cli

export function dump (options, report = () => {}) {
  const manifest = { edition: 'shareware v1.4', extension: EXTENSION, from: options.in, what: options.what };
  if (options.what === 'all') rmSync(options.out, { recursive: true, force: true });
  mkdirSync(options.out, { recursive: true });

  if (options.what === 'all' || options.what === 'maps') manifest.maps = dumpMaps(options.in, options.out, report);
  if (options.what === 'all' || options.what === 'graphics') manifest.graphics = dumpGraphics(options.in, options.out, report);
  if (options.what === 'all' || options.what === 'vswap') manifest.vswap = dumpSwap(options.in, options.out, report);
  if (options.what === 'all' || options.what === 'audio') manifest.audio = dumpAudio(options.in, options.out, report);

  writeFileSync(join(options.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  const report = options.quiet ? () => {} : (line) => console.log(line);
  const manifest = dump(options, report);
  console.log(`dumpdat.mjs: ${options.what} of ${options.in} -> ${options.out}/`);
  if (manifest.maps) console.log(`  ${manifest.maps.levels.length} levels, RLEW tag 0x${manifest.maps.tag.toString(16).toUpperCase()}`);
}
