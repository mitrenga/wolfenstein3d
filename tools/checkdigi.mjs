#!/usr/bin/env node
/**
 * checkdigi - the digitised sounds of VSWAP, and the table that says which
 * effect plays as which of them.
 *
 * `app/wolf/digiMap.js` is a table read out of the released source, which
 * makes it the one thing in this project that cannot simply be measured -
 * so it is checked against the data instead, and the two turn out to agree
 * exactly:
 *
 *  - the shareware half of the table names the digitised sounds
 *    `0..15, 20, 21, 22, 32`, and those are **precisely** the twenty slots
 *    the shareware VSWAP fills; the other twenty-six it names behind
 *    `#ifndef UPLOAD` are precisely the ones it leaves empty;
 *  - every effect it names exists in the numbering W1 measured in AUDIOT.
 *
 * With recordings in `sources/audio/*.wav` it does one more thing: it looks
 * for each of them in the data. A recording of the original played back is
 * either one of these samples byte for byte, or the table is not what this
 * project thinks it is.
 *
 * usage:
 *   node tools/checkdigi.mjs [--quiet]
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, readData, flag, report } from './lib/gamelib.mjs';

/** The samples of one digitised sound, as bytes. */
function pcmOf (sound) {
  return new Uint8Array(Buffer.from(sound.pcm, 'base64'));
}

