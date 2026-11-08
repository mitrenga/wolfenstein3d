#!/usr/bin/env node
/**
 * tunechip - sets the two open constants of the OPL2 by measurement instead
 * of by argument.
 *
 * Two numbers in `svision/js/audio/chip/opl2.js` are not derived from
 * anything measured:
 *
 * - **`FM_INDEX`**, how far a modulator at full level swings the carrier's
 *   phase. It was one turn until 2026-09-15 and is four now, changed because
 *   the music of Prince of Persia sounded muffled - by ear, on the material
 *   least sensitive to it. A sound effect of Wolfenstein, whose modulator
 *   runs near full level, hears the difference far more.
 * - **`lowPass`**, the cutoff of the card's output stage, set to 13 kHz
 *   against a recording of an AdLib **while `FM_INDEX` was still four times
 *   too small** - so it was very likely compensating for that
 *   (`../ROADMAP.md` 3.5 says as much).
 *
 * Give this a **recording of the original** playing one of the game's AdLib
 * effects (or its music) and it renders the same thing at every combination
 * of the two, then reports which pair comes closest. What it compares is
 * timbre, not samples: a recording has been through a card, an amplifier and
 * whatever captured it, so sample-by-sample means nothing. It compares
 *
 *   - the **spectral centroid** (how bright it is),
 *   - the **share of energy above 3 kHz** (how harsh),
 *   - and the **shape of the envelope** (how it starts and dies),
 *
 * each normalised, so no single measure can carry the answer alone.
 *
 * usage:
 *   node tools/tunechip.mjs --reference <wav> --sound OPENDOOR [--music 3]
 *                           [--index 1,2,3,3.99] [--lowpass 4000,6000,13000,0]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, readData, option, report } from './lib/gamelib.mjs';

/** The spectrum of a stretch of samples, by a plain transform. */
function spectrum (samples, rate, from, size = 4096) {
  const start = Math.min(Math.max(0, from), Math.max(0, samples.length - size));
  const window = new Float64Array(size);
  let mean = 0;
  for (let i = 0; i < size; i++) mean += samples[start + i] || 0;
  mean /= size;
  for (let i = 0; i < size; i++) {
    window[i] = ((samples[start + i] || 0) - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  const bins = [];
  for (let k = 1; k < size / 2; k += 2) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < size; n++) {
      const angle = (-2 * Math.PI * k * n) / size;
      re += window[n] * Math.cos(angle);
      im += window[n] * Math.sin(angle);
    }
    bins.push({ frequency: (k * rate) / size, magnitude: Math.hypot(re, im) });
  }
  return bins;
}

/** How bright a sound is, and how much of it sits high up. */
function timbre (samples, rate) {
  const bins = spectrum(samples, rate, Math.floor(samples.length * 0.25));
  let sum = 0;
  let weighted = 0;
  let high = 0;
  for (const bin of bins) {
    sum += bin.magnitude;
    weighted += bin.magnitude * bin.frequency;
    if (bin.frequency > 3000) high += bin.magnitude;
  }
  // and the envelope, as eight numbers: the loudness of eight equal slices
  const slices = 8;
  const envelope = [];
  let peak = 0;
  for (let s = 0; s < slices; s++) {
    const from = Math.floor((samples.length * s) / slices);
    const to = Math.floor((samples.length * (s + 1)) / slices);
    let power = 0;
    for (let i = from; i < to; i++) power += samples[i] * samples[i];
    power = Math.sqrt(power / Math.max(1, to - from));
    envelope.push(power);
    peak = Math.max(peak, power);
  }
  return {
    centroid: sum ? weighted / sum : 0,
    high: sum ? high / sum : 0,
    envelope: envelope.map((value) => (peak ? value / peak : 0))
  };
}

/** How far apart two timbres are; zero is the same. */
function distance (mine, theirs) {
  const brightness = Math.abs(mine.centroid - theirs.centroid) / Math.max(1, theirs.centroid);
  const harshness = Math.abs(mine.high - theirs.high);
  let shape = 0;
  for (let i = 0; i < mine.envelope.length; i++) shape += Math.abs(mine.envelope[i] - theirs.envelope[i]);
  shape /= mine.envelope.length;
  return { total: brightness + harshness + shape, brightness, harshness, shape };
}

