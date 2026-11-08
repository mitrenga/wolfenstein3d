/**
 * VSWAP - the wall textures, the sprites and the digitised sounds, in one
 * file with one table in front of it.
 *
 * The header is three words: how many chunks there are, where the sprites
 * start and where the sounds start. Then come the offsets, a UINT32LE each,
 * and the lengths, a UINT16LE each.
 *
 * A wall is 4096 raw bytes, one per pixel, stored column first - the order
 * the rasteriser wanted, not the order a picture has.
 *
 * A sprite is 64 x 64 with holes, so it is stored as the columns that have
 * anything in them. Two words say which columns those are, then one offset
 * per column into the posts of that column. A post is three words - the row
 * to stop at, an offset to the pixels, and the row to start at - and the row
 * numbers are doubled, because the original used them as word indices. A
 * zero word ends the column. The pixel of row y is the byte at
 * `chunk[post.offset + y]`, which is how the game itself reads it.
 *
 * The sounds are raw unsigned 8 bit samples at 7000 Hz, in as many pieces of
 * 4096 bytes as they need.
 */

export const TEXTURE_SIZE = 64;
export const TEXTURE_BYTES = TEXTURE_SIZE * TEXTURE_SIZE;
export const TRANSPARENT = 0xff;
export const SOUND_RATE = 7000;                 // ID_SD.C: 256 - 1000000/7000

/** The table at the head of the file. */
export function openSwap (bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = view.getUint16(0, true);
  const firstSprite = view.getUint16(2, true);
  const firstSound = view.getUint16(4, true);
  const offsets = [];
  const lengths = [];
  for (let i = 0; i < chunks; i++) offsets.push(view.getUint32(6 + i * 4, true));
  for (let i = 0; i < chunks; i++) lengths.push(view.getUint16(6 + chunks * 4 + i * 2, true));

  const chunkOf = (index) => {
    if (index < 0 || index >= chunks) throw new Error(`VSWAP chunk ${index} is outside the ${chunks} of the file`);
    if (lengths[index] === 0) return null;
    const start = offsets[index];
    if (start + lengths[index] > bytes.length) throw new Error(`VSWAP chunk ${index} runs past the end of the file`);
    return bytes.subarray(start, start + lengths[index]);
  };

  const kindOf = (index) => (index < firstSprite ? 'wall' : index < firstSound ? 'sprite' : 'sound');

  return { chunks, firstSprite, firstSound, offsets, lengths, chunkOf, kindOf, bytes };
}

/** A wall, transposed out of column order into rows. */
export function decodeWall (chunk) {
  if (chunk.length !== TEXTURE_BYTES) throw new Error(`a wall is ${chunk.length} bytes, expected ${TEXTURE_BYTES}`);
  const pixels = new Uint8Array(TEXTURE_BYTES);
  for (let x = 0; x < TEXTURE_SIZE; x++) {
    for (let y = 0; y < TEXTURE_SIZE; y++) pixels[y * TEXTURE_SIZE + x] = chunk[x * TEXTURE_SIZE + y];
  }
  return pixels;
}

/** And back the way the file holds it. */
export function encodeWall (pixels) {
  const chunk = new Uint8Array(TEXTURE_BYTES);
  for (let x = 0; x < TEXTURE_SIZE; x++) {
    for (let y = 0; y < TEXTURE_SIZE; y++) chunk[x * TEXTURE_SIZE + y] = pixels[y * TEXTURE_SIZE + x];
  }
  return chunk;
}

/** The posts of one sprite, column by column, as the file states them. */
export function spritePosts (chunk) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const first = view.getUint16(0, true);
  const last = view.getUint16(2, true);
  if (last < first || last >= TEXTURE_SIZE) throw new Error(`a sprite spans columns ${first}..${last}`);
  const columns = [];
  for (let column = first; column <= last; column++) {
    let at = view.getUint16(4 + (column - first) * 2, true);
    const posts = [];
    for (;;) {
      const end = view.getUint16(at, true);
      if (end === 0) break;
      // The offset is signed: a column whose pixels sit before its own post
      // list reaches back, and the original reads it as an int too.
      posts.push({ start: view.getUint16(at + 4, true) / 2, end: end / 2, offset: view.getInt16(at + 2, true) });
      at += 6;
    }
    columns.push({ column, posts });
  }
  return { first, last, columns };
}

/**
 * A sprite as 64 x 64 bytes, 0xFF where it is see-through. The pixels are
 * read through the offset word of the post, the way the game reads them; the
 * bytes also follow the posts in order, and checkdat compares the two ways
 * against each other.
 */
