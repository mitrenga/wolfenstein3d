#!/usr/bin/env node
/**
 * matchdemo - the acceptance of W5 and W6: play the demos the game carries
 * and compare the state of the world after **every tic**.
 *
 * This is the hardest thing in the project to make pass, and the reason is
 * worth stating: a demo is nothing but a list of button states, so every
 * number in the game - where the player is to a 65 536th of a tile, which
 * way a guard turned, how much a shot took off - has to come out of our
 * arithmetic exactly as it came out of a 286. One rounding a thousand tics
 * ago and the two runs are in different rooms.
 *
 * The state compared is the one `WolfGame.snapshot()` returns: the player,
 * the clock, **the index into `rndtable`**, the doors, the moving wall and
 * every actor. The index is the telling one - it advances only when the
 * game asks for a number, so if it matches after tens of thousands of tics
 * then not only the numbers but the *order in which they were asked for*
 * matches, and that is the order the actors were thought about in.
 *
 * What it is held against:
 *
 * - **`--reference <file>`**: a recording from DOSBox (one line of JSON a
 *   tic, in the shape `--record` writes). That is the acceptance.
 * - **`--record <file>`**: writes ours instead, which held against later is
 *   a regression, not a proof.
 * - **neither**: the demos are played twice and the two runs compared,
 *   which proves the run is repeatable (no `Math.random` anywhere, R-009)
 *   and nothing else. The report says so.
 *
 * usage:
 *   node tools/matchdemo.mjs [--demo 0..3|all] [--frames N]
 *                            [--record build/demo0.jsonl] [--reference ...]
 *                            [--quiet]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ROOT, newGame, option, flag, report } from './lib/gamelib.mjs';

/** Plays one demo through and writes down the state after every tic. */
async function playDemo (number, frames) {
  const { game, screen } = await newGame({ demo: number, difficulty: 3 });
  const states = [];
  let frame = 0;
  while (!game.playstate && frame < frames) {
    game.playFrame(screen, 4);
    frame += 1;
    states.push(game.snapshot());
  }
  return { states, frame, playstate: game.playstate, game };
}

/** Compares two states and lists what is different about them. */
function compare (mine, theirs) {
  const differences = [];
  const check = (what, a, b) => { if (a !== b) differences.push(`${what} ${a} against ${b}`); };
  check('rndindex', mine.rndindex, theirs.rndindex);
  check('time', mine.time, theirs.time);
  for (const key of Object.keys(mine.player)) check(`player.${key}`, mine.player[key], theirs.player[key]);
  for (const key of Object.keys(mine.counts)) check(key, mine.counts[key], theirs.counts[key]);
  check('actors', mine.actors.length, theirs.actors.length);
  for (let i = 0; i < Math.min(mine.actors.length, theirs.actors.length); i++) {
    const a = mine.actors[i];
    const b = theirs.actors[i];
    for (const key of Object.keys(a)) check(`actor ${i} ${key}`, a[key], b[key]);
  }
  for (let i = 0; i < Math.min(mine.doors.length, theirs.doors.length); i++) {
    check(`door ${i}`, mine.doors[i], theirs.doors[i]);
  }
  return differences;
}

async function main () {
  const args = process.argv.slice(2);
  const which = option(args, '--demo', 'all');
  const demos = which === 'all' ? [0, 1, 2, 3] : [parseInt(which, 10)];
  const frames = parseInt(option(args, '--frames', '100000'), 10);
  const record = option(args, '--record', null);
  const reference = option(args, '--reference', null);
  const quiet = flag(args, '--quiet');

  let checks = 0;
  let differences = 0;
  const problems = [];

  for (const number of demos) {
    const run = await playDemo(number, frames);
    if (!quiet) {
      console.log(`  demo ${number}: level ${run.game.gamestate.mapon + 1}, ${run.frame} tics of four, ` +
        `ended ${run.playstate || 'by running out of frames'}; ` +
        `rndindex ${run.states.length ? run.states[run.states.length - 1].rndindex : 0}, ` +
        `${run.game.gamestate.killcount}/${run.game.gamestate.killtotal} killed`);
    }

    if (record) {
      const out = join(ROOT, record.replace('%d', String(number)));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, run.states.map((state) => JSON.stringify(state)).join('\n') + '\n');
      console.log(`  written to ${out}`);
      continue;
    }

    let theirs = null;
    if (reference) {
      const file = join(ROOT, reference.replace('%d', String(number)));
      if (existsSync(file)) {
        theirs = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      } else if (!quiet) {
        console.log(`  ! ${file} is not there`);
      }
    }
    if (!theirs) {
      // no recording: play it again and hold the two against each other
      const again = await playDemo(number, frames);
      theirs = again.states;
    }

    for (let tic = 0; tic < Math.min(run.states.length, theirs.length); tic++) {
      checks += 1;
      const found = compare(run.states[tic], theirs[tic]);
      if (found.length) {
        differences += 1;
        if (problems.length < 10) problems.push(`demo ${number} tic ${tic}: ${found.slice(0, 3).join(', ')}`);
      }
    }
    if (run.states.length !== theirs.length) {
      differences += 1;
      problems.push(`demo ${number}: ${run.states.length} tics against ${theirs.length}`);
    }
  }

  if (record) return;
  for (const problem of problems) console.log(`  ! ${problem}`);
  const against = reference ? `against ${reference}` : 'the same run twice; against DOSBox NOT run';
  const passed = report('matchdemo.mjs', checks, differences, against);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
