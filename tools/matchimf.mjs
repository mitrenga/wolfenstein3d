#!/usr/bin/env node
/**
 * matchimf - the acceptance of W8 for the music: every track, register
 * write for register write.
 *
 * IMF is a recording of what the game wrote to the OPL2 and when, so unlike
 * a sound this *can* be checked exactly and without the original running:
 * the stream in `data/music/` is played through the library's `AdlibIMF`
 * and every write it makes is compared with the stream in AUDIOT - the same
 * register, the same value, at the same 1/700 s.
 *
 * That is a real zero: it says the player writes what the game wrote,
 * neither dropping a write nor inventing one nor drifting in time. What it
 * does **not** say is how the card sounded; that is `matchsound`.
 *
 * `--wav <dir>` renders the tracks out for the ear (minutes of audio, so it
 * is off by default).
 *
 * usage:
 *   node tools/matchimf.mjs [--wav build/music] [--rate 24858] [--quiet]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, readData, option, flag, report } from './lib/gamelib.mjs';
import { openAudio, parseIMF, IMF_RATE } from './lib/audioT.mjs';
import { readFileSync } from 'node:fs';

const bytes = (base64) => new Uint8Array(Buffer.from(base64, 'base64'));

async function main () {
  const args = process.argv.slice(2);
  const rate = parseInt(option(args, '--rate', '24858'), 10);
  const wavDirectory = option(args, '--wav', null);
  const inDirectory = join(ROOT, option(args, '--in', 'sources/game/sw14'));
  const quiet = flag(args, '--quiet');

  await import(join(ROOT, 'app/svision/tools/nodeEnv.mjs'));
  const { AdlibIMF } = await import(join(ROOT, 'app/svision/js/audio/chip/adlibIMF.js'));
  const { WolfSound } = await import(join(ROOT, 'app/wolf/sound.js'));
  const { PCMSample } = await import(join(ROOT, 'app/svision/js/audio/pcmSample.js'));
  const { OPL2 } = await import(join(ROOT, 'app/svision/js/audio/chip/opl2.js'));

  const index = readData('music');
  const audio = openAudio(
    new Uint8Array(readFileSync(join(inDirectory, 'AUDIOHED.WL1'))),
    new Uint8Array(readFileSync(join(inDirectory, 'AUDIOT.WL1'))));

  let checks = 0;
  let differences = 0;
  const problems = [];
  let seconds = 0;
  let writes = 0;

  for (const listed of index.tracks) {
    if (!listed || !listed.present) continue;
    const track = readData(`music/track${String(listed.index).padStart(2, '0')}`);
    const stream = bytes(track.stream);

    // what the file itself says, decoded again by the W1 decoder
    const chunk = audio.chunkOf(audio.startMusic + listed.index);
    const original = parseIMF(chunk);

    // and what the player does with our stream: every write it makes, and
    // the tick it makes it at
    const player = new AdlibIMF({ sampleRate: rate, gain: WolfSound.OPL_GAIN });
    player.play(stream);
    const made = [];
    let tick = 0;
    for (let at = 0; at + 3 < stream.length; at += 4) {
      made.push({ register: stream[at], value: stream[at + 1],
        delay: stream[at + 2] | (stream[at + 3] << 8), tick });
      tick += stream[at + 2] | (stream[at + 3] << 8);
    }

    checks += 1;
    if (made.length !== original.writes.length) {
      differences += 1;
      problems.push(`track ${listed.index} (${track.name}): ${made.length} writes against ${original.writes.length}`);
      continue;
    }
    let wrong = 0;
    let atTick = 0;
    for (let i = 0; i < made.length; i++) {
      checks += 1;
      const theirs = original.writes[i];
      if (made[i].register !== theirs.register || made[i].value !== theirs.value ||
          made[i].delay !== theirs.delay || made[i].tick !== atTick) wrong += 1;
      atTick += theirs.delay;
    }
    if (wrong) {
      differences += wrong;
      problems.push(`track ${listed.index} (${track.name}): ${wrong} writes differ`);
    }

    // and the length the player works out has to be the length of the piece
    checks += 1;
    if (Math.abs(player.pieceSeconds - original.ticks / IMF_RATE) > 0.001) {
      differences += 1;
      problems.push(`track ${listed.index}: ${player.pieceSeconds.toFixed(3)} s against ${(original.ticks / IMF_RATE).toFixed(3)} s`);
    }
    seconds += player.pieceSeconds;
    writes += made.length;

    if (wavDirectory) {
      const out = join(ROOT, wavDirectory);
      mkdirSync(out, { recursive: true });
      const music = new AdlibIMF({ sampleRate: rate, gain: WolfSound.OPL_GAIN });
      music.play(stream);
      const sample = new PCMSample(music.renderAll(), music.sampleRate);
      writeFileSync(join(out, `${String(listed.index).padStart(2, '0')}-${(track.name || 'track').toLowerCase()}.wav`),
        Buffer.from(sample.toWAV(16)));
      if (!quiet) console.log(`  track ${listed.index} ${(track.name || '').padEnd(10)} ${player.pieceSeconds.toFixed(1)} s rendered`);
    }
  }

  if (!quiet) {
    console.log(`  ${index.count} tracks, ${writes} register writes, ${seconds.toFixed(0)} s of music` +
      ` (the chip renders at ${OPL2.SAMPLE_RATE} Hz, this at ${rate})`);
  }
  for (const problem of problems.slice(0, 20)) console.log(`  ! ${problem}`);
  const passed = report('matchimf.mjs', checks, differences, 'the streams against AUDIOT');
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
