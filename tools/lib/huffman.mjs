/**
 * The Huffman layer of VGAGRAPH, with its table in VGADICT.
 *
 * The table is 255 nodes of two words; node 254 is the root. Bits are read
 * from the low end of each byte upwards: a zero takes the first word, a one
 * the second. A value below 256 is a byte of the output and sends the walk
 * back to the root, anything else is 256 + the index of the next node.
 *
 * VGADICT is 1024 bytes, of which the last four are padding - 255 nodes are
 * 1020 bytes.
 */

export const ROOT = 254;
export const NODES = 255;
export const DICTIONARY_SIZE = 1024;

/** The 255 nodes of VGADICT. */
export function readDictionary (bytes) {
  if (bytes.length < NODES * 4) throw new Error(`VGADICT is ${bytes.length} bytes, expected at least 1020`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodes = new Uint16Array(NODES * 2);
  for (let i = 0; i < NODES * 2; i++) nodes[i] = view.getUint16(i * 2, true);
  return nodes;
}

/** Writes a table back out in the shape VGADICT has, padding included. */
export function writeDictionary (nodes) {
  const bytes = new Uint8Array(DICTIONARY_SIZE);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < NODES * 2; i++) view.setUint16(i * 2, nodes[i], true);
  return bytes;
}

/** Expands `expandedBytes` bytes out of the bit stream in `chunk`. */
export function expandHuffman (chunk, nodes, expandedBytes) {
  const out = new Uint8Array(expandedBytes);
  if (expandedBytes === 0) return out;

  let node = ROOT;
  let read = 0;
  let written = 0;
  let past = 0;                 // bytes asked for after the stream ran out
  let input = chunk[read++] ?? 0;
  let mask = 0x01;

  while (written < expandedBytes) {
    const value = (input & mask) === 0 ? nodes[node * 2] : nodes[node * 2 + 1];
    if (mask === 0x80) {
      // The last byte of output often falls inside the last byte of input,
      // so one refill past the end is normal; two means the stream is short.
      if (read >= chunk.length && ++past > 1) throw new Error('Huffman stream ended early');
      input = chunk[read++] ?? 0;
      mask = 0x01;
    } else {
      mask <<= 1;
    }
    if (value < 256) {
      out[written++] = value;
      node = ROOT;
    } else {
      node = value - 256;
    }
  }
  return out;
}

/** The code of every byte the table can express, as an array of bits. */
export function codesOf (nodes) {
  const codes = new Array(256).fill(null);
  const walk = (node, bits) => {
    if (bits.length > 255) throw new Error('Huffman table has a cycle');
    for (const branch of [0, 1]) {
      const value = nodes[node * 2 + branch];
      if (value < 256) {
        if (codes[value] === null) codes[value] = [...bits, branch];
      } else {
        walk(value - 256, [...bits, branch]);
      }
    }
  };
  walk(ROOT, []);
  return codes;
}

/**
 * Packs with a table that already exists - the game's own, so what comes out
 * is a stream the game's own table reads back. Which bits id's packer would
 * have written is not the question W1 asks; there are many packers and one
 * expander, the same rule Lemmings settled on in L1.
 */
export function compressHuffman (data, nodes) {
  const codes = codesOf(nodes);
  const out = [];
  let input = 0;
  let mask = 0x01;
  for (const byte of data) {
    const code = codes[byte];
    if (code === null) throw new Error(`byte ${byte} has no code in this Huffman table`);
    for (const bit of code) {
      if (bit) input |= mask;
      if (mask === 0x80) { out.push(input); input = 0; mask = 0x01; } else mask <<= 1;
    }
  }
  if (mask !== 0x01) out.push(input);
  return Uint8Array.from(out);
}

/**
 * Builds a table in the shape id's expander wants, for the self test - the
 * game data only ever needs the table it ships with. Every byte value gets a
 * weight of at least one, so all 256 have a code and the merges come out as
 * exactly 255 nodes with the root last, where the expander looks for it.
 */
export function buildDictionary (data) {
  const weights = new Array(256).fill(1);
  for (const byte of data) weights[byte] += 1;

  const heap = weights.map((weight, value) => ({ weight, value }));
  const nodes = new Uint16Array(NODES * 2);
  for (let index = 0; index < NODES; index++) {
    heap.sort((left, right) => left.weight - right.weight || left.value - right.value);
    const first = heap.shift();
    const second = heap.shift();
    nodes[index * 2] = first.value;
    nodes[index * 2 + 1] = second.value;
    heap.push({ weight: first.weight + second.weight, value: 256 + index });
  }
  return nodes;
}
