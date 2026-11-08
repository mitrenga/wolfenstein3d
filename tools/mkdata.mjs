#!/usr/bin/env node
/**
 * mkdata - turns the containers of the game into the open formats the remake
 * runs on, in `data/`.
 *
 * W1 stopped where the compression stops: `dumpdat` puts every chunk into
 * `build/chunks/` as the bytes the game would have in memory. This is the
 * step after it. What comes out here is what `app/` fetches at run time -
 * JSON with the pixels inside it as base64 - plus a few PNG sheets that are
 * only there for the eye.
 *
 * Two things do not come out of a data file at all, because the game keeps
 * them in its program: the palette the DAC is loaded with, and `rndtable`.
 * WOLF3D.EXE is LZEXE-packed, so it is unpacked first (lib/lzexe.mjs) and
 * both tables are then found by what is in them (lib/exeTables.mjs).
 *
 * Usage:
 *   node tools/mkdata.mjs [--in sources/game/sw14] [--out data] [--quiet]
 *                         [--no-png]
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { readLevels, PLANE_BYTES, MAPSIZE } from './lib/gameMaps.mjs';
import { deriveLayout, openGraph, TILE8_PIXELS } from './lib/vgaGraph.mjs';
import { openSwap, decodeWall, decodeSprite, soundTable, readSound, SOUND_RATE, TEXTURE_SIZE, TEXTURE_BYTES, TRANSPARENT } from './lib/vswap.mjs';
import { openAudio, parsePCSound, parseAdLibSound, parseIMF, PC_RATE, IMF_RATE } from './lib/audioT.mjs';
import { readExeTables } from './lib/exeTables.mjs';
import { nameOf } from './lib/chunkNames.mjs';
import { encodeIndexedPNG } from '../app/svision/tools/retro/png.mjs';

const DEFAULT_IN = 'sources/game/sw14';
const DEFAULT_OUT = 'data';
const EXTENSION = 'WL1';
const FORMAT = 'wolf3d-data-1';

function parseArguments (argv) {
  const options = { in: DEFAULT_IN, out: DEFAULT_OUT, quiet: false, png: true };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--in': options.in = argv[++i]; break;
      case '--out': options.out = argv[++i]; break;
      case '--quiet': options.quiet = true; break;
      case '--no-png': options.png = false; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return options;
}

const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const number = (value, width = 3) => String(value).padStart(width, '0');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function writeJSON (directory, name, value) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 1)}\n`);
}

function writeFile (directory, name, bytes) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), bytes);
}

/**
 * A picture of VGAGRAPH, from the four planes of the card into plain rows.
 *
 * The pictures are stored the way the card wanted them: plane 0 holds the
 * pixels whose x is a multiple of four, plane 1 the next one over, and so
 * on, each plane a quarter of the width. `VL_MemToScreen` copies one plane
 * at a time with the map mask set - which is why a picture read straight
 * out of the file looks like four narrow copies of itself.
 */
function unplane (bytes, width, height) {
  if (width % 4 !== 0) throw new Error(`a picture ${width} wide cannot be four planes`);
  const quarter = width / 4;
  const pixels = new Uint8Array(width * height);
  for (let plane = 0; plane < 4; plane++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < quarter; x++) {
        pixels[y * width + x * 4 + plane] = bytes[plane * quarter * height + y * quarter + x];
      }
    }
  }
  return pixels;
}

/** The palette as PNG wants it: three bytes a register, eight bits each. */
function rgb8 (palette) {
  const out = new Uint8Array(768);
  for (let i = 0; i < 768; i++) out[i] = ((palette[i] << 2) | (palette[i] >> 4)) & 0xff;
  return out;
}

// --------------------------------------------------------------- the program

function makeExe (bytes, out, report) {
  const tables = readExeTables(bytes);
  writeJSON(out, 'palette.json', {
    format: FORMAT,
    source: `WOLF3D.${EXTENSION === 'WL1' ? 'EXE' : 'EXE'}`,
    what: 'the 256 DAC registers the game programs, six bits a component',
    foundAt: tables.paletteAt,
    colors: 256,
    bytes: base64(tables.palette)
  });
  writeJSON(out, 'random.json', {
    format: FORMAT,
    source: 'WOLF3D.EXE',
    what: 'rndtable - the 256 bytes every fight in the game is decided by (ID_US_A.ASM)',
    foundAt: tables.rndtableAt,
    count: tables.rndtable.length,
    bytes: base64(tables.rndtable)
  });
  report(`exe         unpacked ${tables.imageBytes} bytes (${tables.tokens} tokens), ` +
    `palette at 0x${tables.paletteAt.toString(16)}, rndtable at 0x${tables.rndtableAt.toString(16)}`);
  return { imageBytes: tables.imageBytes, paletteAt: tables.paletteAt, rndtableAt: tables.rndtableAt, palette: tables.palette };
}

