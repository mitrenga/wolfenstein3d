/**
 * What every tool needs: the data out of `data/`, and the game itself.
 *
 * The rule of the methodology is that a tool runs **the game's own code**,
 * not a copy of it (`../METHODOLOGY.md`), so this loads exactly the modules
 * `app/` loads in the browser - the same `WolfGame`, the same `GameWorker`.
 * The only difference is that there is no clock: a tool asks for one frame
 * at a time.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A data file by its name under `data/`, without the extension. */
export function readData (name, root = ROOT) {
  const file = join(root, 'data', `${name}.json`);
  if (!existsSync(file)) throw new Error(`${file} is not there - run tools/mkdata.mjs first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The level record of a level number. */
export function readLevel (number, root = ROOT) {
  return readData(`levels/level${String(number).padStart(2, '0')}`, root);
}

/** Everything the game needs, loaded into the app's own `WolfAssets`. */
export async function loadAssets (root = ROOT) {
  await import(join(root, 'app/svision/tools/nodeEnv.mjs'));
  const { WolfAssets } = await import(join(root, 'app/wolf/assets.js'));
  const assets = new WolfAssets();
  assets.loadPalette(readData('palette', root));
  assets.loadRandom(readData('random', root));
  assets.loadWalls(readData('gfx/walls', root));
  assets.loadSprites(readData('gfx/sprites', root));
  assets.loadPictures(readData('gfx/pics', root));
  assets.loadFonts(readData('gfx/fonts', root));
  assets.loadTile8(readData('gfx/tile8', root));
  assets.loadTexts(readData('texts', root));
  assets.loadDemos(readData('demos', root));
  return assets;
}

/**
 * A game, ready to be stepped.
 * @param {Object} [options]
 * @param {number} [options.level=0] - Which level to set up.
 * @param {number} [options.difficulty=1]
 * @param {number} [options.demo] - Play this recorded demo instead.
 * @param {number} [options.seed=0] - The only entropy there is (R-009).
 */
export async function newGame (options = {}) {
  const root = options.root || ROOT;
  const assets = options.assets || await loadAssets(root);
  const { WolfGame } = await import(join(root, 'app/wolf/game.js'));
  const { VGAVideoRAM } = await import(join(root, 'app/svision/js/platform/canvas2D/vga/vgaVideoRAM.js'));

  const game = new WolfGame(assets);
  game.sound.loadTable(readData('sounds/adlib', root));
  game.newGame(options.difficulty === undefined ? 1 : options.difficulty, 0);

  let number = options.level || 0;
  if (options.demo !== undefined && options.demo !== null) {
    game.startDemo(assets.demos[options.demo]);
    number = game.gamestate.mapon;
  } else {
    game.gamestate.mapon = number;
  }
  game.setupLevel(readLevel(number, root), options.seed || 0);
  return { game, assets, screen: new VGAVideoRAM(), level: number, VGAVideoRAM };
}

/** The palette as a PNG writer wants it: eight bits a component. */
export function rgb8 (palette) {
  const out = new Uint8Array(768);
  for (let i = 0; i < 768; i++) out[i] = ((palette[i] << 2) | (palette[i] >> 4)) & 0xff;
  return out;
}

/** `--name value` off the command line. */
export function option (args, name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
}

/** Whether a flag is there. */
export function flag (args, name) {
  return args.indexOf(name) >= 0;
}

/**
 * The report every `match*` tool ends with, in the one shape the whole
 * family of projects uses: how many checks, and how many of them differed.
 * @param {string} tool - The file name.
 * @param {number} checks
 * @param {number} differences
 * @param {string} [note]
 */
export function report (tool, checks, differences, note) {
  const number = (value) => value.toLocaleString('cs-CZ').replace(/ /g, ' ');
  const line = `${tool}: ${number(checks)} kontrol, ${number(differences)} rozdílů`;
  console.log(note ? `${line} (${note})` : line);
  return differences === 0;
}
