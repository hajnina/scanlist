/**
 * Minimal base64 encoder for captured frames (card A4).
 *
 * `Photo.getFileDataAsync()` hands back the JPEG as an `ArrayBuffer`, and React Native ships no
 * `Buffer`/`btoa` for binary data. The image scan source therefore encodes the bytes here before
 * passing them to the embedder (a JPEG base64 string crosses the JS↔native bridge cheaply and is
 * what the server/ONNX backends accept too).
 *
 * Pure on purpose: unit-tested against the RFC 4648 test vectors.
 */

/* eslint-disable no-bitwise -- base64 is bit-packing; shifts/masks are the clearest form here. */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function arrayBufferToBase64(
  buffer: ArrayBuffer | ArrayBufferView,
): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const parts: string[] = [];
  // Build 4-char groups in chunks so long frames do not thrash the JS string heap.
  const chunkSize = 3 * 4096;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    let chunk = '';
    for (let i = offset; i < end; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < end ? bytes[i + 1] : undefined;
      const b2 = i + 2 < end ? bytes[i + 2] : undefined;

      chunk += ALPHABET[b0 >> 2];
      chunk += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
      chunk +=
        b1 === undefined
          ? '='
          : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
      chunk += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
    }
    parts.push(chunk);
  }
  return parts.join('');
}

/** `data:image/jpeg;base64,…` — convenience for the network/backend embedder. */
export function toDataUri(
  base64: string,
  mimeType: string = 'image/jpeg',
): string {
  return `data:${mimeType};base64,${base64}`;
}
