/**
 * LZEXE 0.91 - the packer WOLF3D.EXE of the shareware release is wrapped in.
 *
 * The file looks like an ordinary MZ program with no relocations at all and
 * the four bytes `LZ91` where the relocation table would start. Its load
 * image is the compressed program, and behind it sits the unpacker, whose
 * first sixteen bytes are a record of what it is going to do:
 *
 *   ip, cs, sp, ss   the registers of the original program
 *   packed           the size of the compressed image in paragraphs
 *   increase         how many paragraphs the image grows by
 *   loader           the length of the unpacker itself
 *   checksum
 *
 * The stream in front of it is a bit stream with three kinds of token, read
 * from words of sixteen bits, lowest bit first:
 *
 *   1                a literal byte follows
 *   0 0 l l b        copy 2..5 bytes from 1..256 back
 *   0 1 <two bytes>  copy from up to 8192 back; the length is the low three
 *                    bits of the second byte, and a zero there means the
 *                    length is in a byte of its own - 0 ends the stream and
 *                    1 changes segment, which for a flat image is nothing.
 *
 * The one thing that has to be copied from the unpacker rather than guessed
 * is **when the next bit word is read**: the code fetches it the moment the
 * counter runs out, which is *before* the byte of the token that used the
 * last bit. Reading it a byte later - the obvious way round - decodes the
 * first 24 bytes correctly and then walks off the rails, which is what
 * happened here first (NOTES.md para 5).
 *
 * The unpacker is read for its behaviour only; nothing of it is copied.
 */

const SIGNATURE = 'LZ91';
const SIGNATURE_AT = 0x1c;
const PARAGRAPH = 16;

/** The fields of an MZ header this needs. */
export function readExeHeader (bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x5a4d) throw new Error('not an MZ program');
  return {
    pages: view.getUint16(2, true),
    lastPage: view.getUint16(4, true),
    relocations: view.getUint16(6, true),
    headerParagraphs: view.getUint16(8, true),
    ss: view.getUint16(14, true),
    sp: view.getUint16(16, true),
    ip: view.getUint16(20, true),
    cs: view.getInt16(22, true),
    relocationTable: view.getUint16(24, true)
  };
}

/** Whether this program is packed with LZEXE 0.91. */
export function isPacked (bytes) {
  return String.fromCharCode(...bytes.subarray(SIGNATURE_AT, SIGNATURE_AT + 4)) === SIGNATURE;
}

/** The unpacker's record, and where in the file the compressed stream is. */
export function packedInfo (bytes) {
  const header = readExeHeader(bytes);
  const at = (header.headerParagraphs + header.cs) * PARAGRAPH;
  if (at + 16 > bytes.length) throw new Error('the LZEXE record lies outside the file');
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, 16);
  const info = {
    ip: view.getUint16(0, true),
    cs: view.getUint16(2, true),
    sp: view.getUint16(4, true),
    ss: view.getUint16(6, true),
    packedParagraphs: view.getUint16(8, true),
    increaseParagraphs: view.getUint16(10, true),
    loaderBytes: view.getUint16(12, true),
    checksum: view.getUint16(14, true)
  };
  info.recordAt = at;
  info.start = header.headerParagraphs * PARAGRAPH;
  info.end = at;
  info.header = header;
  if (info.end - info.start !== info.packedParagraphs * PARAGRAPH) {
    throw new Error(`the record says ${info.packedParagraphs} paragraphs of compressed data, the file has ` +
      `${(info.end - info.start) / PARAGRAPH}`);
  }
  return info;
}

/**
 * The load image of the program as DOS would have it in memory, minus the
 * relocations - which nothing here needs, because the tables are looked for
 * by what is in them, not by an address.
 *
 * @param {Uint8Array} bytes - The whole packed program.
 * @returns {{image: Uint8Array, info: Object, tokens: number}}
 */
export function unpack (bytes) {
  if (!isPacked(bytes)) throw new Error('the program is not packed with LZEXE 0.91');
  const info = packedInfo(bytes);

  let at = info.start;
  const nextByte = () => {
    if (at >= info.end) throw new Error('the compressed stream ends in the middle of a token');
    return bytes[at++];
  };
  const nextWord = () => {
    const low = nextByte();
    return low | (nextByte() << 8);
  };

  let bits = nextWord();
  let left = 16;
  const nextBit = () => {
    const bit = bits & 1;
    bits >>>= 1;
    // the unpacker reloads the moment the counter runs out, before the bytes
    // of the token that used the last bit - see the note at the top
    if (--left === 0) { bits = nextWord(); left = 16; }
    return bit;
  };

  const out = [];
  let tokens = 0;
  for (;;) {
    tokens += 1;
    if (nextBit()) { out.push(nextByte()); continue; }
    let span;
    let length;
    if (!nextBit()) {
      length = ((nextBit() << 1) | nextBit()) + 2;
      span = (0xff00 | nextByte()) - 0x10000;
    } else {
      const low = nextByte();
      const high = nextByte();
      span = (0xe000 | ((high >> 3) << 8) | low) - 0x10000;
      length = (high & 7) + 2;
      if (length === 2) {
        length = nextByte();
        if (length === 0) break;        // the end of the image
        if (length === 1) continue;     // a segment of the image ends; flat here
        length += 1;
      }
    }
    const from = out.length + span;
    if (from < 0) throw new Error(`a reference reaches ${-from} bytes before the start of the image`);
    for (let i = 0; i < length; i++) out.push(out[from + i]);
  }
  return { image: Uint8Array.from(out), info, tokens };
}

/** The program as it is in memory, packed or not. */
export function loadImage (bytes) {
  if (!isPacked(bytes)) {
    const header = readExeHeader(bytes);
    const start = header.headerParagraphs * PARAGRAPH;
    const size = (header.pages - 1) * 512 + (header.lastPage || 512) - start;
    return { image: bytes.subarray(start, start + size), info: null, tokens: 0 };
  }
  return unpack(bytes);
}