export function decodeSprite (chunk) {
  const { columns } = spritePosts(chunk);
  const pixels = new Uint8Array(TEXTURE_BYTES).fill(TRANSPARENT);
  for (const { column, posts } of columns) {
    for (const post of posts) {
      for (let y = post.start; y < post.end; y++) {
        const at = post.offset + y;
        if (at < 0 || at >= chunk.length) throw new Error(`a sprite post points at byte ${at} of a ${chunk.length} byte chunk`);
        pixels[y * TEXTURE_SIZE + column] = chunk[at];
      }
    }
  }
  return pixels;
}

/** The same picture packed back into posts. */
export function encodeSprite (pixels) {
  const columns = [];
  let first = -1;
  let last = -1;
  for (let x = 0; x < TEXTURE_SIZE; x++) {
    const posts = [];
    let y = 0;
    while (y < TEXTURE_SIZE) {
      while (y < TEXTURE_SIZE && pixels[y * TEXTURE_SIZE + x] === TRANSPARENT) y += 1;
      if (y >= TEXTURE_SIZE) break;
      const start = y;
      while (y < TEXTURE_SIZE && pixels[y * TEXTURE_SIZE + x] !== TRANSPARENT) y += 1;
      posts.push({ start, end: y });
    }
    if (posts.length > 0) {
      if (first < 0) first = x;
      last = x;
    }
    columns.push(posts);
  }
  if (first < 0) { first = 0; last = 0; columns[0] = []; }

  const width = last - first + 1;
  const postWords = columns.slice(first, last + 1).reduce((sum, posts) => sum + posts.length * 3 + 1, 0);
  const pixelStart = (2 + width + postWords) * 2;
  let pixelCount = 0;
  for (const posts of columns.slice(first, last + 1)) {
    for (const post of posts) pixelCount += post.end - post.start;
  }

  const chunk = new Uint8Array(pixelStart + pixelCount);
  const view = new DataView(chunk.buffer);
  view.setUint16(0, first, true);
  view.setUint16(2, last, true);

  let postAt = (2 + width) * 2;
  let pixelAt = pixelStart;
  for (let x = first; x <= last; x++) {
    view.setUint16(4 + (x - first) * 2, postAt, true);
    for (const post of columns[x]) {
      // The offset is picked so that `chunk[offset + y]` is the pixel of row
      // y, which is what the game does with it.
      view.setUint16(postAt, post.end * 2, true);
      view.setInt16(postAt + 2, pixelAt - post.start, true);
      view.setUint16(postAt + 4, post.start * 2, true);
      postAt += 6;
      for (let y = post.start; y < post.end; y++) chunk[pixelAt++] = pixels[y * TEXTURE_SIZE + x];
    }
    view.setUint16(postAt, 0, true);
    postAt += 2;
  }
  return chunk;
}

/**
 * The table of digitised sounds, which the game keeps in the very last chunk
 * of the file: a start page and a length in bytes for each one, the pages
 * counted from the first sound chunk.
 *
 * The shareware file carries the whole table of the registered game but only
 * the sounds episode one needs; the rest point at chunks of zero length, so
 * `present` says which ones are really there.
 */
export function soundTable (swap) {
  const last = swap.chunkOf(swap.chunks - 1);
  if (!last) throw new Error('the last VSWAP chunk, which holds the sound table, is empty');
  const view = new DataView(last.buffer, last.byteOffset, last.byteLength);
  const sounds = [];
  for (let at = 0; at + 4 <= last.length; at += 4) {
    const start = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    const pages = Math.ceil(length / TEXTURE_BYTES);
    let present = length > 0;
    for (let page = 0; page < pages && present; page++) {
      const chunk = swap.firstSound + start + page;
      present = chunk < swap.chunks - 1 && swap.lengths[chunk] > 0;
    }
    sounds.push({ index: sounds.length, start, length, pages, present });
  }
  return sounds;
}

/** The samples of one entry of that table, glued out of its chunks. */
export function readSound (swap, entry) {
  const out = new Uint8Array(entry.length);
  let written = 0;
  for (let chunk = swap.firstSound + entry.start; written < entry.length; chunk++) {
    const piece = swap.chunkOf(chunk);
    if (!piece) throw new Error(`sound chunk ${chunk} is empty but the table asks for it`);
    const take = Math.min(piece.length, entry.length - written);
    out.set(piece.subarray(0, take), written);
    written += take;
  }
  return out;
}
