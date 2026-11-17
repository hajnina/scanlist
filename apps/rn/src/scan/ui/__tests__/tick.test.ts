/**
 * Card A5 — signal → `rank` wiring (`ScanTickEngine`).
 *
 * Everything here is synthetic: a fake embedder with 4-d vectors, a fake OFF lookup and a fake
 * clock, so the assertions are about the *wiring* (pool order, barcode→name, item-vector cache,
 * state/hysteresis threading, null-hero reasons) and never about model quality. Gate constants and
 * hysteresis themselves are ts-core's (`shared/ts-core/src/rank.ts`, tested there).
 */
import {docText, type FlattenedItem} from '@scanlist/ts-core';
import {
  ScanTickEngine,
  type OffTextLookup,
  type ScanEmbedder,
} from '../tick';

type Vec = number[];

const ZERO: Vec = [0, 0, 0, 0];
const E0: Vec = [1, 0, 0, 0];
const E1: Vec = [0, 1, 0, 0];
const E2: Vec = [0, 0, 1, 0];

const barcode = (text: string, confidence = 1) =>
  ({source: 'barcode', text, confidence}) as const;
const ocr = (text: string, confidence = 0.8) =>
  ({source: 'ocr', text, confidence}) as const;

function item(
  id: string,
  name: string,
  extra: Partial<FlattenedItem> = {},
): FlattenedItem {
  return {
    id,
    name,
    amount: null,
    unit: null,
    note: null,
    aliases: [],
    done: false,
    path: [],
    pathText: '',
    index: 0,
    order: 0,
    ...extra,
  };
}

function makeClock(start = 10_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    set(value: number) {
      now = value;
    },
  };
}

interface EmbedderConfig {
  docs: Record<string, Vec>;
  queries?: Record<string, Vec>;
  image?: Vec;
  failDocs?: Error;
  failQuery?: Error;
  failImage?: Error;
}

function makeEmbedder(config: EmbedderConfig) {
  const calls = {
    docs: [] as string[][],
    queries: [] as string[],
    images: [] as string[],
  };
  const embedder: ScanEmbedder & {calls: typeof calls} = {
    dims: 4,
    calls,
    async embedDocs(texts: string[]) {
      calls.docs.push([...texts]);
      if (config.failDocs) throw config.failDocs;
      return texts.map(text => [...(config.docs[text] ?? ZERO)]);
    },
    async embedQuery(text: string) {
      calls.queries.push(text);
      if (config.failQuery) throw config.failQuery;
      return [...(config.queries?.[text] ?? ZERO)];
    },
    async embedImage(image: {base64: string}) {
      calls.images.push(image.base64);
      if (config.failImage) throw config.failImage;
      return [...(config.image ?? ZERO)];
    },
  };
  return embedder;
}

function fakeOff(result: string | null | Error) {
  const calls: string[] = [];
  const off: OffTextLookup & {calls: string[]} = {
    calls,
    async lookup(barcodeDigits: string) {
      calls.push(barcodeDigits);
      if (result instanceof Error) throw result;
      return {
        barcode: barcodeDigits,
        text: result,
        hit: result !== null,
        source: result === null ? ('none' as const) : ('network' as const),
      };
    },
  };
  return off;
}

function engineWith(
  embedder: ScanEmbedder,
  off: OffTextLookup,
  items: readonly FlattenedItem[],
  now: () => number = makeClock().now,
) {
  return new ScanTickEngine({embedder, off, items, now, dims: 4});
}

// --- text query pool (RANK.md §2.2, the pool-order fix) --------------------------------------

test('a barcode arriving after 16 OCR lines is still text query #1, OCR keeps 15', async () => {
  const a = item('a', 'Cornflakes');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    queries: {Nutella: E0},
  });
  const off = fakeOff('Nutella');
  const engine = engineWith(embedder, off, [a]);

  for (let index = 0; index < 16; index += 1) {
    engine.pushSignal(ocr(`line ${index}`), 10_000);
  }
  engine.pushSignal(barcode('3017620422003'), 10_000);

  const tick = await engine.tick();
  expect(tick.textQueries).toHaveLength(16);
  expect(tick.textQueries[0]).toBe('Nutella');
  expect(tick.textQueries.slice(1)).toEqual(
    Array.from({length: 15}, (_value, index) => `line ${index}`),
  );
  // The 16th OCR line loses; the barcode never does.
  expect(tick.textQueries).not.toContain('line 15');
  // The digits themselves are never a query.
  expect(tick.textQueries).not.toContain('3017620422003');
  // All 16 OCR lines were taken from the pool and reported by the chip.
  expect(tick.ocrLines).toHaveLength(16);
  expect(off.calls).toEqual(['3017620422003']);
});

