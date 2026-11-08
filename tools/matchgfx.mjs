#!/usr/bin/env node
/**
 * matchgfx - the acceptance of W2: what `data/` holds is what the game's
 * own files hold, byte for byte.
 *
 * Two kinds of check, and it is worth being plain about what each of them
 * is worth:
 *
 * 1. **against the original files** (always). Every texture, sprite,
 *    picture, font, tile, level plane, palette and sound is decoded again
 *    straight out of `sources/game/sw14/` by the W1 decoders and compared
 *    with what `mkdata.mjs` wrote. This catches a mistake anywhere between
 *    the container and the game - the planar order of the pictures, the
 *    column order of the walls, a base64 that lost a byte.
 * 2. **against the running original** (when it is there). The operator
 *    takes screenshots of the gallery and the levels in DOSBox and puts
 *    them in a directory; every one of them is compared with the same
 *    picture out of `data/`, pixel for pixel. Without them this part is
 *    reported as **not run** rather than passed - `../METHODOLOGY.md` is
 *    clear that a milestone is done when its `match*` says zero, and
 *    nothing can say zero about a comparison it never made.
 *
 * usage:
 *   node tools/matchgfx.mjs [--in sources/game/sw14] [--data data]
 *                           [--screens sources/media/dosbox] [--quiet]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readLevels, PLANE_BYTES } from './lib/gameMaps.mjs';
import { deriveLayout, openGraph, TILE8_PIXELS } from './lib/vgaGraph.mjs';
import { openSwap, decodeWall, decodeSprite, soundTable, readSound, TEXTURE_SIZE } from './lib/vswap.mjs';
import { openAudio, parseAdLibSound, parsePCSound, parseIMF } from './lib/audioT.mjs';
import { readExeTables } from './lib/exeTables.mjs';
import { ROOT, option, flag, report } from './lib/gamelib.mjs';
import { decodePNG } from '../app/svision/tools/retro/png.mjs';

const EXTENSION = 'WL1';

const read = (directory, name) => new Uint8Array(readFileSync(join(directory, `${name}.${EXTENSION}`)));
const json = (directory, name) => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
const bytes = (base64) => new Uint8Array(Buffer.from(base64, 'base64'));

/** Compares two runs of bytes and says where the first difference is. */
function differ (mine, theirs) {
  if (mine.length !== theirs.length) return `${mine.length} bytes against ${theirs.length}`;
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] !== theirs[i]) return `byte ${i}: ${mine[i]} against ${theirs[i]}`;
  }
  return null;
}

/** The planar picture of VGAGRAPH put back into rows, as mkdata does it. */
function unplane (data, width, height) {
  const quarter = width / 4;
  const pixels = new Uint8Array(width * height);
  for (let plane = 0; plane < 4; plane++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < quarter; x++) {
        pixels[y * width + x * 4 + plane] = data[plane * quarter * height + y * quarter + x];
      }
    }
  }
  return pixels;
}

function checkExe (inDirectory, dataDirectory, note) {
  const tables = readExeTables(new Uint8Array(readFileSync(join(inDirectory, 'WOLF3D.EXE'))));
  let checks = 0;
  let differences = 0;

  const palette = json(dataDirectory, 'palette');
  const mine = bytes(palette.bytes);
  checks += 1;
  const paletteDiff = differ(mine, tables.palette);
  if (paletteDiff) { differences += 1; note(`palette: ${paletteDiff}`); }

  const random = json(dataDirectory, 'random');
  checks += 1;
  const randomDiff = differ(bytes(random.bytes), tables.rndtable);
  if (randomDiff) { differences += 1; note(`rndtable: ${randomDiff}`); }

  return { checks, differences, what: 'palette and rndtable out of WOLF3D.EXE' };
}

