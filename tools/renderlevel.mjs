#!/usr/bin/env node
/**
 * renderlevel - draws a level from above, as a plan, so that a human can
 * see what the data says before anything is played.
 *
 * The plan is not a picture of the game; it is a picture of the **world the
 * game builds**, and it is built by the game's own code (`app/wolf/world.js`
 * through `WolfGame`), not by a reader of its own. So a wall is only drawn
 * where the engine has a wall, a door only where it spawned one, and a
 * guard only where he really stands after the ambush markers have been
 * rubbed out.
 *
 * Each tile is eight pixels. Walls are drawn in the colour of their own
 * texture (the middle pixel of it), so that a plan looks like the level;
 * doors are red, secret walls yellow, the things on the floor are their own
 * sprite's colours in a dot, and the guards are marked by kind.
 *
 * usage:
 *   node tools/renderlevel.mjs [--level N] [--all] [--difficulty 0..3]
 *                              [--out build/levelNN.png] [--scale 8]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ROOT, newGame, readData, rgb8, option, flag } from './lib/gamelib.mjs';
import { encodeIndexedPNG } from '../app/svision/tools/retro/png.mjs';

const MAPSIZE = 64;

/** What the plan paints things in, in the game's own palette. */
const COLOR = {
  floor: 0x19,          // the floor of the game
  door: 0x28,           // red
  secret: 0x38,         // yellow
  player: 0x7f,         // white
  guard: 0x40,
  officer: 0x50,
  ss: 0x60,
  dog: 0x6a,
  boss: 0x2c,
  dead: 0x1a,
  bonus: 0x53,
  blocking: 0x17,
  grid: 0x18
};

/** The colour a wall is drawn in: the middle of its own texture. */
function wallColor (assets, tile) {
  const page = (tile - 1) * 2;
  const texture = assets.walls[page];
  if (!texture) return COLOR.blocking;
  return texture[32 * 64 + 32];
}

/** One tile of the plan. */
function block (pixels, width, tx, ty, size, color) {
  for (let y = 0; y < size; y++) {
    const at = (ty * size + y) * width + tx * size;
    for (let x = 0; x < size; x++) pixels[at + x] = color;
  }
}

/** A smaller mark in the middle of a tile, for the things on the floor. */
function dot (pixels, width, tx, ty, size, color, inset) {
  const margin = inset === undefined ? Math.floor(size / 3) : inset;
  for (let y = margin; y < size - margin; y++) {
    const at = (ty * size + y) * width + tx * size;
    for (let x = margin; x < size - margin; x++) pixels[at + x] = color;
  }
}

async function renderLevel (number, difficulty, scale, assets) {
  const { game } = await newGame({ level: number, difficulty, assets });
  const world = game.world;
  const width = MAPSIZE * scale;
  const height = MAPSIZE * scale;
  const pixels = new Uint8Array(width * height).fill(COLOR.floor);

  for (let y = 0; y < MAPSIZE; y++) {
    for (let x = 0; x < MAPSIZE; x++) {
      const tile = world.tileAt(x, y);
      if (!tile) continue;
      if (tile & 0x80) {
        block(pixels, width, x, y, scale, (tile & 0x40) ? COLOR.secret : COLOR.door);
      } else {
        block(pixels, width, x, y, scale, wallColor(game.assets, tile & 63));
      }
    }
  }

  // the things on the floor, then the actors over them
  for (const statobj of world.statics) {
    if (statobj.shapenum === -1) continue;
    const solid = world.actorat[world.at(statobj.tilex, statobj.tiley)] === 1;
    dot(pixels, width, statobj.tilex, statobj.tiley, scale,
      (statobj.flags & 2) ? COLOR.bonus : (solid ? COLOR.blocking : COLOR.grid));
  }

  const kinds = { 3: COLOR.guard, 4: COLOR.officer, 5: COLOR.ss, 6: COLOR.dog, 7: COLOR.boss, 2: COLOR.dead };
  for (let i = 1; i < game.actors.length; i++) {
    const actor = game.actors[i];
    dot(pixels, width, actor.tilex, actor.tiley, scale, kinds[actor.obclass] || COLOR.guard, 1);
  }
  dot(pixels, width, game.player.tilex, game.player.tiley, scale, COLOR.player, 1);

  return {
    pixels, width, height, game,
    counts: {
      kills: game.gamestate.killtotal,
      treasure: game.gamestate.treasuretotal,
      secrets: game.gamestate.secrettotal,
      doors: world.doors.length,
      statics: world.statics.length,
      actors: game.actors.length - 1
    }
  };
}

async function main () {
  const args = process.argv.slice(2);
  const scale = parseInt(option(args, '--scale', '8'), 10);
  const difficulty = parseInt(option(args, '--difficulty', '1'), 10);
  const levels = flag(args, '--all')
    ? readData('levels').levels.map((level) => level.number)
    : [parseInt(option(args, '--level', '0'), 10)];

  const { assets } = await newGame({ level: levels[0], difficulty });
  for (const number of levels) {
    const pad = String(number).padStart(2, '0');
    const out = join(ROOT, option(args, '--out', `build/level${pad}.png`));
    const plan = await renderLevel(number, difficulty, scale, assets);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, encodeIndexedPNG(plan.width, plan.height, plan.pixels, rgb8(assets.palette)));
    const counts = plan.counts;
    console.log(`level ${pad} ${readData(`levels/level${pad}`).name.padEnd(12)} -> ${out}  ` +
      `${counts.actors} actors, ${counts.doors} doors, ${counts.statics} things; ` +
      `${counts.kills} to kill, ${counts.treasure} treasures, ${counts.secrets} secrets`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