async function main () {
  const args = process.argv.slice(2);
  const referenceFile = option(args, '--reference', null);
  const soundName = option(args, '--sound', 'OPENDOOR');
  const musicTrack = option(args, '--music', null);
  const indices = option(args, '--index', '0.5,1,2,3,3.99').split(',').map(Number);
  const cutoffs = option(args, '--lowpass', '0,4000,6000,9000,13000').split(',').map(Number);

  if (!referenceFile) throw new Error('--reference <wav> is what this tool is for');
  const path = join(ROOT, referenceFile);
  if (!existsSync(path)) throw new Error(`${path} is not there`);

  await import(join(ROOT, 'app/svision/tools/nodeEnv.mjs'));
  const version = `?ver=${globalThis.window.srcVersion}`;
  // the same specifier the drivers use, or Node hands us a second copy of the
  // class and changing FM_INDEX on it changes nothing
  const { OPL2 } = await import(join(ROOT, 'app/svision/js/audio/chip/opl2.js') + version);
  const { AdlibSound } = await import(join(ROOT, 'app/svision/js/audio/chip/adlibSound.js') + version);
  const { AdlibIMF } = await import(join(ROOT, 'app/svision/js/audio/chip/adlibIMF.js') + version);
  const { PCMSample } = await import(join(ROOT, 'app/svision/js/audio/pcmSample.js') + version);
  const { SOUND, WolfSound } = {
    ...(await import(join(ROOT, 'app/wolf/soundNumbers.js') + version)),
    ...(await import(join(ROOT, 'app/wolf/sound.js') + version))
  };

  const reference = PCMSample.fromWAV(new Uint8Array(readFileSync(path)));
  const theirs = timbre(reference.samples, reference.sampleRate);
  console.log(`  ${referenceFile}: ${(reference.samples.length / reference.sampleRate).toFixed(2)} s, ` +
    `centroid ${Math.round(theirs.centroid)} Hz, nad 3 kHz ${(theirs.high * 100).toFixed(0)} %`);

  const rate = reference.sampleRate;
  const gain = WolfSound.OPL_GAIN;
  const make = (index, cutoff) => {
    const original = Object.getOwnPropertyDescriptor(OPL2, 'FM_INDEX');
    Object.defineProperty(OPL2, 'FM_INDEX', { get: () => index, configurable: true });
    try {
      const chip = new OPL2({ sampleRate: rate, lowPass: cutoff });
      if (musicTrack !== null) {
        const track = readData(`music/track${String(musicTrack).padStart(2, '0')}`);
        const player = new AdlibIMF({ chip, gain });
        player.play(new Uint8Array(Buffer.from(track.stream, 'base64')));
        const out = new Float32Array(Math.round(rate * Math.min(reference.samples.length / rate, 20)));
        return player.render(out, out.length, 0);
      }
      const effects = readData('sounds/adlib');
      const number = SOUND[soundName];
      const sound = effects.sounds[number];
      if (!sound) throw new Error(`no effect called ${soundName}`);
      const driver = new AdlibSound({ chip, gain });
      driver.play({
        instrument: Uint8Array.from(sound.instrument), octave: sound.octave,
        data: new Uint8Array(Buffer.from(sound.data, 'base64'))
      });
      return driver.renderAll();
    } finally {
      Object.defineProperty(OPL2, 'FM_INDEX', original);
    }
  };

  const results = [];
  for (const index of indices) {
    for (const cutoff of cutoffs) {
      const mine = timbre(make(index, cutoff), rate);
      results.push({ index, cutoff, ...distance(mine, theirs), centroid: mine.centroid, high: mine.high });
    }
  }
  results.sort((a, b) => a.total - b.total);

  console.log('  FM index  filtr     odchylka   jas    ostrost  obálka   centroid');
  for (const row of results.slice(0, 10)) {
    console.log(`  ${String(row.index).padStart(8)}  ${String(row.cutoff || 'bez').padStart(6)}  ` +
      `${row.total.toFixed(3).padStart(8)}  ${row.brightness.toFixed(3)}  ${row.harshness.toFixed(3)}  ` +
      `${row.shape.toFixed(3)}  ${String(Math.round(row.centroid)).padStart(6)} Hz`);
  }
  const best = results[0];
  console.log(`\n  nejblíž: FM index ${best.index}, filtr ${best.cutoff || 'žádný'} ` +
    `(dnes je v knihovně 3.99 a 13000)`);
  report('tunechip.mjs', results.length, 0, `${indices.length} indexů x ${cutoffs.length} filtrů proti ${referenceFile}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
