/**
 * Card A4 — base64 encoding of captured JPEG bytes (no Buffer/btoa in React Native).
 */
import {arrayBufferToBase64, toDataUri} from '../base64';

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe('arrayBufferToBase64', () => {
  test('matches the RFC 4648 padding vectors', () => {
    expect(arrayBufferToBase64(bytes())).toBe('');
    expect(arrayBufferToBase64(bytes(0x66))).toBe('Zg==');
    expect(arrayBufferToBase64(bytes(0x66, 0x6f))).toBe('Zm8=');
    expect(arrayBufferToBase64(bytes(0x66, 0x6f, 0x6f))).toBe('Zm9v');
    expect(arrayBufferToBase64(bytes(0x66, 0x6f, 0x6f, 0x62))).toBe('Zm9vYg==');
    expect(arrayBufferToBase64(bytes(0x66, 0x6f, 0x6f, 0x62, 0x61))).toBe(
      'Zm9vYmE=',
    );
    expect(arrayBufferToBase64(bytes(0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72))).toBe(
      'Zm9vYmFy',
    );
  });

  test('encodes all byte values without throwing', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) {
      all[i] = i;
    }
    const encoded = arrayBufferToBase64(all.buffer);

    expect(encoded).toHaveLength(Math.ceil(256 / 3) * 4);
    expect(encoded.startsWith('AAECAwQFBgcICQoLDA0O')).toBe(true);
    expect(encoded.endsWith('/w==')).toBe(true);
  });

  test('accepts a typed-array view with an offset', () => {
    const backing = new Uint8Array([0x00, 0x66, 0x6f, 0x6f, 0x00]);
    const view = backing.subarray(1, 4);
    expect(arrayBufferToBase64(view)).toBe('Zm9v');
  });

  test('toDataUri wraps a JPEG payload', () => {
    expect(toDataUri('Zm9v')).toBe('data:image/jpeg;base64,Zm9v');
    expect(toDataUri('Zm9v', 'image/png')).toBe(
      'data:image/png;base64,Zm9v',
    );
  });
});