function checkSwap (inDirectory, dataDirectory, note) {
  const swap = openSwap(read(inDirectory, 'VSWAP'));
  const walls = json(dataDirectory, 'gfx/walls');
  const sprites = json(dataDirectory, 'gfx/sprites');
  const digi = json(dataDirectory, 'sounds/digi');
  let checks = 0;
  let differences = 0;

  for (let chunk = 0; chunk < swap.firstSprite; chunk++) {
    const raw = swap.chunkOf(chunk);
    const mine = walls.textures[chunk];
    if (!raw) {
      if (mine !== null) { differences += 1; note(`wall ${chunk} is in data but not in VSWAP`); }
      continue;
    }
    checks += 1;
    const wrong = differ(bytes(mine), decodeWall(raw));
    if (wrong) { differences += 1; note(`wall ${chunk}: ${wrong}`); }
  }

  for (let chunk = swap.firstSprite; chunk < swap.firstSound; chunk++) {
    const raw = swap.chunkOf(chunk);
    const at = chunk - swap.firstSprite;
    const mine = sprites.sprites[at];
    if (!raw) {
      if (mine !== null) { differences += 1; note(`sprite ${at} is in data but not in VSWAP`); }
      continue;
    }
    checks += 1;
    const wrong = differ(bytes(mine), decodeSprite(raw));
    if (wrong) { differences += 1; note(`sprite ${at}: ${wrong}`); }
  }

  for (const entry of soundTable(swap)) {
    const mine = digi.sounds[entry.index];
    if (!entry.present) {
      if (mine !== null) { differences += 1; note(`digitised sound ${entry.index} is in data but not in VSWAP`); }
      continue;
    }
    checks += 1;
    const wrong = differ(bytes(mine.pcm), readSound(swap, entry));
    if (wrong) { differences += 1; note(`digitised sound ${entry.index}: ${wrong}`); }
  }

  return { checks, differences, what: 'walls, sprites and digitised sounds against VSWAP' };
}

function checkGraphics (inDirectory, dataDirectory, note) {
  const head = read(inDirectory, 'VGAHEAD');
  const dict = read(inDirectory, 'VGADICT');
  const graph = read(inDirectory, 'VGAGRAPH');
  const layout = deriveLayout(head, dict, graph);
  const container = openGraph(head, dict, graph, layout.startTile8, layout.tile8Size);
  const pics = json(dataDirectory, 'gfx/pics');
  const fonts = json(dataDirectory, 'gfx/fonts');
  const tiles = json(dataDirectory, 'gfx/tile8');
  let checks = 0;
  let differences = 0;

  layout.pictures.forEach((picture, at) => {
    const data = container.expand(layout.startPics + at);
    const mine = pics.pictures[at];
    checks += 1;
    if (!mine) { differences += 1; note(`picture ${at} is missing from data`); return; }
    if (mine.width !== picture.width || mine.height !== picture.height) {
      differences += 1;
      note(`picture ${at}: ${mine.width}x${mine.height} against ${picture.width}x${picture.height}`);
      return;
    }
    const wrong = differ(bytes(mine.pixels), unplane(data, picture.width, picture.height));
    if (wrong) { differences += 1; note(`picture ${at} (${mine.name}): ${wrong}`); }
  });

  for (let i = 0; i < layout.fonts; i++) {
    const data = container.expand(layout.startFont + i);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const mine = fonts.fonts[i];
    checks += 1;
    if (!mine) { differences += 1; note(`font ${i} is missing from data`); continue; }
    if (mine.height !== view.getUint16(0, true)) {
      differences += 1;
      note(`font ${i}: height ${mine.height} against ${view.getUint16(0, true)}`);
      continue;
    }
    let wrongGlyphs = 0;
    for (let code = 0; code < 256; code++) {
      const width = data[2 + 512 + code];
      const start = view.getUint16(2 + code * 2, true);
      const glyph = mine.glyphs[code];
      if (!width || !start) {
        if (glyph) wrongGlyphs += 1;
        continue;
      }
      if (!glyph || glyph.width !== width) { wrongGlyphs += 1; continue; }
      if (differ(bytes(glyph.pixels), data.subarray(start, start + width * mine.height))) wrongGlyphs += 1;
    }
    if (wrongGlyphs) { differences += 1; note(`font ${i}: ${wrongGlyphs} glyphs differ`); }
  }

  if (layout.startTile8 !== null) {
    const data = container.expand(layout.startTile8);
    const count = data.length / TILE8_PIXELS;
    checks += 1;
    if (tiles.tiles.length !== count) {
      differences += 1;
      note(`tile8: ${tiles.tiles.length} tiles against ${count}`);
    } else {
      let wrongTiles = 0;
      for (let at = 0; at < count; at++) {
        const theirs = unplane(data.subarray(at * TILE8_PIXELS, (at + 1) * TILE8_PIXELS), 8, 8);
        if (differ(bytes(tiles.tiles[at]), theirs)) wrongTiles += 1;
      }
      if (wrongTiles) { differences += 1; note(`tile8: ${wrongTiles} tiles differ`); }
    }
  }

  return { checks, differences, what: 'pictures, fonts and tiles against VGAGRAPH' };
}

