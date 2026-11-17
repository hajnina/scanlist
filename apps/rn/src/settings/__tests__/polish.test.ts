/**
 * Card A6 — the polish copy decisions (POLISH.md items that are pure logic): camera permission,
 * "nothing in frame yet" / low-light guidance, and the quiet-time calculation behind it.
 */
import {
  QUIET_GUIDANCE_MS,
  quietFor,
  scanGuidance,
} from '../polish';

describe('quietFor', () => {
  test('null until a source has fired (a starting camera is not "nothing found")', () => {
    expect(quietFor({barcode: 0, ocr: 0, image: 0}, 10_000)).toBeNull();
  });

  test('measures from the newest of the three sources', () => {
    expect(quietFor({barcode: 0, ocr: 5_000, image: 8_000}, 10_000)).toBe(
      2_000,
    );
    expect(quietFor({barcode: 9_000, ocr: 5_000, image: 8_000}, 10_000)).toBe(
      1_000,
    );
  });

  test('never negative when the clock disagrees with an activity stamp', () => {
    expect(quietFor({barcode: 0, ocr: 0, image: 12_000}, 10_000)).toBeNull();
  });
});

describe('scanGuidance', () => {
  test('no permission and the OS can still ask: the allow copy', () => {
    expect(
      scanGuidance({hasPermission: false, canRequestPermission: true}),
    ).toMatchObject({
      kind: 'camera',
      title: 'The magic scan needs the camera',
    });
  });

  test('denied for good: the open-Settings copy', () => {
    expect(
      scanGuidance({hasPermission: false, canRequestPermission: false}),
    ).toMatchObject({
      kind: 'camera',
      title: 'Camera permission is blocked',
    });
  });

  test('permission is the highest priority hint', () => {
    expect(
      scanGuidance({
        hasPermission: false,
        canRequestPermission: true,
        quietMs: QUIET_GUIDANCE_MS,
      })?.kind,
    ).toBe('camera');
  });

  test('quiet long enough: the point-steady/low-light copy', () => {
    const guidance = scanGuidance({
      hasPermission: true,
      quietMs: QUIET_GUIDANCE_MS,
    });
    expect(guidance).toMatchObject({kind: 'light'});
    expect(guidance?.detail).toContain('low light');
    expect(guidance?.detail).toContain('torch');
  });

  test('still scanning: no hint (do not nag)', () => {
    expect(
      scanGuidance({hasPermission: true, quietMs: QUIET_GUIDANCE_MS - 1}),
    ).toBeNull();
    expect(scanGuidance({hasPermission: true, quietMs: null})).toBeNull();
  });
});