/** The data half of a RIFF/WAVE file, with whatever the header claims. */
function readWAV (bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  let format = null;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      format = { tag: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true),
                 rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    } else if (id === 'data') {
      return { ...format, samples: bytes.subarray(at + 8, at + 8 + size) };
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** How far apart two stretches of unsigned bytes are, 0 for the same. */
function deviation (mine, theirs) {
  const length = Math.min(mine.length, theirs.length);
  if (!length) return 1;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += Math.abs(mine[i] - theirs[i]);
  return sum / length / 255 + Math.abs(mine.length - theirs.length) / Math.max(mine.length, theirs.length);
}

async function main () {
  const argv = process.argv.slice(2);
  const quiet = flag(argv, '--quiet');
  const say = quiet ? () => {} : (line) => console.log(line);

  await import(join(ROOT, 'app/svision/tools/nodeEnv.mjs'));
  const version = `?ver=${globalThis.window.srcVersion}`;
  const { SOUND, SOUNDS } = await import(join(ROOT, 'app/wolf/soundNumbers.js') + version);
  const { DIGI_MAP, DIGI_PAIRS, buildDigiMap } = await import(join(ROOT, 'app/wolf/digiMap.js') + version);
  const { WolfSound } = await import(join(ROOT, 'app/wolf/sound.js') + version);

  let checks = 0;
  let differences = 0;
  const check = (condition, what) => {
    checks += 1;
    if (!condition) { differences += 1; console.log(`  ROZDÍL ${what}`); }
  };

  const digi = readData('sounds/digi');
  const filled = new Set();
  digi.sounds.forEach((sound, index) => { if (sound) filled.add(index); });

  // 1. the data itself
  check(digi.rate === 7000, `the digitised sounds are at ${digi.rate} Hz, not 7000`);
  check(digi.count === filled.size, `${digi.count} sounds claimed, ${filled.size} present`);
  for (const index of filled) {
    const sound = digi.sounds[index];
    const pcm = pcmOf(sound);
    check(pcm.length === sound.bytes, `digitised ${index}: ${pcm.length} bytes, the table says ${sound.bytes}`);
    check(Math.abs(pcm.length / digi.rate - sound.seconds) < 1e-6, `digitised ${index}: the length and the seconds disagree`);
  }

  // 2. the table against the data
  const shareware = new Set(DIGI_PAIRS.shareware.map(([, index]) => index));
  const registered = new Set(DIGI_PAIRS.registered.map(([, index]) => index));
  for (const index of shareware) check(filled.has(index), `the table plays digitised ${index}, which the data does not have`);
  for (const index of filled) check(shareware.has(index), `the data has digitised ${index}, which the table never plays`);
  for (const index of registered) check(!filled.has(index), `digitised ${index} is only in the registered game, but the shareware data has it`);

  // 3. the table itself
  check(DIGI_MAP.length === SOUNDS, `the table is ${DIGI_MAP.length} long, there are ${SOUNDS} effects`);
  for (const [name, index] of DIGI_PAIRS.shareware) {
    check(SOUND[name] !== undefined, `the table names ${name}, which is not an effect`);
    check(DIGI_MAP[SOUND[name]] === index, `${name} should play digitised ${index}`);
  }
  for (const [name] of DIGI_PAIRS.registered) {
    check(SOUND[name] !== undefined, `the registered table names ${name}, which is not an effect`);
    check(DIGI_MAP[SOUND[name]] === -1, `${name} has no digitised version in the shareware data`);
  }
  const mapped = DIGI_MAP.filter((index) => index >= 0).length;
  check(mapped === DIGI_PAIRS.shareware.length, `${mapped} effects mapped, the table has ${DIGI_PAIRS.shareware.length} pairs`);
  check(buildDigiMap(true).filter((index) => index >= 0).length ===
    DIGI_PAIRS.shareware.length + DIGI_PAIRS.registered.length, 'the registered table loses a pair');

  // 4. and the rule the game plays by
  const sound = new WolfSound({});
  sound.loadTable(readData('sounds/adlib'));
  sound.loadDigi({rate: digi.rate, seconds: digi.sounds.map((entry) => (entry ? entry.seconds : 0))});
  check(sound.digiOf(SOUND.OPENDOOR) === 3, 'a door should be digitised sound 3');
  check(sound.digiOf(SOUND.HITWALL) === -1, 'a wall has no digitised version');
  sound.digiMode = WolfSound.DIGI.OFF;
  check(sound.digiOf(SOUND.OPENDOOR) === -1, 'with the DAC off nothing is digitised');
  sound.digiMode = WolfSound.DIGI.SOUNDBLASTER;
  // a digitised sound does not hold voice 0, so `SD_SoundPlaying` stays quiet
  sound.reset();
  sound.play(SOUND.OPENDOOR);
  check(sound.playing() === 0, 'a digitised sound should not answer SD_SoundPlaying');
  check(sound.digiTics > 0, 'a digitised sound should hold the DAC for its length');
  sound.reset();
  sound.play(SOUND.HITWALL);
  check(sound.playing() === SOUND.HITWALL, 'an FM effect should answer SD_SoundPlaying');

  say(`  tabulka   ${mapped} z ${SOUNDS} efektů je digitalizovaných, ` +
    `${filled.size} vzorků v datech, ${digi.rate} Hz`);

  // 5. the recordings, if there are any
  const audioDirectory = join(ROOT, 'sources/audio');
  let found = 0;
  if (existsSync(audioDirectory)) {
    const files = readdirSync(audioDirectory).filter((name) => name.toLowerCase().endsWith('.wav')).sort();
    for (const file of files) {
      const wave = readWAV(new Uint8Array(readFileSync(join(audioDirectory, file))));
      if (!wave || wave.bits !== 8) { say(`  ${file.padEnd(24)} není osmibitové PCM, přeskočeno`); continue; }
      let best = {index: -1, deviation: 1};
      for (const index of filled) {
        const value = deviation(wave.samples, pcmOf(digi.sounds[index]));
        if (value < best.deviation) best = {index, deviation: value};
      }
      const name = best.index < 0 ? '-' : (DIGI_PAIRS.shareware.find(([, index]) => index === best.index) || ['?'])[0];
      const same = best.deviation < 1e-9;
      say(`  ${file.padEnd(24)} ${String(wave.rate).padStart(5)} Hz, ${String(wave.samples.length).padStart(6)} B -> ` +
        (same ? `digitalizovaný ${String(best.index).padStart(2)} (${name})` : `nic z dat (nejblíž ${best.index}, odchylka ${best.deviation.toFixed(3)})`));
      if (same) found += 1;
    }
    // Not a check: a recording may be from the registered game, or not from
    // this game at all. What is checked is that nothing matches *almost*,
    // which would mean our reading of VSWAP is off by a sample or a bias.
    for (const file of files) {
      const wave = readWAV(new Uint8Array(readFileSync(join(audioDirectory, file))));
      if (!wave || wave.bits !== 8) continue;
      let best = 1;
      for (const index of filled) best = Math.min(best, deviation(wave.samples, pcmOf(digi.sounds[index])));
      check(best < 1e-9 || best > 0.02, `${file}: odchylka ${best.toFixed(4)} - ani stejné, ani jiné`);
    }
    say(`  nahrávky  ${found} z ${files.length} je v datech bajt po bajtu`);
  }

  report('checkdigi.mjs', checks, differences,
    `${mapped} dvojic, ${filled.size} vzorků, ${found} nahrávek sedí`);
  process.exit(differences === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