function checkLevels (inDirectory, dataDirectory, note) {
  const { levels } = readLevels(read(inDirectory, 'MAPHEAD'), read(inDirectory, 'GAMEMAPS'));
  let checks = 0;
  let differences = 0;
  for (const level of levels) {
    const mine = json(dataDirectory, `levels/level${String(level.number).padStart(2, '0')}`);
    for (let plane = 0; plane < 3; plane++) {
      const theirs = level.planes[plane];
      const kept = mine.planes[plane];
      if (!theirs || theirs.data.length !== PLANE_BYTES) {
        if (kept !== null) { differences += 1; note(`level ${level.number} plane ${plane} is in data but not in the map`); }
        continue;
      }
      checks += 1;
      const wrong = differ(bytes(kept), theirs.data);
      if (wrong) { differences += 1; note(`level ${level.number} plane ${plane}: ${wrong}`); }
    }
    checks += 1;
    if (mine.name !== level.header.name) {
      differences += 1;
      note(`level ${level.number}: named "${mine.name}" against "${level.header.name}"`);
    }
  }
  return { checks, differences, what: 'the planes and names of the ten levels' };
}

function checkAudio (inDirectory, dataDirectory, note) {
  const audio = openAudio(read(inDirectory, 'AUDIOHED'), read(inDirectory, 'AUDIOT'));
  const adlib = json(dataDirectory, 'sounds/adlib');
  const speaker = json(dataDirectory, 'sounds/pc');
  const music = json(dataDirectory, 'music');
  let checks = 0;
  let differences = 0;

  for (let index = 0; index < audio.sounds; index++) {
    const fm = audio.chunkOf(audio.startAdLib + index);
    if (fm) {
      const sound = parseAdLibSound(fm);
      const mine = adlib.sounds[index];
      checks += 1;
      if (!mine) { differences += 1; note(`AdLib effect ${index} is missing from data`); } else {
        const wrong = differ(bytes(mine.data), sound.data) ||
          differ(Uint8Array.from(mine.instrument), sound.instrumentBytes);
        if (wrong || mine.priority !== sound.priority || mine.octave !== sound.octave) {
          differences += 1;
          note(`AdLib effect ${index}: ${wrong || 'priority or octave differs'}`);
        }
      }
    }
    const pc = audio.chunkOf(audio.startPC + index);
    if (pc) {
      const sound = parsePCSound(pc);
      const mine = speaker.sounds[index];
      checks += 1;
      if (!mine) { differences += 1; note(`PC speaker effect ${index} is missing from data`); } else {
        const wrong = differ(bytes(mine.data), sound.data);
        if (wrong || mine.priority !== sound.priority) {
          differences += 1;
          note(`PC speaker effect ${index}: ${wrong || 'priority differs'}`);
        }
      }
    }
  }

  for (let index = 0; index < audio.tracks; index++) {
    const chunk = audio.chunkOf(audio.startMusic + index);
    if (!chunk) continue;
    const track = parseIMF(chunk);
    if (!track.present) continue;
    checks += 1;
    const mine = json(dataDirectory, `music/track${String(index).padStart(2, '0')}`);
    const stream = bytes(mine.stream);
    if (stream.length !== track.writes.length * 4) {
      differences += 1;
      note(`track ${index}: ${stream.length / 4} writes against ${track.writes.length}`);
      continue;
    }
    let wrongWrites = 0;
    track.writes.forEach((write, at) => {
      if (stream[at * 4] !== write.register || stream[at * 4 + 1] !== write.value ||
          (stream[at * 4 + 2] | (stream[at * 4 + 3] << 8)) !== write.delay) wrongWrites += 1;
    });
    if (wrongWrites) { differences += 1; note(`track ${index}: ${wrongWrites} writes differ`); }
    const listed = music.tracks[index];
    if (!listed || listed.name !== track.name) {
      differences += 1;
      note(`track ${index}: named "${listed && listed.name}" against "${track.name}"`);
    }
  }

  return { checks, differences, what: 'the effects and the music against AUDIOT' };
}