test('16 OCR lines and no barcode use the full 16-text-vector pool', async () => {
  const a = item('a', 'Cornflakes');
  const queries: Record<string, Vec> = {};
  const lines = Array.from({length: 16}, (_value, index) => `line ${index}`);
  lines.forEach(line => {
    queries[line] = E0;
  });
  const embedder = makeEmbedder({docs: {[docText(a)]: E0}, queries});
  const engine = engineWith(embedder, fakeOff(null), [a]);
  lines.forEach(line => engine.pushSignal(ocr(line), 10_000));

  const tick = await engine.tick();
  expect(tick.textQueries).toEqual(lines);
  expect(tick.barcode).toBeNull();
});

test('one OCR signal per line: each line becomes its own query, never a concatenation', async () => {
  const a = item('a', 'Milk');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E1},
    queries: {Milk: E1, Bread: E0},
  });
  const engine = engineWith(embedder, fakeOff(null), [a]);
  engine.pushSignal(ocr('Milk'), 10_000);
  engine.pushSignal(ocr('Bread'), 10_000);

  const tick = await engine.tick();
  expect(tick.textQueries).toEqual(['Milk', 'Bread']);
  expect(tick.ocrLines).toEqual(['Milk', 'Bread']);
  expect(tick.heroId).toBe('a');
});

// --- barcode → OFF name → hero ---------------------------------------------------------------

test('the hero is topId from the barcode name, with the +0.15 boost applied inside rank', async () => {
  const a = item('a', 'Cornflakes', {aliases: ['Cornflakes Original']});
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    // The OFF name has its own vector; it still matches the alias for the boost.
    queries: {'Cornflakes Original': [0.7, 0, 0, 0]},
  });
  const engine = engineWith(embedder, fakeOff('Cornflakes Original'), [a]);
  engine.pushSignal(barcode('3017620422003'), 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('hero');
  expect(tick.heroId).toBe('a');
  expect(tick.output.topId).toBe('a');
  expect(tick.barcode).toEqual({
    digits: '3017620422003',
    text: 'Cornflakes Original',
    source: 'network',
  });
  // base 0.70 from the text query, +0.15 because the OFF name matches name/alias.
  expect(tick.output.entries[0]?.raw).toBeCloseTo(0.85, 6);
});

test('a barcode OFF miss leaves the barcode name out of the pool; OCR still ranks', async () => {
  const a = item('a', 'Milk');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E1},
    queries: {Milk: E1},
  });
  const engine = engineWith(embedder, fakeOff(null), [a]);
  engine.pushSignal(barcode('3245390098214'), 10_000);
  engine.pushSignal(ocr('Milk'), 10_000);

  const tick = await engine.tick();
  expect(tick.barcode).toEqual({
    digits: '3245390098214',
    text: null,
    source: 'none',
  });
  expect(tick.textQueries).toEqual(['Milk']);
  expect(tick.heroId).toBe('a');
});

test('OFF being down degrades to "no barcode name", never a failed tick', async () => {
  const a = item('a', 'Milk');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E1},
    queries: {Milk: E1},
  });
  const engine = engineWith(embedder, fakeOff(new Error('ENOTFOUND')), [a]);
  engine.pushSignal(barcode('3017620422003'), 10_000);
  engine.pushSignal(ocr('Milk'), 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('hero');
  expect(tick.heroId).toBe('a');
  expect(tick.barcode).toEqual({
    digits: '3017620422003',
    text: null,
    source: 'unresolved',
  });
  expect(tick.error).toBeNull();
});

// --- image-driven heroes (RANK.md §6.3 image guard) ------------------------------------------

const INSTANT_MIX = item('a', 'Cornflakes', {aliases: ['Cornflakes Original']});
const MILK = item('b', 'Milk');

function imageEngine() {
  const embedder = makeEmbedder({
    docs: {[docText(INSTANT_MIX)]: E0, [docText(MILK)]: E1},
    queries: {'Cornflakes Original': E2},
    // cos(A) = 0.73, cos(B) = 0.10.
    image: [0.73, 0.1, 0, 0],
  });
  return engineWith(embedder, fakeOff('Cornflakes Original'), [INSTANT_MIX, MILK]);
}

