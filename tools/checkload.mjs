#!/usr/bin/env node
/**
 * checkload - what the application downloads, in what order, and whether
 * the game finds it all when it starts.
 *
 * Since 2026-09-17 the whole download runs **during the boot screen**
 * (`MainApp.loadData`), not when the game model comes up, and the order is
 * chosen rather than incidental: the small files, then the tune of the
 * first level, then the megabytes, then the level, then the rest of the
 * music. That order is the difference between the music starting with the
 * level and starting a minute into it, so it is worth a tool.
 *
 * Nothing here needs a browser: the application is built without its
 * constructor (the DOM half never runs) and given a `fetchData` that
 * answers out of `data/` - which is exactly what the shape of the library's
 * `fetchData` allows, since it hands the answer to a receiver.
 *
 * usage:
 *   node tools/checkload.mjs [--quiet]
 */

import { join } from 'node:path';

import { ROOT, readData, flag, report } from './lib/gamelib.mjs';

/** Everything the loader touches on the application, and nothing else. */
function stubApp (MainApp, answer) {
  const fetched = [];
  const app = Object.create(MainApp.prototype);
  app.id = 'MainApp';
  app.levelNumber = 0;
  app.errors = [];
  app.audioManager = {
    tracks: {},
    sounds: null,
    loadTrack (track) { this.tracks[track.index] = track; },
    loadSounds (adlib, music, digi) { this.sounds = {adlib, music, digi}; }
  };
  app.showErrorMessage = (message) => app.errors.push(message);
  app.fetchData = (url, storage, data, receiver) => {
    fetched.push(url);
    answer(url, receiver);
    return 'id';
  };
  app.fetched = fetched;
  return app;
}

/** The file a URL asks for, as `data/` names it. */
function nameOf (url) {
  return url.replace(/\.data$/, '');
}

async function main () {
  const argv = process.argv.slice(2);
  const quiet = flag(argv, '--quiet');
  const say = quiet ? () => {} : (line) => console.log(line);

  await import(join(ROOT, 'app/svision/tools/nodeEnv.mjs'));
  const version = `?ver=${globalThis.window.srcVersion}`;
  const { MainApp } = await import(join(ROOT, 'app/mainApp.js') + version);

  let checks = 0;
  let differences = 0;
  const check = (condition, what) => {
    checks += 1;
    if (!condition) { differences += 1; console.log(`  ROZDÍL ${what}`); }
  };

  // The answer a server would give, straight away - which is also what the
  // library does when the file is in local storage.
  const answerNow = (url, receiver) => receiver.setData({url, data: readData(nameOf(url))});

  const app = stubApp(MainApp, answerNow);
  app.loadData();

  const order = app.fetched.map(nameOf);
  say('  pořadí    '+order.join(' '));

  // 1. the order itself
  const small = MainApp.SMALL_FILES.length;
  const wanted = MainApp.DATA_FILES.filter((file) => MainApp.SMALL_FILES.indexOf(file.key) >= 0)
    .map((file) => file.file);
  check(order.slice(0, small).join(' ') === wanted.join(' '), 'the small files should come first');
  check(order[small].indexOf('music/track') === 0, 'the tune of the first level should come before the megabytes');
  check(order.indexOf('gfx/sprites') > small, 'the sprites should not come first');
  check(order.indexOf('levels/level00') > order.indexOf('gfx/sprites'), 'the level should come after the assets');
  const extra = order.filter((file, at) => file.indexOf('music/track') === 0 && at > small);
  check(extra.every((file) => order.indexOf(file) > order.indexOf('levels/level00')),
    'the rest of the music should come after the level');
  check(order[order.length-1].indexOf('music/track') === 0, 'the last thing fetched should be a track');
  for (const file of MainApp.DATA_FILES) {
    check(order.indexOf(file.file) >= 0, `${file.file} was never asked for`);
  }
  check(new Set(order).size === order.length, 'something was fetched twice');

  // 2. what the game finds
  check(app.dataReady, 'the data should be ready');
  check(app.errors.length === 0, `the loader reported ${app.errors.join(', ')}`);
  for (const file of MainApp.DATA_FILES) check(!!app.data[file.key], `${file.key} is not in hand`);
  check(!!app.levels[0], 'the first level is not in hand');
  check(!!app.audioManager.sounds, 'the audio manager was never given its sounds');
  check(!!app.audioManager.sounds.digi, 'the audio manager was never given the digitised sounds');
  const tracks = Object.keys(app.audioManager.tracks).length;
  check(tracks === app.data.music.tracks.filter((track) => track && track.present).length,
    `${tracks} tracks rendered of ${app.data.music.tracks.filter((t) => t && t.present).length} present`);

  // 3. and what the game model asks for afterwards
  let delivered = null;
  app.wantLevel(0, null, (level, demo) => { delivered = {level, demo}; });
  check(delivered && delivered.level === app.levels[0], 'a level in hand should be handed over at once');
  const before = app.fetched.length;
  app.wantLevel(0, 2, (level, demo) => { delivered = {level, demo}; });
  check(app.fetched.length === before, 'a level in hand should not be fetched again');
  check(delivered.demo === 2, 'the demo should come with the level');
  app.wantLevel(3, null, (level) => { delivered = {level}; });
  check(app.fetched[app.fetched.length-1] === 'levels/level03.data', 'a level not in hand should be fetched');

  // 4. the boot is slower than the line: the game model comes up last
  const late = stubApp(MainApp, answerNow);
  late.loadData();
  let ready = 0;
  late.whenDataReady(() => { ready += 1; });
  check(ready === 1, 'a model that comes up late should be told at once');

  // 5. and the other way round, with a server that answers only when asked
  const pending = [];
  const slow = stubApp(MainApp, (url, receiver) => pending.push(() => receiver.setData({url, data: readData(nameOf(url))})));
  slow.loadData();
  let readySlow = 0;
  slow.whenDataReady(() => { readySlow += 1; });
  check(readySlow === 0, 'nothing is ready before anything has arrived');
  check(pending.length === 1, 'one request at a time, or the library loses the answers');
  let guard = 0;
  while (pending.length && guard++ < 200) pending.shift()();
  check(readySlow === 1, 'the model should be told exactly once');
  check(slow.dataReady && !!slow.levels[0], 'everything should arrive in the end');

  // 6. the tune the game is waiting for jumps the queue
  const waiting = stubApp(MainApp, (url, receiver) => pending.push(() => receiver.setData({url, data: readData(nameOf(url))})));
  pending.length = 0;
  waiting.loadData();
  while (pending.length && !waiting.dataReady) pending.shift()();
  const queued = waiting.dataQueue.filter((job) => job.kind === 'track').map((job) => job.file);
  if (queued.length > 1) {
    const last = queued[queued.length-1];
    waiting.wantTrack(Number(last.substring(last.length-2)));
    check(waiting.dataQueue[0].file === last, 'the tune the game waits for should jump the queue');
  } else {
    check(true, 'nothing to jump the queue');
  }

  say(`  data      ${MainApp.DATA_FILES.length} souborů, ${tracks} skladeb, ` +
    `${Object.keys(app.levels).length} úroveň v ruce, když hra začíná`);

  report('checkload.mjs', checks, differences,
    `${order.length} požadavků v pořadí, bez prohlížeče`);
  process.exit(differences === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
