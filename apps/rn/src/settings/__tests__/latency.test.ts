/**
 * Card A6 — the settings self-test (RN twin of B6's `Latency.kt`) with a fake probe and a fake
 * clock: the model check / E_NO_MODEL short-circuit, the warm-up being excluded from the mean, the
 * backend read *after* the warm-up (so a GPU→CPU fallback is reported honestly), one open/close per
 * run, close-on-failure, and the formatters the latency card and tests share.
 */
import {
  E_EMBEDDER,
  E_NO_BACKEND,
  E_NO_MODEL,
  SAMPLE_TEXTS,
  WARMUP_TEXT,
  createSelfTestRunner,
  formatMean,
  formatMillis,
  latencyHeadline,
  meanMillis,
  sampleRange,
  supportsLine,
  type EngineProbe,
  type LatencyReport,
} from '../latency';

/** A probe whose backend only settles during the warm-up, as the real ladder does. */
function fakeProbe(
  options: {
    backendAfterWarmup?: string;
    failSample?: string;
    closeError?: unknown;
  } = {},
): EngineProbe & {calls: string[][]; closed: number} {
  let backend = 'none';
  const calls: string[][] = [];
  const probe = {
    get backend() {
      return backend;
    },
    dims: 256,
    supportsImages: true,
    async embedDocs(texts: string[]) {
      calls.push(texts);
      if (texts.includes(WARMUP_TEXT)) {
        backend = options.backendAfterWarmup ?? 'cpu';
        return [[0.1]];
      }
      if (options.failSample !== undefined && texts.includes(options.failSample)) {
        throw Object.assign(new Error(`cannot embed ${texts[0]}`), {
          code: 'E_EMBEDDER',
        });
      }
      return [[0.2]];
    },
    async close() {
      probe.closed += 1;
      if (options.closeError !== undefined) {
        throw options.closeError;
      }
    },
    calls,
    closed: 0,
  };
  return probe;
}

/** A clock that returns the given instants in order (and repeats the last one). */
function clockOf(instants: number[]): () => number {
  let index = 0;
  return () => {
    const value = instants[Math.min(index, instants.length - 1)];
    index += 1;
    return value;
  };
}