// --------------------------------------------------------------- the levels

function makeLevels (inDirectory, out, report) {
  const { tag, levels } = readLevels(read(inDirectory, 'MAPHEAD'), read(inDirectory, 'GAMEMAPS'));
  const directory = join(out, 'levels');
  const index = [];
  for (const level of levels) {
    const planes = level.planes.map((plane) => (plane && plane.data.length === PLANE_BYTES ? base64(plane.data) : null));
    writeJSON(directory, `level${number(level.number, 2)}.json`, {
      format: FORMAT,
      number: level.number,
      name: level.header.name,
      width: level.header.width,
      height: level.header.height,
      planes,
      what: 'plane 0 walls and doors, plane 1 objects and actors, plane 2 unused; 64*64 UINT16LE each'
    });
    index.push({ number: level.number, name: level.header.name, file: `levels/level${number(level.number, 2)}` });
  }
  writeJSON(out, 'levels.json', { format: FORMAT, tag, mapSize: MAPSIZE, count: index.length, levels: index });
  report(`levels      ${index.length} levels -> data/levels/`);
  return { count: index.length, tag };
}

// ------------------------------------------------------- walls and sprites

function makeSwap (inDirectory, out, report, palette, png) {
  const swap = openSwap(read(inDirectory, 'VSWAP'));
  const directory = join(out, 'gfx');

  const walls = [];
  for (let chunk = 0; chunk < swap.firstSprite; chunk++) {
    const raw = swap.chunkOf(chunk);
    walls.push(raw ? base64(decodeWall(raw)) : null);
  }
  writeJSON(directory, 'walls.json', {
    format: FORMAT, size: TEXTURE_SIZE, count: walls.filter(Boolean).length, slots: walls.length,
    what: 'wall textures, 64*64 palette indices row by row; null where the shareware has no chunk',
    textures: walls
  });

  const sprites = [];
  for (let chunk = swap.firstSprite; chunk < swap.firstSound; chunk++) {
    const raw = swap.chunkOf(chunk);
    sprites.push(raw ? base64(decodeSprite(raw)) : null);
  }
  writeJSON(directory, 'sprites.json', {
    format: FORMAT, size: TEXTURE_SIZE, transparent: TRANSPARENT,
    count: sprites.filter(Boolean).length, slots: sprites.length,
    what: `sprites, 64*64 palette indices row by row, ${TRANSPARENT} where they are see-through`,
    sprites
  });

  const table = soundTable(swap);
  const digi = [];
  for (const entry of table) {
    if (!entry.present) { digi.push(null); continue; }
    const samples = readSound(swap, entry);
    digi.push({ index: entry.index, bytes: samples.length, seconds: samples.length / SOUND_RATE, pcm: base64(samples) });
  }
  writeJSON(join(out, 'sounds'), 'digi.json', {
    format: FORMAT, rate: SOUND_RATE, count: digi.filter(Boolean).length, slots: digi.length,
    what: 'the digitised sounds of VSWAP, unsigned 8 bit at 7000 Hz (ID_SD.C)',
    sounds: digi
  });

  if (png) {
    writeFile(directory, 'walls.png', sheet(walls, TEXTURE_SIZE, 8, palette, null));
    writeFile(directory, 'sprites.png', sheet(sprites, TEXTURE_SIZE, 16, palette, TRANSPARENT));
  }
  report(`vswap       ${walls.filter(Boolean).length} walls, ${sprites.filter(Boolean).length} sprites, ` +
    `${digi.filter(Boolean).length} digitised sounds -> data/gfx, data/sounds`);
  return { walls: walls.filter(Boolean).length, sprites: sprites.filter(Boolean).length, digi: digi.filter(Boolean).length };
}

