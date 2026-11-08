/**
 * Carmack compression - the second layer over the map planes of GAMEMAPS.
 *
 * It works over words and refers back to what has already been written, like
 * a small LZ77. There are two kinds of reference:
 *
 *   count, 0xA7, backWords        near - count words, counted back from here
 *   count, 0xA8, fromStart:word   far  - count words, counted from the start
 *
 * A word whose high byte is 0xA7 or 0xA8 would look like a reference, so it
 * is escaped as `0x00, 0xA7|0xA8, lowByte` - a count of zero cannot mean a
 * real reference.
 *
 * As in RLEW, the stream starts with a UINT16LE holding the expanded size in
 * bytes; here it is always honoured, because nothing else knows it.
 */

const NEAR = 0xa7;
const FAR = 0xa8;

/** Expands one stream, including its leading size word. */
export function expandCarmack (chunk) {
  if (chunk.length < 2) throw new Error('Carmack stream shorter than its size word');
  const target = chunk[0] | (chunk[1] << 8);
  if (target % 2 !== 0) throw new Error(`Carmack expanded size ${target} is not a whole number of words`);

  const out = new Uint8Array(target);
  let read = 2;
  let written = 0;

  while (written < target) {
    if (read + 2 > chunk.length) throw new Error('Carmack stream ended before the expanded size was reached');
    const count = chunk[read];
    const tag = chunk[read + 1];

    if (tag !== NEAR && tag !== FAR) {           // a word of its own
      out[written] = count;
      out[written + 1] = tag;
      read += 2;
      written += 2;
      continue;
    }

    if (count === 0) {                            // the escape: 00 Ax yy
      if (read + 3 > chunk.length) throw new Error('Carmack escape is cut off');
      out[written] = chunk[read + 2];
      out[written + 1] = tag;
      read += 3;
      written += 2;
      continue;
    }

    let from;
    if (tag === NEAR) {
      if (read + 3 > chunk.length) throw new Error('Carmack near pointer is cut off');
      const back = chunk[read + 2];
      from = written - back * 2;
      read += 3;
    } else {
      if (read + 4 > chunk.length) throw new Error('Carmack far pointer is cut off');
      from = (chunk[read + 2] | (chunk[read + 3] << 8)) * 2;
      read += 4;
    }
    if (from < 0) throw new Error('Carmack pointer reaches before the start of the output');
    if (written + count * 2 > target) throw new Error('Carmack copy overruns the expanded size');
    // Word by word on purpose: a near pointer may overlap the output it is
    // still writing, which is how a run of one word is expressed.
    for (let i = 0; i < count * 2; i++) out[written + i] = out[from + i];
    written += count * 2;
  }
  return out;
}

const MAX_COUNT = 255;
const CANDIDATE_LIMIT = 64;   // how far back to look; the maps are 8 KB

/** Longest match for the words at `at`, searched over the pairs seen so far. */
function longestMatch (words, at, seen) {
  const key = words[at] * 65536 + words[at + 1];
  const candidates = seen.get(key);
  if (!candidates) return null;
  let best = null;
  for (let i = candidates.length - 1, tried = 0; i >= 0 && tried < CANDIDATE_LIMIT; i--, tried++) {
    const from = candidates[i];
    let length = 0;
    while (length < MAX_COUNT && at + length < words.length && words[from + length] === words[at + length]) length += 1;
    if (length >= 2 && (best === null || length > best.length)) best = { from, length };
  }
  return best;
}

/**
 * Packs data the same way. The original packer is gone and there are many
 * valid ones, so this is not an attempt to reproduce its output - it only
 * has to be a stream our own expander reads back byte for byte, which is the
 * criterion of W1.
 */
export function compressCarmack (data) {
  if (data.length % 2 !== 0) throw new Error(`cannot carmackize ${data.length} bytes: not a whole number of words`);
  if (data.length > 0xffff) throw new Error(`cannot carmackize ${data.length} bytes: the size word holds 65535`);
  const count = data.length / 2;
  const words = new Uint16Array(count);
  for (let i = 0; i < count; i++) words[i] = data[i * 2] | (data[i * 2 + 1] << 8);

  const out = [];
  const seen = new Map();
  const remember = (at) => {
    if (at + 1 >= count) return;
    const key = words[at] * 65536 + words[at + 1];
    const candidates = seen.get(key);
    if (candidates) candidates.push(at); else seen.set(key, [at]);
  };

  for (let at = 0; at < count;) {
    const match = at + 1 < count ? longestMatch(words, at, seen) : null;
    const back = match === null ? 0 : at - match.from;

    // A near pointer costs three bytes and reaches 255 words back, a far one
    // costs four and reaches anywhere; two words are four bytes on their own.
    if (match !== null && back <= 255 && match.length >= 2) {
      out.push(match.length, NEAR, back);
    } else if (match !== null && match.length >= 3) {
      out.push(match.length, FAR, match.from & 0xff, (match.from >> 8) & 0xff);
    } else {
      const word = words[at];
      const high = word >> 8;
      if (high === NEAR || high === FAR) out.push(0, high, word & 0xff);
      else out.push(word & 0xff, high);
      remember(at);
      at += 1;
      continue;
    }
    for (let i = 0; i < match.length; i++) remember(at + i);
    at += match.length;
  }

  const packed = new Uint8Array(2 + out.length);
  packed[0] = data.length & 0xff;
  packed[1] = (data.length >> 8) & 0xff;
  packed.set(out, 2);
  return packed;
}
