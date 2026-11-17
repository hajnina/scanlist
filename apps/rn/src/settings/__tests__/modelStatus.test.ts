/**
 * Card A6 — model-bundle status decisions (RN twin of B6's `ModelStatus.kt`): every branch of the
 * file facts, the E_NO_MODEL line, the pinned-size label and the EXPECTED sha label. No 484 MB
 * fixture: the facts are just data.
 */
import {
  E_NO_MODEL,
  EXPECTED_MODEL_BYTES,
  EXPECTED_MODEL_SHA256,
  PUSH_HINT,
  factsFromNativeStatus,
  formatBytes,
  isModelReady,
  modelStatusFromFacts,
  modelStatusLine,
  pushHint,
  sha256Label,
  sizeMatches,
  sizeNote,
} from '../modelStatus';

const PATH =
  '/data/user/0/dev.hajnina.scanlist.rn/files/models/embeddinggemma-2-740m.litertlm';

describe('modelStatusFromFacts', () => {
  test('missing when the path does not exist', () => {
    expect(modelStatusFromFacts({path: PATH, exists: false})).toEqual({
      kind: 'missing',
      path: PATH,
    });
  });

  test('present carries size and mtime, defaulting mtime to 0', () => {
    expect(
      modelStatusFromFacts({
        path: PATH,
        exists: true,
        bytes: EXPECTED_MODEL_BYTES,
        lastModified: 17,
      }),
    ).toEqual({
      kind: 'present',
      path: PATH,
      bytes: EXPECTED_MODEL_BYTES,
      lastModified: 17,
    });
    expect(
      modelStatusFromFacts({
        path: PATH,
        exists: true,
        bytes: EXPECTED_MODEL_BYTES,
      }),
    ).toMatchObject({lastModified: 0});
  });

  test('a directory is unreadable (not a regular file)', () => {
    expect(
      modelStatusFromFacts({path: PATH, exists: true, isFile: false, bytes: 0}),
    ).toMatchObject({kind: 'unreadable', reason: 'not a regular file'});
  });

  test('a shell-owned (unreadable) push names the fix', () => {
    expect(
      modelStatusFromFacts({
        path: PATH,
        exists: true,
        readable: false,
        bytes: EXPECTED_MODEL_BYTES,
      }),
    ).toMatchObject({
      kind: 'unreadable',
      reason: expect.stringContaining('scripts/model.sh push'),
    });
  });

  test('an empty or unstated size is unreadable, never "present at 0 B"', () => {
    expect(modelStatusFromFacts({path: PATH, exists: true})).toMatchObject({
      kind: 'unreadable',
      reason: 'empty file',
    });
    expect(
      modelStatusFromFacts({path: PATH, exists: true, bytes: 0}),
    ).toMatchObject({kind: 'unreadable'});
    expect(
      modelStatusFromFacts({path: PATH, exists: true, bytes: -1}),
    ).toMatchObject({kind: 'unreadable'});
  });

  test('readable defaults to true and isFile defaults to true', () => {
    expect(
      modelStatusFromFacts({path: PATH, exists: true, bytes: 1}),
    ).toMatchObject({kind: 'present', bytes: 1});
  });
});

describe('factsFromNativeStatus', () => {
  test('maps the bridge status and passes the pinned path through', () => {
    expect(
      factsFromNativeStatus({
        modelPresent: true,
        modelPath: PATH,
        modelBytes: EXPECTED_MODEL_BYTES,
        modelReadable: true,
      }),
    ).toEqual({
      path: PATH,
      exists: true,
      isFile: true,
      readable: true,
      bytes: EXPECTED_MODEL_BYTES,
    });
  });

  test('missing stays missing (isFile is not claimed)', () => {
    expect(
      factsFromNativeStatus({modelPresent: false, modelPath: PATH}),
    ).toEqual({
      path: PATH,
      exists: false,
      isFile: false,
      readable: undefined,
      bytes: undefined,
    });
  });
});

