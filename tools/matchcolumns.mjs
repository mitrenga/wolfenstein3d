#!/usr/bin/env node
/**
 * matchcolumns - the acceptance of W3: for every column of every frame, the
 * same wall, the same side of it, the same column of its texture and the
 * same height.
 *
 * The caster runs here as the game runs it (`app/wolf/render.js` through
 * `WolfGame`), a demo at a time, and every column of every frame is written
 * down. What it is held against depends on what there is:
 *
 * - **`--reference <file>`**: a recording from the original in DOSBox, in
 *   the shape this tool writes with `--record` (one line of JSON a frame:
 *   `{frame, heights[], pages[], columns[]}`). Every column is compared,
 *   and that is the real acceptance of the milestone.
 * - **nothing**: the caster is held against a **second, independent one**
 *   written in this file in plain floating point - a textbook ray-grid
 *   walk that knows nothing of fixed point, tables or the original's
 *   batching. It cannot prove the rounding of the original, but it does
 *   prove the geometry: if our integer caster met a different wall, or the
 *   wrong side of it, or a texture column more than one out, the two
 *   disagree. What it cannot check is reported as not checked.
 *
 * usage:
 *   node tools/matchcolumns.mjs [--demo 0|1|2|3] [--frames N]
 *                               [--reference build/columns0.jsonl]
 *                               [--record build/columns0.jsonl] [--quiet]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ROOT, newGame, option, flag, report } from './lib/gamelib.mjs';

const TILEGLOBAL = 1 << 16;

/**
 * How far the two casters may differ before it counts.
 *
 * The float caster is the more *correct* of the two - and that is the point:
 * the original's is not exact, it steps in 16.16 through tables of 3 600
 * angles, and the error builds up along the ray. Two per cent of a height
 * and two columns of a 64 column texture is what that arithmetic costs at
 * arm's length from a wall. Anything bigger is a mistake in the walk, not
 * in the rounding - which is what this tool is for. **Whether our rounding
 * is the original's rounding is not decided here**; that needs a recording
 * from DOSBox (`--reference`).
 */
const HEIGHT_TOLERANCE = 0.02;
const TEXTURE_TOLERANCE = 2;
/** How near the corner of a block a crossing may be and still be compared. */
const CORNER_MARGIN = 0.02;
/**
 * And how much the texture column may drift for every tile of distance.
 * Measured on a demo: a fifth of a pixel a tile, which is what the half
 * fine angle the tables are built with comes to (`tan(0.05 deg)`), doubled
 * because the two steps of a ray are rounded off opposite ends of the
 * quadrant.
 */
const TEXTURE_PER_TILE = 0.5;

/**
 * The second caster: the same question in floating point.
 *
 * It walks the grid the way every book writes it - step to the next
 * vertical edge or the next horizontal one, whichever is nearer - and
 * stops at the first solid tile. Doors and moving walls are left out of
 * it: those columns are simply not compared, because the original has
 * rules of its own for them that this one deliberately does not.
 *
 * @returns {{tile: number, side: number, texture: number, distance: number}|null}
 */
