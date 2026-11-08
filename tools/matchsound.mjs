#!/usr/bin/env node
/**
 * matchsound - the acceptance of W8 for the effects: our OPL2 against the
 * card of the original.
 *
 * Every effect of the game is an instrument and a note a 1/140 s; the driver
 * that turns that into register writes is the library's `AdlibSound` and the
 * chip behind it svision's own OPL2, written from the YM3812 datasheet
 * rather than ported (R-029 para 2.6). What this tool does with it depends
 * on what there is to compare against:
 *
 * - **`--reference <dir>`**: recordings of the same effects from the
 *   original in DOSBox, as WAV. Each is compared sample by sample, and the
 *   tolerance is stated in the report - a model of a chip is never bit
 *   exact against a recording that has been through a sound card, a mixer
 *   and a resampler, so the measure is how far the two are apart on
 *   average, against a limit set here.
 * - **nothing**: what can be checked without the original is checked - that
 *   every effect renders, that it is the length its data says, that it is
 *   not silence, and that rendering it twice gives the same samples (so
 *   `matchsound` itself is repeatable). The report says which of the two it
 *   did.
 *
 * `--wav <dir>` writes our own renderings out for the ear.
 *
 * usage:
 *   node tools/matchsound.mjs [--reference sources/media/adlib] [--wav build/adlib]
 *                             [--rate 22050] [--quiet]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, readData, option, flag, report } from './lib/gamelib.mjs';

const bytes = (base64) => new Uint8Array(Buffer.from(base64, 'base64'));

/** How far apart a rendering and a recording may be, as a share of full scale. */
const TOLERANCE = 0.08;

async function main () {
  const args = process.argv.slice(2);
  const rate = parseInt(option(args, '--rate', '22050'), 10);
  const wavDirectory = option(args, '--wav', null);
  const reference = option(args, '--reference', null);
  const quiet = flag(args, '--quiet');

  await import(join(ROOT, 'app/svision/tools/nodeEnv.mjs'));
  const { AdlibSound } = await import(join(ROOT, 'app/svision/js/audio/chip/adlibSound.js'));
  const { WolfSound } = await import(join(ROOT, 'app/wolf/sound.js'));
  const { PCMSample } = await import(join(ROOT, 'app/svision/js/audio/pcmSample.js'));

  /** One effect through the library's driver, at the game's own loudness. */
  const render = (effect) => {
    const driver = new AdlibSound({ sampleRate: rate, gain: WolfSound.OPL_GAIN });
    driver.play(effect);
    return { samples: driver.renderAll(), sampleRate: driver.sampleRate };
  };

  const data = readData('sounds/adlib');
  const effects = data.sounds
    .map((sound, index) => (sound ? { index, ...sound, data: bytes(sound.data), instrument: Uint8Array.from(sound.instrument) } : null))
    .filter(Boolean);

  let checks = 0;
  let differences = 0;
  const problems = [];
  const rendered = {};

  for (const effect of effects) {
    const first = render(effect);
    rendered[effect.index] = first;

    // it renders, and it is as long as its data says
    checks += 1;
    const expected = Math.ceil((effect.data.length / AdlibSound.RATE) * rate);
    if (first.samples.length < expected) {
      differences += 1;
      problems.push(`effect ${effect.index} (${effect.name}): ${first.samples.length} samples, expected at least ${expected}`);
    }

    // it makes a sound
    checks += 1;
    let peak = 0;
    for (const sample of first.samples) peak = Math.max(peak, Math.abs(sample));
    if (peak < 0.0005) {
      differences += 1;
      problems.push(`effect ${effect.index} (${effect.name}): silence`);
    }

    // and the same effect twice gives the same samples
    checks += 1;
    const second = render(effect);
    let same = second.samples.length === first.samples.length;
    for (let at = 0; same && at < first.samples.length; at++) same = first.samples[at] === second.samples[at];
    if (!same) {
      differences += 1;
      problems.push(`effect ${effect.index} (${effect.name}): two renderings differ`);
    }

    if (wavDirectory) {
      const out = join(ROOT, wavDirectory);
      mkdirSync(out, { recursive: true });
      const sample = new PCMSample(first.samples, first.sampleRate);
      const name = `${String(effect.index).padStart(2, '0')}-${(effect.name || 'sound').toLowerCase()}.wav`;
      writeFileSync(join(out, name), Buffer.from(sample.toWAV(16)));
    }
  }

  if (!quiet) {
    console.log(`  ${effects.length} AdLib effects rendered at ${rate} Hz` +
      (wavDirectory ? ` -> ${wavDirectory}` : ''));
  }

  const directory = reference ? join(ROOT, reference) : null;
  if (directory && existsSync(directory)) {
    const files = readdirSync(directory).filter((file) => file.toLowerCase().endsWith('.wav'));
    for (const file of files) {
      const index = parseInt(file, 10);
      const mine = rendered[index];
      if (!mine) { problems.push(`${file}: no effect ${index} in the data`); continue; }
      const theirs = PCMSample.fromWAV(new Uint8Array(readFileSync(join(directory, file))));
      checks += 1;
      // compare at our own rate, taking the recording at the nearest sample
      let sum = 0;
      let count = 0;
      const ratio = theirs.sampleRate / mine.sampleRate;
      for (let at = 0; at < mine.samples.length; at++) {
        const there = Math.round(at * ratio);
        if (there >= theirs.samples.length) break;
        sum += Math.abs(mine.samples[at] - theirs.samples[there]);
        count += 1;
      }
      const apart = count ? sum / count : 1;
      if (apart > TOLERANCE) {
        differences += 1;
        problems.push(`${file}: ${apart.toFixed(3)} apart on average, more than ${TOLERANCE}`);
      }
    }
    if (!quiet) console.log(`  ${files.length} recordings from DOSBox compared`);
  } else if (!quiet) {
    console.log(`  no recordings in ${reference || 'sources/media/adlib'}: the comparison against the card was NOT run`);
  }

  for (const problem of problems.slice(0, 20)) console.log(`  ! ${problem}`);
  const passed = report('matchsound.mjs', checks, differences,
    directory && existsSync(directory) ? `tolerance ${TOLERANCE}` : 'our own chip only; against DOSBox NOT run');
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