test('an image-driven winner is not shown without a barcode-confirmed name', async () => {
  const engine = imageEngine();
  engine.pushImageVector([0.73, 0.1, 0, 0], 10_000);

  const tick = await engine.tick();
  expect(tick.output.ranked).toBe(true);
  expect(tick.output.entries[0]?.id).toBe('a'); // ranked, just not highlighted
  expect(tick.reason).toBe('no-hero');
  expect(tick.heroId).toBeNull();
  expect(tick.output.topId).toBeNull();
  expect(tick.imageQueries).toBe(1);
});

test('the same image winner becomes the hero once OFF confirms it (+0.15 boost)', async () => {
  const engine = imageEngine();
  engine.pushSignal(barcode('3017620422003'), 10_000);
  engine.pushImageVector([0.73, 0.1, 0, 0], 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('hero');
  expect(tick.heroId).toBe('a');
  expect(tick.output.entries[0]?.raw).toBeCloseTo(0.88, 6);
  expect(tick.barcode?.source).toBe('network');
});

// --- gates stay in ts-core: the UI just reports the null hero --------------------------------

test('text margin 0.04 < 0.05: ranked, but no hero', async () => {
  const a = item('a', 'A', {order: 0});
  const b = item('b', 'B', {order: 1});
  const embedder = makeEmbedder({
    docs: {
      [docText(a)]: [0.83, 0, 0, 0],
      [docText(b)]: [0.79, 0, 0, 0],
    },
    queries: {Milk: E0},
  });
  const engine = engineWith(embedder, fakeOff(null), [a, b]);
  engine.pushSignal(ocr('Milk'), 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('no-hero');
  expect(tick.heroId).toBeNull();
  expect(tick.output.entries.map(entry => entry.id)).toEqual(['a', 'b']);
});

test('text floor 0.70 < 0.79: decisive margin, still no hero', async () => {
  const a = item('a', 'A');
  const b = item('b', 'B');
  const embedder = makeEmbedder({
    docs: {
      [docText(a)]: [0.7, 0, 0, 0],
      [docText(b)]: [0.1, 0, 0, 0],
    },
    queries: {Milk: E0},
  });
  const engine = engineWith(embedder, fakeOff(null), [a, b]);
  engine.pushSignal(ocr('Milk'), 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('no-hero');
  expect(tick.heroId).toBeNull();
});

test('image margin 0.001 < 0.005: no hero even when both sides are confirmed', async () => {
  const a = item('a', 'Cornflakes', {aliases: ['Cornflakes Original']});
  const b = item('b', 'Flakes', {aliases: ['Cornflakes Original']});
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0, [docText(b)]: E1},
    queries: {'Cornflakes Original': E2},
  });
  const engine = engineWith(embedder, fakeOff('Cornflakes Original'), [a, b]);
  engine.pushSignal(barcode('3017620422003'), 10_000);
  engine.pushImageVector([0.73, 0.729, 0, 0], 10_000);

  const tick = await engine.tick();
  // 0.88 vs 0.879: both confirmed, margins too close for a hero.
  expect(tick.output.entries.map(entry => entry.raw)).toEqual([0.88, 0.879]);
  expect(tick.reason).toBe('no-hero');
  expect(tick.heroId).toBeNull();
});