/** A grid of square pictures as one indexed PNG, for looking at. */
function sheet (pictures, size, columns, palette, transparent) {
  const rows = Math.ceil(pictures.length / columns);
  const width = columns * size;
  const height = rows * size;
  const pixels = new Uint8Array(width * height).fill(transparent === null ? 0 : transparent);
  pictures.forEach((picture, at) => {
    if (!picture) return;
    const bytes = Buffer.from(picture, 'base64');
    const originX = (at % columns) * size;
    const originY = Math.floor(at / columns) * size;
    for (let y = 0; y < size; y++) pixels.set(bytes.subarray(y * size, y * size + size), (originY + y) * width + originX);
  });
  const options = transparent === null ? {} : { transparent };
  return encodeIndexedPNG(width, height, pixels, rgb8(palette), options);
}

// ------------------------------------- pictures, fonts, tile8, texts, demos

/** A font chunk: a height, 256 offsets, 256 widths, then the glyphs. */
function parseFont (bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = view.getUint16(0, true);
  const glyphs = [];
  let inked = 0;
  for (let code = 0; code < 256; code++) {
    const at = view.getUint16(2 + code * 2, true);
    const width = bytes[2 + 512 + code];
    if (width === 0 || at === 0) { glyphs.push(null); continue; }
    const size = width * height;
    if (at + size > bytes.length) throw new Error(`glyph ${code} runs past the end of the font chunk`);
    const pixels = bytes.subarray(at, at + size);
    for (const pixel of pixels) if (pixel) inked += 1;
    glyphs.push({ code, width, pixels: base64(pixels) });
  }
  if (inked === 0) throw new Error('a font with no inked pixel at all is not a font');
  return { height, glyphs };
}

/** Whether a chunk is one of the texts rather than a recorded demo. */
function looksLikeText (bytes) {
  let printable = 0;
  const take = Math.min(bytes.length, 256);
  for (let i = 0; i < take; i++) {
    const byte = bytes[i];
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1;
  }
  return printable / take > 0.9;
}

/** A tic of the game, and how many of them one step of a demo lasts. */
export const DEMOTICS = 4;

/**
 * A recorded demo: the level it plays, a word of how long the whole chunk
 * is and a byte nobody reads, then three bytes per step - the buttons held,
 * and how far the player asked to turn and to walk. A step always lasts
 * DEMOTICS tics, which is why a demo plays back the same on any machine
 * (`PlayDemo` and `PollControls` take the chunk apart exactly this way).
 */
function parseDemo (bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const level = bytes[0];
  const length = view.getUint16(1, true);
  const steps = Math.floor((Math.min(length, bytes.length) - 4) / 3);
  return {
    level,
    length,
    steps,
    tics: steps * DEMOTICS,
    plausible: level < 10 && length >= 4 && length <= bytes.length && (length - 4) % 3 === 0
  };
}

/** A screen the game prints in text mode: 80 x 25 of a character and an attribute. */
function looksLikeTextScreen (bytes) {
  return bytes.length >= 4000 && bytes.length <= 4008;
}