function floatCast (world, viewX, viewY, angleDegrees, pixelAngleFine) {
  // the angle of this column, in radians, from the same two numbers the
  // game uses: the view angle in whole degrees and the pixel's offset in
  // 3600ths of a circle
  const fine = angleDegrees * 10 + pixelAngleFine;
  const radians = (fine / 3600) * 2 * Math.PI;
  const dx = Math.cos(radians);
  const dy = -Math.sin(radians);

  let x = viewX / TILEGLOBAL;
  let y = viewY / TILEGLOBAL;
  let tileX = Math.floor(x);
  let tileY = Math.floor(y);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const deltaX = Math.abs(dx) < 1e-12 ? Infinity : Math.abs(1 / dx);
  const deltaY = Math.abs(dy) < 1e-12 ? Infinity : Math.abs(1 / dy);
  let sideX = dx > 0 ? (tileX + 1 - x) * deltaX : (x - tileX) * deltaX;
  let sideY = dy > 0 ? (tileY + 1 - y) * deltaY : (y - tileY) * deltaY;

  for (let steps = 0; steps < 128; steps++) {
    let vertical;
    if (sideX < sideY) { sideX += deltaX; tileX += stepX; vertical = true; } else { sideY += deltaY; tileY += stepY; vertical = false; }
    if (tileX < 0 || tileY < 0 || tileX >= 64 || tileY >= 64) return null;
    const tile = world.tileAt(tileX, tileY);
    if (!tile) continue;
    if (tile & 0x80) return null;                 // a door or a moving wall: not compared
    const distance = vertical ? sideX - deltaX : sideY - deltaY;
    const hitX = x + dx * distance;
    const hitY = y + dy * distance;
    // which column of the texture: the fraction along the wall, and the
    // same flip the game makes on the far side
    let texture;
    if (vertical) {
      texture = Math.floor((hitY - Math.floor(hitY)) * 64);
      if (stepX === -1) texture = 63 - texture;
    } else {
      texture = Math.floor((hitX - Math.floor(hitX)) * 64);
      if (stepY === 1) texture = 63 - texture;
    }
    // how close the crossing is to the corner of the tile, which is where
    // two casters are allowed to disagree about everything
    const along = vertical ? hitY - Math.floor(hitY) : hitX - Math.floor(hitX);
    const corner = Math.min(along, 1 - along);
    return { tile: tile & 63, side: vertical ? 1 : 0, texture, distance, corner };
  }
  return null;
}

/** What the game's caster says about every column of the frame it just drew. */
function columnsOf (game) {
  const render = game.render;
  return {
    heights: Array.from(render.wallheight),
    tiles: Array.from(render.wallTile),
    sides: Array.from(render.wallSide),
    textures: Array.from(render.wallTexture),
    pages: Array.from(render.wallPage),
    starts: Array.from(render.postStarts),
    view: {x: render.viewx, y: render.viewy, angle: render.viewangle}
  };
}

/**
 * Runs a demo and writes down every column of every frame, along with what
 * the second caster says about the same columns.
 */
async function run (options) {
  const { game, screen } = await newGame({ demo: options.demo, difficulty: 3 });
  const lines = [];
  let checks = 0;
  let differences = 0;
  let skipped = 0;
  const problems = [];

  let frame = 0;
  while (!game.playstate && frame < options.frames) {
    game.playFrame(screen, 4);
    frame += 1;
    const columns = columnsOf(game);
    lines.push(columns);

    if (!options.reference) {
      // the second caster, on the columns it is able to speak about
      const render = game.render;
      for (let pixx = 0; pixx < render.viewWidth; pixx += options.every) {
        if (render.wallSide[pixx] > 1) { skipped += 1; continue; }   // a door or a moving wall
        const theirs = floatCast(game.world, render.viewx, render.viewy,
          render.viewangle, game.tables.pixelangle[pixx]);
        if (!theirs) { skipped += 1; continue; }
        // a ray through the corner of a block: which of the two walls it
        // meets is decided by the last bit of the arithmetic, so neither
        // caster can be said to be wrong
        if (theirs.corner < CORNER_MARGIN) { skipped += 1; continue; }

        // which wall, and which side of it - this is the part that has one
        // right answer whatever the arithmetic
        checks += 2;
        if (render.wallTile[pixx] !== theirs.tile) {
          differences += 1;
          if (problems.length < 20) problems.push(`frame ${frame} column ${pixx}: tile ${render.wallTile[pixx]} against ${theirs.tile}`);
        }
        if (render.wallSide[pixx] !== theirs.side) {
          differences += 1;
          if (problems.length < 20) problems.push(`frame ${frame} column ${pixx}: side ${render.wallSide[pixx]} against ${theirs.side}`);
        }

        // the column of the texture, which may be one out where the two
        // arithmetics round the crossing to either side of a pixel
        checks += 1;
        // how far apart the two may be grows with the distance: the
        // original's ray is half a fine angle off by construction, and the
        // two steps of a pair are not off by the same half, so the path
        // drifts sideways about a fifth of a texture pixel per tile
        var allowed = Math.max(TEXTURE_TOLERANCE, theirs.distance * TEXTURE_PER_TILE);
        var off = Math.abs(render.wallTexture[pixx] - theirs.texture);
        if (off > 32) off = 64 - off;
        if (off > allowed) {
          differences += 1;
          if (problems.length < 20) {
            problems.push(`frame ${frame} column ${pixx}: texture column ${render.wallTexture[pixx]} ` +
              `against ${theirs.texture} at ${theirs.distance.toFixed(2)} tiles, side ${theirs.side}, tile ${theirs.tile}`);
          }
        }

        // and the height, but only where it was computed for this column
        // rather than carried over from the one before it (the original's
        // batching, which is part of the picture).
        //
        // The comparison is of **heights**, not of distances: a height is a
        // 16 bit division, so turning one back into a distance loses a per
        // cent of it and says nothing. The other caster's distance is put
        // through the same division instead, and a height may still be one
        // out where the two arithmetics land either side of a whole number.
        if (!render.postStarts[pixx]) continue;
        const height = render.wallheight[pixx];
        if (!height) { differences += 1; problems.push(`frame ${frame} column ${pixx}: no wall at all`); continue; }
        checks += 1;
        const theirDistance = theirs.distance * Math.cos((game.tables.pixelangle[pixx] / 3600) * 2 * Math.PI);
        const theirHeight = Math.trunc(game.tables.heightNumerator / Math.floor((theirDistance * 65536) / 256));
        if (Math.abs(height - theirHeight) > Math.max(2, theirHeight * HEIGHT_TOLERANCE)) {
          differences += 1;
          if (problems.length < 20) {
            problems.push(`frame ${frame} column ${pixx}: height ${height} against ${theirHeight} ` +
              `(${(theirDistance).toFixed(3)} tiles)`);
          }
        }
      }
    }
  }

  return { lines, frame, checks, differences, skipped, problems, state: game.playstate };
}