test('image floor below 0.68: no hero even with confirmation', async () => {
  const embedder = makeEmbedder({
    docs: {[docText(INSTANT_MIX)]: E0, [docText(MILK)]: E1},
    queries: {'Cornflakes Original': E2},
  });
  const engine = engineWith(
    embedder,
    fakeOff('Cornflakes Original'),
    [INSTANT_MIX, MILK],
  );
  engine.pushSignal(barcode('3017620422003'), 10_000);
  // 0.50 + 0.15 = 0.65 < 0.68.
  engine.pushImageVector([0.5, 0.1, 0, 0], 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('no-hero');
  expect(tick.heroId).toBeNull();
});

// --- hysteresis threading (RANK.md §6.1) ----------------------------------------------------

test('hysteresis holds the hero through the dead band, then drops it when the challenger is unconfirmed', async () => {
  const clock = makeClock();
  // The 2000 ms image window is what keeps A's earlier score alive, so a shared clock matters.
  const timed = engineWith(
    makeEmbedder({
      docs: {[docText(INSTANT_MIX)]: E0, [docText(MILK)]: E1},
      queries: {'Cornflakes Original': E2},
    }),
    fakeOff('Cornflakes Original'),
    [INSTANT_MIX, MILK],
    clock.now,
  );

  timed.pushSignal(barcode('3017620422003'), clock.now());
  timed.pushImageVector([0.73, 0.1, 0, 0], clock.now()); // A: .73 + .15 = .88
  const t1 = await timed.tick();
  expect(t1.heroId).toBe('a');
  expect(t1.output.entries[0]).toMatchObject({id: 'a', raw: 0.88});

  for (let tickIndex = 2; tickIndex <= 5; tickIndex += 1) {
    clock.advance(100);
    timed.pushImageVector(E1, clock.now()); // B: 1.0
    const tick = await timed.tick();
    if (tickIndex === 4) {
      // B is ahead (0.8875 > 0.88) but inside the 0.02 dead band: the previous hero stays.
      const b = tick.output.entries.find(entry => entry.id === 'b');
      expect(b?.smoothed).toBeCloseTo(0.8875, 6);
      expect(tick.heroId).toBe('a');
      expect(tick.reason).toBe('hero');
    }
    if (tickIndex === 5) {
      // B is now clearly ahead (0.94375) and wins, but no barcode confirms it: no hero.
      const b = tick.output.entries.find(entry => entry.id === 'b');
      expect(b?.smoothed).toBeCloseTo(0.94375, 6);
      expect(tick.heroId).toBeNull();
      expect(tick.reason).toBe('no-hero');
    }
  }
});

// --- empty / degraded states ----------------------------------------------------------------

test('no signal at all is unranked and reports no-signal', async () => {
  const a = item('a', 'Cornflakes');
  const embedder = makeEmbedder({docs: {[docText(a)]: E0}});
  const engine = engineWith(embedder, fakeOff(null), [a]);

  const tick = await engine.tick();
  expect(tick.reason).toBe('no-signal');
  expect(tick.output.ranked).toBe(false);
  expect(tick.heroId).toBeNull();
});

test('a list with no unchecked item reports no-items without embedding a query', async () => {
  const done = item('a', 'Cornflakes', {done: true});
  const embedder = makeEmbedder({docs: {[docText(done)]: E0}});
  const engine = engineWith(embedder, fakeOff(null), [done]);
  engine.pushSignal(ocr('Milk'), 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('no-items');
  expect(tick.heroId).toBeNull();
  expect(embedder.calls.queries).toEqual([]);
});

test('a model failure is embed-unavailable and never throws', async () => {
  const a = item('a', 'Cornflakes');
  const modelError = Object.assign(new Error('model missing'), {
    code: 'E_MODEL_MISSING',
  });
  const embedder = makeEmbedder({docs: {}, failDocs: modelError});
  const engine = engineWith(embedder, fakeOff(null), [a]);
  engine.pushSignal(ocr('Milk'), 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('embed-unavailable');
  expect(tick.error).toContain('E_MODEL_MISSING');
  expect(tick.heroId).toBeNull();
});

test('a query embed failure is embed-unavailable and keeps the tick shape', async () => {
  const a = item('a', 'Cornflakes');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    failQuery: new Error('query model gone'),
  });
  const engine = engineWith(embedder, fakeOff(null), [a]);
  engine.pushSignal(ocr('Milk'), 10_000);

  const tick = await engine.tick();
  expect(tick.reason).toBe('embed-unavailable');
  expect(tick.error).toContain('query embed');
  expect(tick.ocrLines).toEqual(['Milk']);
});

// --- caches, lifecycle, single-flight -------------------------------------------------------

test('item doc vectors are embedded once and reused across ticks', async () => {
  const a = item('a', 'Cornflakes');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    queries: {Milk: E0},
  });
  const engine = engineWith(embedder, fakeOff(null), [a]);
  engine.pushSignal(ocr('Milk'), 10_000);
  await engine.tick();
  engine.pushSignal(ocr('Milk'), 10_100);
  await engine.tick();

  expect(embedder.calls.docs).toHaveLength(1);
  expect(embedder.calls.docs[0]).toEqual([docText(a)]);
  // The query text is cached too.
  expect(embedder.calls.queries).toEqual(['Milk']);
  expect(engine.snapshot().embeddedItems).toBe(1);
});