function makeGraphics (inDirectory, out, report, palette, png) {
  const head = read(inDirectory, 'VGAHEAD');
  const dict = read(inDirectory, 'VGADICT');
  const graph = read(inDirectory, 'VGAGRAPH');
  const layout = deriveLayout(head, dict, graph);
  const container = openGraph(head, dict, graph, layout.startTile8, layout.tile8Size);
  const directory = join(out, 'gfx');

  const pictures = layout.pictures.map((picture, at) => {
    const data = container.expand(layout.startPics + at);
    if (!data) return null;
    if (data.length !== picture.width * picture.height) {
      throw new Error(`picture ${at} is ${data.length} bytes, the table says ${picture.width}x${picture.height}`);
    }
    return { index: at, chunk: layout.startPics + at, name: nameOf(layout.startPics + at),
      width: picture.width, height: picture.height,
      pixels: base64(unplane(data, picture.width, picture.height)) };
  });
  writeJSON(directory, 'pics.json', {
    format: FORMAT, firstChunk: layout.startPics, count: pictures.filter(Boolean).length,
    what: 'the pictures of VGAGRAPH, palette indices row by row - the four planes of the card put back together (mkdata.mjs: unplane); the index is the one the game uses',
    pictures
  });

  const fonts = [];
  for (let i = 0; i < layout.fonts; i++) {
    const data = container.expand(layout.startFont + i);
    if (!data) continue;
    const font = parseFont(data);
    fonts.push({ index: i, chunk: layout.startFont + i, height: font.height, glyphs: font.glyphs });
  }
  writeJSON(directory, 'fonts.json', {
    format: FORMAT, count: fonts.length,
    what: 'the two fonts of VGAGRAPH: a height, and per character a width and width*height mask bytes',
    fonts
  });

  const tiles = [];
  if (layout.startTile8 !== null) {
    const data = container.expand(layout.startTile8);
    for (let at = 0; at + TILE8_PIXELS <= data.length; at += TILE8_PIXELS) {
      tiles.push(base64(unplane(data.subarray(at, at + TILE8_PIXELS), 8, 8)));
    }
  }
  writeJSON(directory, 'tile8.json', {
    format: FORMAT, size: 8, count: tiles.length,
    what: 'the 8x8 tiles the status bar and the menus are framed with; the chunk states no size, so it was derived (NOTES.md para 3)',
    tiles
  });

  const texts = [];
  const demos = [];
  const screens = [];
  for (let chunk = layout.startExterns; chunk < container.count; chunk++) {
    const data = container.expand(chunk);
    if (!data) continue;
    const name = nameOf(chunk);
    if (looksLikeText(data)) {
      texts.push({ chunk, name, bytes: data.length, text: new TextDecoder('latin1').decode(data) });
    } else if (looksLikeTextScreen(data)) {
      screens.push({ chunk, name, bytes: data.length, cells: base64(data) });
    } else {
      const demo = parseDemo(data);
      demos.push({ chunk, name, number: demos.length, bytes: data.length, level: demo.level, tics: demo.tics,
        steps: demo.steps, plausible: demo.plausible, record: base64(data) });
    }
  }
  const unsound = demos.filter((demo) => !demo.plausible);
  if (unsound.length) {
    throw new Error(`chunks ${unsound.map((demo) => demo.chunk).join(', ')} are neither text nor a demo`);
  }
  writeJSON(out, 'texts.json', {
    format: FORMAT, count: texts.length, screens: screens.length,
    what: 'the story and help pages of VGAGRAPH in the original\'s own markup, and the two screens it prints in text mode on the way out (80x25 of a character and an attribute)',
    texts,
    textScreens: screens
  });
  writeJSON(out, 'demos.json', {
    format: FORMAT, count: demos.length, tics: DEMOTICS, rate: 70,
    what: 'the recorded demos: a level, a length, a spare byte, then three bytes a step - buttons, turn, walk - each step lasting DEMOTICS tics',
    demos
  });

  if (png) {
    writeFile(directory, 'tile8.png', sheet(tiles, 8, 16, palette, null));
    writeFile(directory, 'pics.png', picsSheet(pictures, palette));
  }

  report(`graphics    ${pictures.filter(Boolean).length} pictures, ${fonts.length} fonts, ${tiles.length} tile8, ` +
    `${texts.length} texts, ${demos.length} demos -> data/gfx, data/texts.json, data/demos.json`);
  return {
    pictures: pictures.filter(Boolean).length, fonts: fonts.length, tiles: tiles.length,
    texts: texts.length, textScreens: screens.length,
    demos: demos.map((demo) => ({ chunk: demo.chunk, level: demo.level, tics: demo.tics, steps: demo.steps }))
  };
}

/** The pictures under each other, widest first, as one PNG for the eye. */
function picsSheet (pictures, palette) {
  const kept = pictures.filter(Boolean);
  const width = Math.max(...kept.map((picture) => picture.width), 1);
  const height = kept.reduce((sum, picture) => sum + picture.height + 1, 0);
  const pixels = new Uint8Array(width * height);
  let y = 0;
  for (const picture of kept) {
    const bytes = Buffer.from(picture.pixels, 'base64');
    for (let line = 0; line < picture.height; line++) {
      pixels.set(bytes.subarray(line * picture.width, (line + 1) * picture.width), (y + line) * width);
    }
    y += picture.height + 1;
  }
  return encodeIndexedPNG(width, height, pixels, rgb8(palette));
}

// ---------------------------------------------------------------- the audio

