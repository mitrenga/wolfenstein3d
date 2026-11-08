/**
 * AUDIOHED / AUDIOT - the sound effects in three shapes and the music.
 *
 * AUDIOHED is nothing but offsets, an INT32LE each, one more than there are
 * chunks. AUDIOT holds the chunks one after another, uncompressed, in four
 * bands of the same length: the PC speaker version of every effect, then the
 * AdLib version, then the digitised version - which MUSE could describe but
 * the game never used, so all of those are empty and the samples live in
 * VSWAP instead - and finally the music.
 *
 * How long a band is, is compiled into the executable in the original. Here
 * it is derived: the digitised band is the run of empty chunks in the middle
 * of the file, and its length is the number of effects.
 */

export const PC_RATE = 140;                  // instructions per second
export const PC_CLOCK = 0x1234dd;            // 1193181 Hz, the PIT
export const IMF_RATE = 700;                 // register writes per second

/** The offsets, and the length each chunk gets from the next offset. */
export function readAudioHead (bytes) {
  if (bytes.length % 4 !== 0) throw new Error(`AUDIOHED is ${bytes.length} bytes, not a whole number of offsets`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets = [];
  for (let at = 0; at < bytes.length; at += 4) offsets.push(view.getInt32(at, true));
  return offsets;
}

/** The container, with the four bands worked out from the data. */
export function openAudio (headBytes, audioBytes) {
  const offsets = readAudioHead(headBytes);
  const count = offsets.length - 1;
  const lengths = [];
  for (let i = 0; i < count; i++) lengths.push(offsets[i + 1] - offsets[i]);

  const chunkOf = (index) => {
    if (index < 0 || index >= count) throw new Error(`audio chunk ${index} is outside the ${count} of the file`);
    if (lengths[index] <= 0) return null;
    if (offsets[index] + lengths[index] > audioBytes.length) throw new Error(`audio chunk ${index} runs past the end of AUDIOT`);
    return audioBytes.subarray(offsets[index], offsets[index] + lengths[index]);
  };

  // The digitised band is the only run of empty chunks inside the file. It
  // starts where two equal bands of effects end, so its start alone gives
  // the number of effects, and with it every other boundary.
  let runStart = -1;
  let runLength = 0;
  for (let i = 0, start = -1; i <= count; i++) {
    const empty = i < count && lengths[i] <= 0;
    if (empty && start < 0) start = i;
    if (!empty && start >= 0) {
      if (i - start > runLength) { runStart = start; runLength = i - start; }
      start = -1;
    }
  }
  if (runLength <= 0) throw new Error('AUDIOT has no empty band, so the number of effects cannot be derived');

  if (runStart % 2 !== 0) throw new Error(`the empty band starts at ${runStart}, which cannot be twice the number of effects`);
  const sounds = runStart / 2;
  const startMusic = sounds * 3;
  if (startMusic >= count) throw new Error(`${sounds} effects would leave no music in ${count} chunks`);

  // MUSE wrote an "!ID!" tag after each band; the one after the digitised
  // band is the only one the offsets do not skip, so it turns up as the last
  // chunk of that band. Everything else in the band has to be empty.
  const tag = '!ID!';
  for (let i = sounds * 2; i < startMusic; i++) {
    if (lengths[i] <= 0) continue;
    const chunk = chunkOf(i);
    const looksLikeTag = i === startMusic - 1 && chunk.length === 4 &&
      new TextDecoder('latin1').decode(chunk) === tag;
    if (!looksLikeTag) throw new Error(`digitised chunk ${i} is ${lengths[i]} bytes, but that band is empty in every release`);
  }

  return {
    offsets,
    lengths,
    count,
    chunkOf,
    sounds,
    startPC: 0,
    startAdLib: sounds,
    startDigitised: sounds * 2,
    startMusic,
    tracks: count - startMusic,
    digitisedTag: lengths[startMusic - 1] > 0,
    kindOf: (index) => (index < sounds ? 'pc' : index < sounds * 2 ? 'adlib' : index < startMusic ? 'digitised' : 'music')
  };
}

/**
 * A PC speaker effect: a length, a priority, then one byte per 1/140 s. Like
 * the AdLib effects it ends with a terminator and the name MUSE gave it,
 * which the game never reads.
 */
export function parsePCSound (chunk) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const length = view.getUint32(0, true);
  if (6 + length >= chunk.length) throw new Error(`a PC sound states ${length} bytes in a ${chunk.length} byte chunk`);
  const end = chunk.indexOf(0, 6 + length + 1);
  return {
    length,
    priority: view.getUint16(4, true),
    data: chunk.subarray(6, 6 + length),
    terminator: chunk[6 + length],
    name: new TextDecoder('latin1').decode(chunk.subarray(6 + length + 1, end === -1 ? chunk.length : end))
  };
}

