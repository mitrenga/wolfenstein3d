#!/usr/bin/env node
/**
 * matchframes - the acceptance of W4: the whole picture, byte for byte.
 *
 * A frame of Wolfenstein is 64 000 bytes of video memory, and this compares
 * all of them: the walls the caster drew, the things over them, the weapon
 * in the player's hands and the status bar under it.
 *
 * What it is held against:
 *
 * - **`--reference <dir>`**: frames captured from the original in DOSBox,
 *   as raw 64 000 byte files named `frame00000.bin` (or PNGs in the game's
 *   palette). That is the acceptance of the milestone.
 * - **`--record <dir>`**: writes our own frames there instead. Held against
 *   later, that is a **regression** - it says the remake still draws what it
 *   drew yesterday, not that it draws what the original drew. The report
 *   says which of the two it did.
 *
 * usage:
 *   node tools/matchframes.mjs [--demo 0..3] [--frames N] [--every N]
 *                              [--record build/frames0] [--reference ...]
 *                              [--png] [--quiet]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ROOT, newGame, rgb8, option, flag, report } from './lib/gamelib.mjs';
import { encodeIndexedPNG, decodePNG } from '../app/svision/tools/retro/png.mjs';

const FRAME_BYTES = 64000;
const name = (frame) => `frame${String(frame).padStart(5, '0')}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Plays a demo and hands every frame to whoever wants it. */
async function play (options, onFrame) {
  const { game, screen, assets } = await newGame({ demo: options.demo, difficulty: 3 });
  let frame = 0;
  while (!game.playstate && frame < options.frames) {
    game.playFrame(screen, 4);
    frame += 1;
    if (frame % options.every === 0) onFrame(frame, screen, game, assets);
  }
  return frame;
}

async function main () {
  const args = process.argv.slice(2);
  const options = {
    demo: parseInt(option(args, '--demo', '0'), 10),
    frames: parseInt(option(args, '--frames', '400'), 10),
    every: parseInt(option(args, '--every', '10'), 10),
    record: option(args, '--record', null),
    reference: option(args, '--reference', null),
    png: flag(args, '--png'),
    quiet: flag(args, '--quiet')
  };

  if (options.record) {
    const out = join(ROOT, options.record);
    mkdirSync(out, { recursive: true });
    let written = 0;
    const total = await play(options, (frame, screen, game, assets) => {
      writeFileSync(join(out, `${name(frame)}.bin`), Buffer.from(screen.bytes));
      if (options.png) {
        writeFileSync(join(out, `${name(frame)}.png`),
          encodeIndexedPNG(320, 200, screen.bytes, rgb8(game.paletteBytes())));
      }
      written += 1;
    });
    console.log(`matchframes.mjs: ${written} of ${total} frames written to ${options.record}`);
    return;
  }

  const directory = options.reference ? join(ROOT, options.reference) : null;
  if (!directory || !existsSync(directory)) {
    // nothing to hold it against: say so, and check the one thing that can
    // be checked without a reference - that the same run draws the same
    // frames twice over
    const first = [];
    await play(options, (frame, screen) => first.push(sha(screen.bytes)));
    const second = [];
    await play(options, (frame, screen) => second.push(sha(screen.bytes)));
    let differences = 0;
    for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) differences += 1;
    if (!options.quiet) {
      console.log(`  no frames to compare against in ${options.reference || 'build/frames'}`);
      console.log('  what was checked instead: the same demo drawn twice gives the same bytes');
    }
    report('matchframes.mjs', first.length, differences,
      'the run is repeatable; against DOSBox NOT run');
    process.exit(differences === 0 ? 0 : 1);
  }

  const files = readdirSync(directory).filter((file) => /\.(bin|png)$/i.test(file)).sort();
  let checks = 0;
  let differences = 0;
  const problems = [];
  await play(options, (frame, screen) => {
    const bin = join(directory, `${name(frame)}.bin`);
    const png = join(directory, `${name(frame)}.png`);
    let theirs = null;
    if (existsSync(bin)) theirs = new Uint8Array(readFileSync(bin));
    else if (existsSync(png)) {
      const picture = decodePNG(readFileSync(png));
      if (picture.indexed) theirs = picture.indexed;
    }
    if (!theirs || theirs.length !== FRAME_BYTES) return;
    checks += 1;
    let wrong = 0;
    for (let at = 0; at < FRAME_BYTES; at++) if (screen.bytes[at] !== theirs[at]) wrong += 1;
    if (wrong) {
      differences += 1;
      if (problems.length < 10) problems.push(`${name(frame)}: ${wrong} pixels of ${FRAME_BYTES}`);
    }
  });

  for (const problem of problems) console.log(`  ! ${problem}`);
  const passed = report('matchframes.mjs', checks, differences,
    `${files.length} frames in ${options.reference}`);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
