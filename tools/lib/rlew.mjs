/**
 * RLEW - id's run length encoding over words, used on every map plane.
 *
 * The unit is a 16 bit word, not a byte: a word is copied through unchanged
 * unless it is the tag word, in which case the next two words are the count
 * and the value to repeat. The tag comes from MAPHEAD (0xABCD in every
 * original file); a word equal to the tag therefore has to be written as a
 * run of one.
 *
 * A stream always starts with a UINT16LE holding the expanded size in bytes.
 * The caching manager of the game ignores it for map planes and assumes
 * 64 * 64 * 2, so `expand` takes an optional expected size to do the same.
 */

/** Expands one stream, including its leading size word. */
export function expandRLEW (chunk, tag, expectedBytes = null) {
  if (chunk.length < 2) throw new Error('RLEW stream shorter than its size word');
  const source = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const target = expectedBytes === null ? source.getUint16(0, true) : expectedBytes;
  if (target % 2 !== 0) throw new Error(`RLEW expanded size ${target} is not a whole number of words`);

  const out = new Uint8Array(target);
  const write = new DataView(out.buffer);
  let read = 2;
  let written = 0;

  while (written < target) {
    if (read + 2 > chunk.length) throw new Error('RLEW stream ended before the expanded size was reached');
    const word = source.getUint16(read, true);
    read += 2;
    if (word !== tag) {
      write.setUint16(written, word, true);
      written += 2;
      continue;
    }
    if (read + 4 > chunk.length) throw new Error('RLEW run header is cut off');
    const count = source.getUint16(read, true);
    const value = source.getUint16(read + 2, true);
    read += 4;
    if (written + count * 2 > target) throw new Error('RLEW run overruns the expanded size');
    for (let i = 0; i < count; i++, written += 2) write.setUint16(written, value, true);
  }
  return out;
}

/**
 * Packs data the same way. Runs shorter than three words are written out as
 * they are: a run costs three words, so two words never pay for themselves
 * and one word of the tag value has to be escaped as a run of one anyway.
 */
export function compressRLEW (data, tag) {
  if (data.length % 2 !== 0) throw new Error(`cannot RLEW ${data.length} bytes: not a whole number of words`);
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const words = data.length / 2;
  const out = [];

  for (let at = 0; at < words;) {
    const word = source.getUint16(at * 2, true);
    let run = 1;
    while (at + run < words && source.getUint16((at + run) * 2, true) === word) run += 1;

    if (run >= 3 || word === tag) {
      out.push(tag, run, word);
      at += run;
    } else {
      for (let i = 0; i < run; i++) out.push(word);
      at += run;
    }
  }

  const packed = new Uint8Array(2 + out.length * 2);
  const write = new DataView(packed.buffer);
  write.setUint16(0, data.length, true);
  for (const [index, word] of out.entries()) write.setUint16(2 + index * 2, word, true);
  return packed;
}
