#!/usr/bin/env node
/**
 * renderview - draws frames of the game into PNG files, without a browser.
 *
 * It is the quickest way to see what the engine really does: the whole of
 * `app/` runs under Node (R-001), so this plays a level or one of the
 * recorded demos and writes out whichever frames are asked for - the same
 * bytes the browser would show, coloured with the same palette.
 *
 * usage:
 *   node tools/renderview.mjs [--level N | --demo 0..3] [--frames N]
 *                             [--shots 1,50,200] [--out build/view]
 *                             [--difficulty 0..3] [--scale 2]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, newGame, rgb8, option } from './lib/gamelib.mjs';
import { encodeIndexedPNG } from '../app/svision/tools/retro/png.mjs';

async function main () {
  const args = process.argv.slice(2);
  const demoArg = option(args, '--demo', null);
  const demo = demoArg === null ? undefined : parseInt(demoArg, 10);
  const level = parseInt(option(args, '--level', '0'), 10);
  const difficulty = parseInt(option(args, '--difficulty', '1'), 10);
  const frames = parseInt(option(args, '--frames', '300'), 10);
  const scale = parseInt(option(args, '--scale', '2'), 10);
  const out = join(ROOT, option(args, '--out', 'build/view'));
  const shots = option(args, '--shots', '1,30,120,300').split(',').map((value) => parseInt(value, 10));

  const { game, screen } = await newGame({ level, difficulty, demo });
  mkdirSync(out, { recursive: true });

  let frame = 0;
  let written = 0;
  while (!game.playstate && frame < frames) {
    game.playFrame(screen, 4);
    frame += 1;
    if (shots.indexOf(frame) < 0) continue;
    const file = join(out, `${demo === undefined ? 'level' + level : 'demo' + demo}-${String(frame).padStart(5, '0')}.png`);
    writeFileSync(file, encodeIndexedPNG(320, 200, screen.bytes, rgb8(game.paletteBytes()), { scale }));
    written += 1;
    console.log(`  ${file}  player ${game.player.tilex},${game.player.tiley} ` +
      `angle ${game.player.angle}, health ${game.gamestate.health}, ammo ${game.gamestate.ammo}`);
  }
  console.log(`renderview.mjs: ${written} frames of ${frame} written to ${option(args, '--out', 'build/view')}` +
    (game.playstate ? ` (the level ended: ${game.playstate})` : ''));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