/** Its bytes as frequencies in Hz, which is what the byte divides down to. */
export function pcFrequencies (sound) {
  return Array.from(sound.data, (value) => (value === 0 ? 0 : Math.round(PC_CLOCK / (value * 60))));
}

/**
 * An AdLib effect: a length, a priority, the sixteen bytes of the instrument,
 * the octave, then one byte per 1/140 s for register 0xA0, and a name nobody
 * reads at the end.
 */
export function parseAdLibSound (chunk) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const length = view.getUint32(0, true);
  if (23 + length > chunk.length) throw new Error(`an AdLib sound states ${length} bytes in a ${chunk.length} byte chunk`);
  const instrument = chunk.subarray(6, 22);
  const end = chunk.indexOf(0, 23 + length + 1);
  return {
    length,
    priority: view.getUint16(4, true),
    instrument: {
      mCharacteristic: instrument[0], cCharacteristic: instrument[1],
      mScale: instrument[2], cScale: instrument[3],
      mAttack: instrument[4], cAttack: instrument[5],
      mSustain: instrument[6], cSustain: instrument[7],
      mWave: instrument[8], cWave: instrument[9],
      connection: instrument[10]
    },
    instrumentBytes: instrument,
    octave: chunk[22],
    data: chunk.subarray(23, 23 + length),
    terminator: chunk[23 + length],
    name: new TextDecoder('latin1').decode(chunk.subarray(23 + length + 1, end === -1 ? chunk.length : end))
  };
}

/**
 * A music track, IMF type 1: a length word, then quadruples of register,
 * value and a delay in ticks of 1/700 s, and after them the 88 byte record
 * MUSE kept - the name of the track and the word "IMF".
 *
 * The shareware file has that record and nothing else for every track
 * episode one does not play; those state a length of zero and are reported
 * as not present rather than as broken.
 */
export function parseIMF (chunk) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const length = view.getUint16(0, true);
  if (length % 4 !== 0) throw new Error(`an IMF track states ${length} bytes, not a whole number of writes`);
  if (2 + length > chunk.length) throw new Error(`an IMF track states ${length} bytes in a ${chunk.length} byte chunk`);
  // MUSE left a record after the data: the name of the track, then "IMF".
  // Where the name starts differs between a real track and a stub, so it is
  // found by the marker that follows it rather than by a fixed offset.
  const fields = new TextDecoder('latin1').decode(chunk.subarray(2 + length)).split('\0');
  const marker = fields.indexOf('IMF');
  const before = (marker > 0 ? fields.slice(0, marker) : fields)
    .map((field) => field.replace(/[^\x20-\x7e]/g, ''))
    .filter((field) => field.length >= 3);   // the two bytes before the name are not one
  // Some records kept the path MUSE read the track from instead of a bare
  // name; the file name without its extension is the same thing.
  const name = (before.length > 0 ? before[before.length - 1] : '')
    .replace(/^.*[\\/]/, '').replace(/\.[A-Za-z]+$/, '');
  const writes = [];
  let ticks = 0;
  for (let at = 2; at < 2 + length; at += 4) {
    const delay = view.getUint16(at + 2, true);
    writes.push({ register: chunk[at], value: chunk[at + 1], delay });
    ticks += delay;
  }
  return {
    length, writes, ticks, name,
    present: length > 0,
    seconds: ticks / IMF_RATE,
    tail: chunk.subarray(2 + length)
  };
}
