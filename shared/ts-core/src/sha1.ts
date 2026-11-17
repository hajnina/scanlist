/**
 * Dependency-free SHA-1 (lowercase hex) for derived item ids (FLATTEN.md §3.2).
 *
 * `node:crypto` would be one line but it does not exist in React Native or the browser, and this
 * package is shared by both (zero runtime deps, ESM). The implementation is the plain FIPS 180-1
 * algorithm over UTF-8 bytes; the unit tests pin it against the FLATTEN.md worked ids and the
 * standard `sha1("")` / `sha1("abc")` vectors.
 */

const encoder = new TextEncoder();

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** Lowercase hex SHA-1 of the UTF-8 bytes of `input`. */
export function sha1Hex(input: string): string {
  const bytes = encoder.encode(input);
  const bitLength = bytes.length * 8;
  // 0x80 terminator + 8-byte big-endian bit length, padded to a 64-byte block boundary.
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high);
  view.setUint32(paddedLength - 4, low);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const words = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 80; i += 1) {
      const w15 = words[i - 3] as number;
      const w8 = words[i - 8] as number;
      const w14 = words[i - 14] as number;
      const w16 = words[i - 16] as number;
      words[i] = rotl(w15 ^ w8 ^ w14 ^ w16, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + (words[i] as number)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}