describe('createSelfTestRunner', () => {
  test('opens once, excludes the warm-up from the mean, and reports the settled backend', async () => {
    const probe = fakeProbe({backendAfterWarmup: 'gpu'});
    const opened: string[] = [];
    const runner = createSelfTestRunner({
      open: async choice => {
        opened.push(choice);
        return probe;
      },
      now: clockOf([1000, 2500, 3000, 3012, 4000, 4025]),
      samples: ['milk', 'sourdough bread'],
    });

    const outcome = await runner.selfTest('auto');

    expect(outcome).toMatchObject({ok: true, choice: 'auto'});
    if (!outcome.ok) {
      throw new Error('expected a successful run');
    }
    expect(opened).toEqual(['auto']);
    expect(outcome.report.backend).toBe('gpu');
    expect(outcome.report.loadMillis).toBe(1500);
    expect(outcome.report.samples).toEqual([
      {text: 'milk', millis: 12},
      {text: 'sourdough bread', millis: 25},
    ]);
    // The warm-up is one extra call, not a fourth sample.
    expect(outcome.report.samples).toHaveLength(2);
    expect(probe.calls[0]).toEqual([WARMUP_TEXT]);
    expect(probe.closed).toBe(1);
  });

  test('the default sample set is the three fixed shopping-list documents', async () => {
    const probe = fakeProbe();
    const runner = createSelfTestRunner({
      open: async () => probe,
      now: () => 0,
    });

    const outcome = await runner.selfTest('cpu');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.report.samples.map(sample => sample.text)).toEqual([
        ...SAMPLE_TEXTS,
      ]);
    }
  });

  test('a missing bundle short-circuits with E_NO_MODEL and never opens the engine', async () => {
    let opened = false;
    const runner = createSelfTestRunner({
      checkModel: async () => ({present: false, path: '/data/models/x.litertlm'}),
      open: async () => {
        opened = true;
        return fakeProbe();
      },
    });

    const outcome = await runner.selfTest('gpu');

    expect(opened).toBe(false);
    expect(outcome).toMatchObject({ok: false, choice: 'gpu', code: E_NO_MODEL});
    if (!outcome.ok) {
      expect(outcome.message).toContain('/data/models/x.litertlm');
      expect(outcome.message).toContain('scripts/model.sh push');
    }
  });

  test('a throwing model check is also E_NO_MODEL, not an embedder crash', async () => {
    const runner = createSelfTestRunner({
      checkModel: async () => {
        throw new Error('stat failed');
      },
      open: async () => fakeProbe(),
    });

    const outcome = await runner.selfTest('auto');
    expect(outcome).toMatchObject({
      ok: false,
      code: E_NO_MODEL,
      message: 'stat failed',
    });
  });

  test('an open failure carries the bridge code and the ladder reasons', async () => {
    const error = Object.assign(new Error('no backend'), {
      code: E_NO_BACKEND,
      reasons: ['gpu: adapter unavailable', 'cpu: n/a'],
    });
    const runner = createSelfTestRunner({
      open: async () => {
        throw error;
      },
    });

    const outcome = await runner.selfTest('gpu');
    expect(outcome).toMatchObject({
      ok: false,
      choice: 'gpu',
      code: E_NO_BACKEND,
      message: 'no backend',
      reasons: ['gpu: adapter unavailable', 'cpu: n/a'],
    });
  });

  test('an error without a code becomes E_EMBEDDER and filters junk reasons', async () => {
    const runner = createSelfTestRunner({
      open: async () => {
        throw Object.assign(new Error('boom'), {reasons: ['ok', 7, null]});
      },
    });

    const outcome = await runner.selfTest('cpu');
    expect(outcome).toMatchObject({
      ok: false,
      code: E_EMBEDDER,
      reasons: ['ok'],
    });
  });

  test('close runs after a failed measurement (no stranded resident model)', async () => {
    const probe = fakeProbe({failSample: 'milk'});
    const runner = createSelfTestRunner({
      open: async () => probe,
      now: () => 0,
      samples: ['milk'],
    });

    const outcome = await runner.selfTest('auto');
    expect(outcome).toMatchObject({ok: false, code: E_EMBEDDER});
    expect(probe.closed).toBe(1);
  });

  test('a failing close does not hide a successful result', async () => {
    const probe = fakeProbe({closeError: new Error('close failed')});
    const runner = createSelfTestRunner({
      open: async () => probe,
      now: () => 0,
      samples: ['milk'],
    });

    await expect(runner.selfTest('auto')).resolves.toMatchObject({ok: true});
    expect(probe.closed).toBe(1);
  });

  test('a clock that runs backwards clamps to zero, never a negative time', async () => {
    const probe = fakeProbe();
    const runner = createSelfTestRunner({
      open: async () => probe,
      now: clockOf([500, 400, 300, 200]),
      samples: ['milk'],
    });

    const outcome = await runner.selfTest('auto');
    if (!outcome.ok) {
      throw new Error('expected success');
    }
    expect(outcome.report.loadMillis).toBe(0);
    expect(outcome.report.samples[0].millis).toBe(0);
  });
});

describe('latency formatting', () => {
  const report = (overrides: Partial<LatencyReport> = {}): LatencyReport => ({
    backend: 'cpu',
    samples: [
      {text: 'a', millis: 10},
      {text: 'b', millis: 15},
    ],
    loadMillis: 1234,
    supportsImages: true,
    dims: 256,
    ...overrides,
  });

  test('meanMillis averages the samples and is 0 with no samples', () => {
    expect(meanMillis(report())).toBe(12.5);
    expect(meanMillis(report({samples: []}))).toBe(0);
  });

  test('formatMillis switches from ms to s at one second', () => {
    expect(formatMillis(35)).toBe('35 ms');
    expect(formatMillis(999)).toBe('999 ms');
    expect(formatMillis(1000)).toBe('1.00 s');
    expect(formatMillis(1234)).toBe('1.23 s');
    expect(formatMillis(Number.NaN)).toBe('0 ms');
    expect(formatMillis(-5)).toBe('0 ms');
  });

  test('formatMean keeps one decimal in ms and two in s', () => {
    expect(formatMean(12.34)).toBe('12.3 ms');
    expect(formatMean(999.9)).toBe('999.9 ms');
    expect(formatMean(1234)).toBe('1.23 s');
    expect(formatMean(Number.NaN)).toBe('0.0 ms');
  });

  test('latencyHeadline names the backend, mean and call count', () => {
    expect(latencyHeadline(report())).toBe('cpu · mean 12.5 ms · 2 calls');
    expect(latencyHeadline(report({backend: 'gpu'}))).toContain('gpu · mean');
  });

  test('supportsLine is honest about a bundle without vision', () => {
    expect(supportsLine(report())).toBe('text + image');
    expect(supportsLine(report({supportsImages: false}))).toBe(
      'text only (no vision encoder)',
    );
  });

  test('sampleRange reports fastest and slowest, or null when empty', () => {
    expect(sampleRange(report())).toEqual({fastest: 10, slowest: 15});
    expect(sampleRange(report({samples: []}))).toBeNull();
  });
});