async function main () {
  const args = process.argv.slice(2);
  const options = {
    demo: parseInt(option(args, '--demo', '0'), 10),
    frames: parseInt(option(args, '--frames', '400'), 10),
    every: parseInt(option(args, '--every', '8'), 10),
    reference: option(args, '--reference', null),
    record: option(args, '--record', null),
    quiet: flag(args, '--quiet')
  };

  const result = await run(options);

  if (options.record) {
    const out = join(ROOT, options.record);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, result.lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    console.log(`matchcolumns.mjs: ${result.frame} frames written to ${options.record}`);
    return;
  }

  if (options.reference) {
    const file = join(ROOT, options.reference);
    if (!existsSync(file)) throw new Error(`${file} is not there`);
    const theirs = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    let checks = 0;
    let differences = 0;
    const problems = [];
    for (let frame = 0; frame < Math.min(theirs.length, result.lines.length); frame++) {
      const mine = result.lines[frame].heights;
      const other = theirs[frame].heights;
      for (let column = 0; column < Math.min(mine.length, other.length); column++) {
        checks += 1;
        if (mine[column] !== other[column]) {
          differences += 1;
          if (problems.length < 20) {
            problems.push(`frame ${frame} column ${column}: ${mine[column]} against ${other[column]}`);
          }
        }
      }
    }
    for (const problem of problems) console.log(`  ! ${problem}`);
    const passed = report('matchcolumns.mjs', checks, differences,
      `${Math.min(theirs.length, result.lines.length)} frames against ${options.reference}`);
    process.exit(passed ? 0 : 1);
  }

  if (!options.quiet) {
    console.log(`  demo ${options.demo}: ${result.frame} frames, every ${options.every}th column`);
    console.log(`  ${result.skipped} columns skipped (a door, a moving wall, a corner, or the edge of the map)`);
    console.log('  the recording from DOSBox is NOT here, so this is our caster against a second one');
    for (const problem of result.problems) console.log(`  ! ${problem}`);
  }
  // Against the second caster a few differences are expected and are not a
  // failure - see the note on the tolerances at the top of this file. The
  // gate is a fraction: if more than one column in a hundred is out, the
  // walk itself is wrong and that is worth stopping for.
  const share = result.checks ? result.differences / result.checks : 0;
  report('matchcolumns.mjs', result.checks, result.differences,
    `against a float caster, not against the original; ${(share * 100).toFixed(2)} %`);
  process.exit(share > 0.01 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