describe('size and readiness', () => {
  test('ready only when present at the exact pinned size', () => {
    expect(
      isModelReady(
        modelStatusFromFacts({
          path: PATH,
          exists: true,
          bytes: EXPECTED_MODEL_BYTES,
        }),
      ),
    ).toBe(true);
    expect(
      isModelReady(
        modelStatusFromFacts({
          path: PATH,
          exists: true,
          bytes: EXPECTED_MODEL_BYTES - 1,
        }),
      ),
    ).toBe(false);
    expect(isModelReady({kind: 'missing', path: PATH})).toBe(false);
    expect(
      isModelReady({kind: 'unreadable', path: PATH, reason: 'x'}),
    ).toBe(false);
  });

  test('sizeMatches is exact, not approximate', () => {
    expect(sizeMatches(EXPECTED_MODEL_BYTES)).toBe(true);
    expect(sizeMatches(EXPECTED_MODEL_BYTES + 1)).toBe(false);
  });

  test('formatBytes groups thousands and shows MiB (B6 formatBytes)', () => {
    expect(formatBytes(EXPECTED_MODEL_BYTES)).toBe('484,622,336 B · 462.2 MiB');
    expect(formatBytes(1234567)).toBe('1,234,567 B · 1.2 MiB');
  });

  test('formatBytes is safe for junk input', () => {
    expect(formatBytes(0)).toBe('0 B · 0.0 MiB');
    expect(formatBytes(-5)).toBe('0 B · 0.0 MiB');
    expect(formatBytes(Number.NaN)).toBe('0 B · 0.0 MiB');
  });

  test('sizeNote says match or names the expected size', () => {
    expect(sizeNote(EXPECTED_MODEL_BYTES)).toBe(
      'matches the pinned bundle size',
    );
    const wrong = sizeNote(EXPECTED_MODEL_BYTES - 1024);
    expect(wrong).toContain('expected 484,622,336 B');
    expect(wrong).toContain('wrong or truncated');
  });
});

describe('sha label', () => {
  test('the pinned sha is shown as EXPECTED and explicitly not recomputed', () => {
    const label = sha256Label();
    expect(label).toContain('EXPECTED e7a8a220');
    expect(label).toContain('7f4c');
    expect(label).toContain('not recomputed here');
    expect(label).not.toContain(EXPECTED_MODEL_SHA256);
  });

  test('short hashes are printed whole, not sliced into nonsense', () => {
    expect(sha256Label('abc')).toBe('EXPECTED abc · not recomputed here');
  });
});

describe('modelStatusLine and pushHint', () => {
  test('missing starts with E_NO_MODEL and includes the path', () => {
    const line = modelStatusLine({kind: 'missing', path: PATH});
    expect(line.startsWith(E_NO_MODEL)).toBe(true);
    expect(line).toContain(PATH);
    expect(line).toContain('no bundle at');
  });

  test('present includes size and the match note', () => {
    expect(
      modelStatusLine(
        modelStatusFromFacts({
          path: PATH,
          exists: true,
          bytes: EXPECTED_MODEL_BYTES,
        }),
      ),
    ).toBe('present · 484,622,336 B · 462.2 MiB · matches the pinned bundle size');
  });

  test('unreadable names the reason', () => {
    expect(
      modelStatusLine({kind: 'unreadable', path: PATH, reason: 'empty file'}),
    ).toBe('unreadable · empty file');
  });

  test('pushHint prefers the package-specific native command', () => {
    expect(pushHint('adb shell scripts/model.sh push dev.x')).toBe(
      'adb shell scripts/model.sh push dev.x',
    );
    expect(pushHint('   ')).toBe(PUSH_HINT);
    expect(pushHint(null)).toBe(PUSH_HINT);
    expect(pushHint(undefined)).toBe(PUSH_HINT);
  });
});