test('done items are not embedded and a real content change clears the ranker state', async () => {
  const a = item('a', 'Cornflakes');
  const done = item('b', 'Milk', {done: true});
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    queries: {Cornflakes: E0},
  });
  const engine = engineWith(embedder, fakeOff(null), [a, done]);
  engine.pushSignal(ocr('Cornflakes'), 10_000);

  await engine.tick();
  expect(embedder.calls.docs[0]).toEqual([docText(a)]);
  expect(engine.snapshot().state?.topId).toBe('a');

  // Identical content keeps EMA/hysteresis state (e.g. a note or amount edit).
  engine.setItems([item('a', 'Cornflakes'), item('b', 'Milk', {done: true})]);
  expect(engine.snapshot().state?.topId).toBe('a');

  // Renaming an item is a real content change: state starts over.
  engine.setItems([item('a', 'Cornflakes'), item('b', 'Oat milk', {done: true})]);
  expect(engine.snapshot().state).toBeNull();
});

test('pushImageFrame embeds the JPEG and adds it to the image window', async () => {
  const a = item('a', 'Cornflakes');
  const embedder = makeEmbedder({docs: {[docText(a)]: E0}, image: [1, 0, 0, 0]});
  const engine = engineWith(embedder, fakeOff('Cornflakes'), [a], () => 10_000);
  engine.pushSignal(barcode('3017620422003'), 10_000);
  await engine.pushImageFrame({
    jpegBase64: 'jpeg-bytes',
    filePath: '/tmp/photo.jpg',
    width: 720,
    height: 1280,
    capturedAt: 10_000,
  });

  expect(embedder.calls.images).toEqual(['jpeg-bytes']);
  expect(engine.snapshot().pool.images).toHaveLength(1);
  const tick = await engine.tick();
  expect(tick.imageQueries).toBe(1);
  expect(tick.heroId).toBe('a');
});

test('a malformed image vector is dropped without breaking the other chips', async () => {
  const a = item('a', 'Cornflakes');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    queries: {Cornflakes: E0},
    image: [1, 0],
  });
  const engine = engineWith(embedder, fakeOff(null), [a], () => 10_000);
  await engine.pushImageFrame({
    jpegBase64: 'jpeg-bytes',
    filePath: '/tmp/photo.jpg',
    width: 720,
    height: 1280,
    capturedAt: 10_000,
  });

  expect(engine.snapshot().pool.images).toEqual([]);
  engine.pushSignal(ocr('Cornflakes'), 10_000);
  const tick = await engine.tick();
  expect(tick.heroId).toBe('a');
  expect(tick.imageQueries).toBe(0);
});

test('markCommitted ends sticky barcode mode; the next tick is unranked', async () => {
  const a = item('a', 'Cornflakes', {aliases: ['Cornflakes Original']});
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    queries: {'Cornflakes Original': [0.7, 0, 0, 0]},
  });
  const engine = engineWith(embedder, fakeOff('Cornflakes Original'), [a]);
  engine.pushSignal(barcode('3017620422003'), 10_000);
  expect((await engine.tick()).heroId).toBe('a');

  engine.markCommitted();
  const after = await engine.tick();
  expect(after.barcode).toBeNull();
  expect(after.textQueries).toEqual([]);
  expect(after.reason).toBe('no-signal');
  expect(after.heroId).toBeNull();
});

test('reset clears pool and state; the next scan starts fresh', async () => {
  const a = item('a', 'Cornflakes');
  const embedder = makeEmbedder({
    docs: {[docText(a)]: E0},
    queries: {Cornflakes: E0},
  });
  const engine = engineWith(embedder, fakeOff(null), [a]);
  engine.pushSignal(ocr('Cornflakes'), 10_000);
  expect((await engine.tick()).heroId).toBe('a');

  engine.reset();
  expect(engine.snapshot().state).toBeNull();
  const fresh = await engine.tick();
  expect(fresh.reason).toBe('no-signal');
});

test('tick is single-flight: an overlapping call shares the same promise and one embed', async () => {
  const a = item('a', 'Cornflakes');
  let release: (vectors: number[][]) => void = () => undefined;
  const embedder: ScanEmbedder = {
    dims: 4,
    embedDocs: () =>
      new Promise<number[][]>(resolve => {
        release = resolve;
      }),
    embedQuery: async () => E0,
    embedImage: async () => E0,
  };
  const engine = engineWith(embedder, fakeOff(null), [a]);
  engine.pushSignal(ocr('Cornflakes'), 10_000);

  const first = engine.tick();
  const second = engine.tick();
  expect(second).toBe(first);
  release([E0]);
  const [a1, a2] = await Promise.all([first, second]);
  expect(a1).toBe(a2);
  expect(a1.heroId).toBe('a');
});