/**
 * The pictures of `data/` against screenshots taken in DOSBox. A file is
 * expected to be named after the chunk it shows - `STATUSBARPIC.png` - and
 * to be the picture on its own, in the game's palette.
 */
function checkScreens (dataDirectory, screensDirectory, note) {
  const pics = json(dataDirectory, 'gfx/pics');
  const palette = bytes(json(dataDirectory, 'palette').bytes);
  const files = readdirSync(screensDirectory).filter((file) => file.toLowerCase().endsWith('.png'));
  let checks = 0;
  let differences = 0;

  for (const file of files) {
    const name = file.replace(/\.png$/i, '').toUpperCase();
    const picture = pics.pictures.find((entry) => entry && entry.name === name);
    if (!picture) { note(`${file}: no picture of that name in data`); continue; }
    const shot = decodePNG(readFileSync(join(screensDirectory, file)));
    checks += 1;
    if (shot.width !== picture.width || shot.height !== picture.height) {
      differences += 1;
      note(`${file}: ${shot.width}x${shot.height} against ${picture.width}x${picture.height}`);
      continue;
    }
    const mine = bytes(picture.pixels);
    let wrongPixels = 0;
    for (let at = 0; at < mine.length; at++) {
      const index = mine[at];
      const r = ((palette[index * 3] << 2) | (palette[index * 3] >> 4)) & 0xff;
      const g = ((palette[index * 3 + 1] << 2) | (palette[index * 3 + 1] >> 4)) & 0xff;
      const b = ((palette[index * 3 + 2] << 2) | (palette[index * 3 + 2] >> 4)) & 0xff;
      if (shot.rgba[at * 4] !== r || shot.rgba[at * 4 + 1] !== g || shot.rgba[at * 4 + 2] !== b) wrongPixels += 1;
    }
    if (wrongPixels) { differences += 1; note(`${file}: ${wrongPixels} pixels differ`); }
  }
  return { checks, differences, what: `${files.length} screenshots from DOSBox` };
}

function main () {
  const args = process.argv.slice(2);
  const inDirectory = join(ROOT, option(args, '--in', 'sources/game/sw14'));
  const dataDirectory = join(ROOT, option(args, '--data', 'data'));
  const screensDirectory = option(args, '--screens', 'sources/media/dosbox');
  const quiet = flag(args, '--quiet');
  const problems = [];
  const note = (line) => problems.push(line);

  const parts = [
    checkExe(inDirectory, dataDirectory, note),
    checkSwap(inDirectory, dataDirectory, note),
    checkGraphics(inDirectory, dataDirectory, note),
    checkLevels(inDirectory, dataDirectory, note),
    checkAudio(inDirectory, dataDirectory, note)
  ];

  const screens = join(ROOT, screensDirectory);
  let screenPart = null;
  if (existsSync(screens)) {
    screenPart = checkScreens(dataDirectory, screens, note);
    parts.push(screenPart);
  }

  let checks = 0;
  let differences = 0;
  for (const part of parts) {
    checks += part.checks;
    differences += part.differences;
    if (!quiet) console.log(`  ${String(part.checks).padStart(6)} ${part.what}`);
  }
  if (!screenPart && !quiet) {
    console.log('       - against DOSBox: no screenshots in ' + screensDirectory + ', that part was NOT run');
  }
  for (const problem of problems.slice(0, 20)) console.log(`  ! ${problem}`);
  if (problems.length > 20) console.log(`  ! and ${problems.length - 20} more`);

  const passed = report('matchgfx.mjs', checks, differences,
    screenPart ? `${screenPart.checks} of them against DOSBox` : 'against the game\'s own files; DOSBox part not run');
  process.exit(passed ? 0 : 1);
}

main();