function makeAudio (inDirectory, out, report) {
  const audio = openAudio(read(inDirectory, 'AUDIOHED'), read(inDirectory, 'AUDIOT'));
  const directory = join(out, 'sounds');

  const adlib = [];
  const speaker = [];
  for (let index = 0; index < audio.sounds; index++) {
    const fmChunk = audio.chunkOf(audio.startAdLib + index);
    if (fmChunk) {
      const sound = parseAdLibSound(fmChunk);
      adlib.push({
        index, name: sound.name, priority: sound.priority, octave: sound.octave,
        instrument: Array.from(sound.instrumentBytes), length: sound.length,
        seconds: sound.length / PC_RATE, data: base64(sound.data)
      });
    } else adlib.push(null);
    const pcChunk = audio.chunkOf(audio.startPC + index);
    if (pcChunk) {
      const sound = parsePCSound(pcChunk);
      speaker.push({ index, name: sound.name, priority: sound.priority, length: sound.length,
        seconds: sound.length / PC_RATE, data: base64(sound.data) });
    } else speaker.push(null);
  }
  writeJSON(directory, 'adlib.json', {
    format: FORMAT, rate: PC_RATE, count: adlib.filter(Boolean).length,
    what: 'the AdLib effects: sixteen bytes of instrument, an octave, then one byte of note per 1/140 s',
    sounds: adlib
  });
  writeJSON(directory, 'pc.json', {
    format: FORMAT, rate: PC_RATE, clock: 0x1234dd, count: speaker.filter(Boolean).length,
    what: 'the PC speaker effects: one divisor per 1/140 s',
    sounds: speaker
  });

  const tracks = [];
  for (let index = 0; index < audio.tracks; index++) {
    const chunk = audio.chunkOf(audio.startMusic + index);
    if (!chunk) { tracks.push(null); continue; }
    const track = parseIMF(chunk);
    if (!track.present) { tracks.push({ index, name: track.name, present: false }); continue; }
    const stream = new Uint8Array(track.writes.length * 4);
    track.writes.forEach((write, at) => {
      stream[at * 4] = write.register;
      stream[at * 4 + 1] = write.value;
      stream[at * 4 + 2] = write.delay & 0xff;
      stream[at * 4 + 3] = (write.delay >> 8) & 0xff;
    });
    const file = `music/track${number(index, 2)}`;
    writeJSON(join(out, 'music'), `track${number(index, 2)}.json`, {
      format: FORMAT, index, name: track.name, rate: IMF_RATE,
      writes: track.writes.length, ticks: track.ticks, seconds: track.seconds,
      what: 'IMF: register, value, delay in 1/700 s, four bytes each - the OPL2 as the original drove it',
      stream: base64(stream)
    });
    tracks.push({ index, name: track.name, present: true, writes: track.writes.length, seconds: track.seconds, file });
  }
  writeJSON(out, 'music.json', {
    format: FORMAT, rate: IMF_RATE, count: tracks.filter((track) => track && track.present).length,
    slots: tracks.length, tracks
  });

  report(`audio       ${adlib.filter(Boolean).length} AdLib effects, ${speaker.filter(Boolean).length} PC speaker, ` +
    `${tracks.filter((track) => track && track.present).length} tracks -> data/sounds, data/music`);
  return {
    adlib: adlib.filter(Boolean).length,
    speaker: speaker.filter(Boolean).length,
    tracks: tracks.filter((track) => track && track.present).length
  };
}

// -------------------------------------------------------------------- files

let inputs = {};
function read (directory, name) {
  const file = join(directory, `${name}.${EXTENSION}`);
  const bytes = new Uint8Array(readFileSync(file));
  inputs[`${name}.${EXTENSION}`] = { bytes: bytes.length, sha256: sha256(bytes) };
  return bytes;
}

export function make (options, report = () => {}) {
  inputs = {};
  rmSync(options.out, { recursive: true, force: true });
  mkdirSync(options.out, { recursive: true });

  const exeBytes = new Uint8Array(readFileSync(join(options.in, 'WOLF3D.EXE')));
  inputs['WOLF3D.EXE'] = { bytes: exeBytes.length, sha256: sha256(exeBytes) };
  const exe = makeExe(exeBytes, options.out, report);

  const manifest = {
    format: FORMAT,
    tool: 'tools/mkdata.mjs',
    edition: 'shareware v1.4',
    from: options.in,
    made: new Date().toISOString().slice(0, 10),
    exe: { imageBytes: exe.imageBytes, paletteAt: exe.paletteAt, rndtableAt: exe.rndtableAt }
  };
  manifest.levels = makeLevels(options.in, options.out, report);
  manifest.graphics = makeGraphics(options.in, options.out, report, exe.palette, options.png);
  manifest.vswap = makeSwap(options.in, options.out, report, exe.palette, options.png);
  manifest.audio = makeAudio(options.in, options.out, report);
  manifest.sources = inputs;

  writeJSON(options.out, 'manifest.json', manifest);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  const report = options.quiet ? () => {} : (line) => console.log(line);
  const manifest = make(options, report);
  console.log(`mkdata.mjs: ${options.in} -> ${options.out}/ (${Object.keys(manifest.sources).length} files read)`);
}
