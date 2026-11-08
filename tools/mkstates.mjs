#!/usr/bin/env node
/**
 * mkstates - writes `app/wolf/stateTable.js` out of the state tables of the
 * original.
 *
 * Every actor in Wolfenstein is a walk through a table of states, and a
 * state is five numbers and two names: whether the shape turns with the
 * view, which sprite it shows, how many tics it lasts, what it thinks, what
 * it does, and which state comes next. Those tables are **facts about the
 * game** - the same kind of thing as `rndtable` - and `ZADANI.md` para 3
 * says facts are taken as numbers, with a note of where they are from.
 *
 * So this reads the declarations out of the reference sources and writes
 * them out as one table of plain data. The `think` and `action` entries
 * come across as **names**, not code; what a guard does when he thinks is
 * written in `app/wolf/actors.js`, by hand, from the description in
 * `NOTES.md`.
 *
 * The output is committed. This tool only runs where the reference sources
 * are (`sources/reference/src/`, outside version control - see
 * `sources/reference/README.md`), and it is here so that the numbers can be
 * checked against the game rather than believed.
 *
 * Usage:
 *   node tools/mkstates.mjs [--src sources/reference/src/idsoftware-wolf3d/WOLFSRC]
 *                           [--out app/wolf/stateTable.js]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_SRC = 'sources/reference/src/idsoftware-wolf3d/WOLFSRC';
const DEFAULT_OUT = 'app/wolf/stateTable.js';
const FILES = ['WL_ACT1.C', 'WL_ACT2.C', 'WL_AGENT.C', 'WL_STATE.C'];

function parseArguments (argv) {
  const options = { src: DEFAULT_SRC, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--src': options.src = argv[++i]; break;
      case '--out': options.out = argv[++i]; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return options;
}

/** Drops the `#ifdef SPEAR` parts: this is Wolfenstein, not Spear of Destiny. */
function withoutSpear (text) {
  const out = [];
  const stack = [true];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^#ifdef\s+SPEAR/.test(trimmed)) { stack.push(false); continue; }
    if (/^#ifndef\s+SPEAR/.test(trimmed)) { stack.push(true); continue; }
    if (/^#if(def|ndef)?\b/.test(trimmed)) { stack.push(stack[stack.length - 1]); continue; }
    if (/^#else/.test(trimmed)) { stack[stack.length - 1] = !stack[stack.length - 1]; continue; }
    if (/^#endif/.test(trimmed)) { stack.pop(); continue; }
    if (stack.every(Boolean)) out.push(line);
  }
  return out.join('\n');
}

/**
 * The declarations, which all look like
 * `statetype s_grdpath1 = {true,SPR_GRD_W1_1,20,T_Path,NULL,&s_grdpath1s};`
 */
function parseStates (text) {
  const states = [];
  const pattern = /statetype\s+(?:_seg\s+)?(s_\w+)\s*=\s*\{([^}]*)\}\s*;/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    const fields = match[2].split(',').map((field) => field.trim());
    if (fields.length !== 6) throw new Error(`${name} has ${fields.length} fields, expected 6`);
    const [rotate, shape, tics, think, action, next] = fields;
    states.push({
      name,
      rotate: rotate === 'true' ? 1 : (rotate === 'false' ? 0 : Number(rotate)),
      shape: /^-?\d+$/.test(shape) ? shape : shape.replace(/^SPR_/, ''),
      tics: Number(tics),
      think: think === 'NULL' ? null : think,
      action: action === 'NULL' ? null : action,
      next: next === 'NULL' ? null : next.replace(/^&/, '')
    });
  }
  return states;
}

function generate (states) {
  const known = new Set(states.map((state) => state.name));
  const missing = states.filter((state) => state.next && !known.has(state.next));
  if (missing.length) {
    throw new Error(`states point at ones that were not found: ${missing.map((s) => s.next).join(', ')}`);
  }
  const lines = states.map((state) => {
    const shape = /^-?\d+$/.test(state.shape) ? state.shape : `SPRITE.${state.shape}`;
    const think = state.think ? `'${state.think}'` : 'null';
    const action = state.action ? `'${state.action}'` : 'null';
    const next = state.next ? `'${state.next}'` : 'null';
    return `  ${state.name}: {rotate: ${state.rotate}, shapenum: ${shape}, tictime: ${state.tics}, ` +
      `think: ${think}, action: ${action}, next: ${next}},`;
  });
  const thinks = [...new Set(states.map((s) => s.think).filter(Boolean))].sort();
  const actions = [...new Set(states.map((s) => s.action).filter(Boolean))].sort();

  return `const { SPRITE } = await import('./spriteNumbers.js?ver='+window.srcVersion);
// begin code

/**
 * The state tables of every actor in the game.
 *
 * An actor is not code, it is a walk through this table: a state says which
 * sprite to show, for how many tics, what to think while it lasts and what
 * to do the moment it is entered, and which state follows. A guard standing
 * still is one state pointing at itself; a guard dying is a short chain
 * that ends in a state with no successor.
 *
 * These are numbers out of the original (\`WL_ACT1/2.C\`, \`WL_AGENT.C\`,
 * \`WL_STATE.C\`), written here by \`tools/mkstates.mjs\` - facts about the
 * game, the same as \`rndtable\`. What the names in \`think\` and \`action\`
 * *mean* is written by hand in \`app/wolf/actors.js\`; nothing of the
 * original's code is here, only which of them a state calls.
 *
 * ${states.length} states. Thinks: ${thinks.join(', ')}.
 * Actions: ${actions.join(', ')}.
 *
 * A \`shapenum\` of -1 means the actor carries its own picture in \`temp1\`
 * (the two Hitlers and the dying BJ do), and \`rotate\` of 2 is the pain
 * frame, which has only two views instead of eight.
 */
export const STATES = {
${lines.join('\n')}
};

/** How many states there are, for a report to say so. */
export const STATE_COUNT = ${states.length};
`;
}

export function make (options) {
  let text = '';
  for (const file of FILES) {
    const path = join(options.src, file);
    if (!existsSync(path)) throw new Error(`${path} is not there; see sources/reference/README.md`);
    text += `\n${withoutSpear(readFileSync(path, 'latin1'))}`;
  }
  const states = parseStates(text);
  if (states.length < 300) throw new Error(`only ${states.length} states found, the game has around 300 without Spear of Destiny`);
  writeFileSync(options.out, generate(states));
  return states;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  const states = make(options);
  console.log(`mkstates.mjs: ${states.length} states -> ${options.out}`);
}
