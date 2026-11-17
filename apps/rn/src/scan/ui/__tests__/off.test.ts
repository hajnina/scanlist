/**
 * Card A5 — OFF lookup against `shared/off/OFF.md` (normative) and its AsyncStorage cache.
 *
 * The real recorded fixtures are replayed through `deriveProductText`, so this file cannot drift
 * from the spec without failing on the same bytes `shared/off/check_fixtures.py` checks. The client
 * tests use a fake `fetch`, clock and store: no network, no AsyncStorage.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {MemoryKeyValueStore} from '../../../list/store';
import {
  OFF_BACKOFF_CAP_MS,
  OFF_CACHE_MAX_ENTRIES,
  OFF_CACHE_PREFIX,
  OFF_CONNECT_TIMEOUT_MS,
  OFF_FIELDS,
  OFF_REDIRECT_MAX_HOPS,
  OFF_TTL_HIT_S,
  OFF_TTL_MISS_S,
  OFF_USER_AGENT,
  OffCache,
  OffClient,
  cleanOffBrands,
  deriveProductText,
  isOffEntryFresh,
  isValidBarcode,
  offCacheKey,
  resolveOffRedirect,
  truncateOffText,
  type OffCacheEntry,
  type OffClientOptions,
  type OffFetch,
  type OffResponseLike,
} from '../off';

const fixturesDir = join(
  __dirname,
  '../../../../../../shared/off/fixtures',
);

interface OffCase {
  barcode: string;
  file: string;
  httpStatus: number;
  outcome: string;
  expectedQueryText: string | null;
}

const cases = (
  JSON.parse(
    readFileSync(join(fixturesDir, 'cases.json'), 'utf8'),
  ) as {cases: OffCase[]}
).cases;

function bodyOf(file: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): OffResponseLike {
  return {
    status,
    header: name => headers[name.toLowerCase()] ?? null,
    json: async () => body,
  };
}

function mutableClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance(ms: number) {
      now += ms;
    },
    sleeps,
  };
}

const HIT_BODY = {
  status: 1,
  product: {
    code: '3017620422003',
    product_name: 'Nutella',
    generic_name: 'Hazelnut And Cocoa Spread',
    brands: 'Ferrero, Nutella',
  },
};

// --- derivation (OFF.md §3) ----------------------------------------------------------------

test('derives the recorded OFF fixtures exactly as OFF.md §3 says', () => {
  expect(cases.length).toBeGreaterThan(15);
  for (const entry of cases) {
    const derived = deriveProductText(bodyOf(entry.file));
    expect({barcode: entry.barcode, text: derived}).toEqual({
      barcode: entry.barcode,
      text: entry.expectedQueryText,
    });
  }
});

test('product_name wins, never a concatenation; generic_name and brands are fallbacks', () => {
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: 'Nutella', generic_name: 'Spread', brands: 'Ferrero'},
    }),
  ).toBe('Nutella');
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: '  ', generic_name: 'Désodorisant pour litière'},
    }),
  ).toBe('Désodorisant pour litière');
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: '', generic_name: '', brands: 'Ferrero,  Nutella , FERRERO'},
    }),
  ).toBe('Ferrero, Nutella');
});

test('status is authoritative; status_verbose is never parsed', () => {
  // The real fixture: HTTP 404, status 0, status_verbose claims the product was found.
  const body = bodyOf('3560070829668.json') as {status: number; status_verbose: string};
  expect(body.status).toBe(0);
  expect(String(body.status_verbose).length).toBeGreaterThan(0);
  expect(deriveProductText(body)).toBeNull();
  expect(deriveProductText({status: '1', product: {product_name: 'X'}})).toBeNull();
  expect(deriveProductText(null)).toBeNull();
  expect(deriveProductText({status: 1})).toBeNull();
});

test('clean: NFC, whitespace runs collapse, no case or punctuation changes', () => {
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: 'Dulce   de leche'},
    }),
  ).toBe('Dulce de leche');
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: 'Mléko polotučné s obsahem  1,5% tuku'},
    }),
  ).toBe('Mléko polotučné s obsahem 1,5% tuku');
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: 'Spaghetti Nº5'},
    }),
  ).toBe('Spaghetti Nº5');
  // Decomposed é → NFC é (same string as the precomposed form).
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: 'Cafe\u0301 noir'},
    }),
  ).toBe('Café noir');
  // U+200B is not White_Space: it is kept.
  expect(
    deriveProductText({
      status: 1,
      product: {product_name: 'Milk\u200Bshake'},
    }),
  ).toBe('Milk\u200Bshake');
  expect(cleanOffBrands(' Ferrero,  Nutella , FERRERO ')).toBe('Ferrero, Nutella');
  expect(cleanOffBrands(42)).toBe('');
});

test('truncates at 160 code points, hard, then strips trailing spaces', () => {
  const long = 'a'.repeat(159) + ' g';
  const cut = truncateOffText(long);
  expect(cut).toBe('a'.repeat(159));
  expect(deriveProductText({status: 1, product: {product_name: long}})).toBe(
    'a'.repeat(159),
  );
  // Surrogate pairs count as one code point each, never split.
  const emoji = '🍫'.repeat(200);
  const truncated = truncateOffText(emoji);
  expect(Array.from(truncated)).toHaveLength(160);
  expect(truncated.endsWith('🍫')).toBe(true);
});

test('barcode validation is exactly ^[0-9]{8,14}$ and keeps leading zeros', () => {
  expect(isValidBarcode('3017620422003')).toBe(true);
  expect(isValidBarcode('0202075011817')).toBe(true);
  expect(isValidBarcode('12345678')).toBe(true);
  expect(isValidBarcode('1234567')).toBe(false);
  expect(isValidBarcode('123456789012345')).toBe(false);
  expect(isValidBarcode('123456789012a')).toBe(false);
  expect(isValidBarcode(' 3017620422003')).toBe(false);
});

// --- cache (OFF.md §4) ---------------------------------------------------------------------

test('cache key scheme and entry shape', async () => {
  const store = new MemoryKeyValueStore();
  const clock = mutableClock();
  const cache = new OffCache(store, () => Math.floor(clock.now() / 1000));

  const entry = await cache.write('3017620422003', 'Nutella', true);
  expect(offCacheKey('3017620422003')).toBe(
    `${OFF_CACHE_PREFIX}3017620422003`,
  );
  expect(entry.fetchedAt).toBe(Math.floor(clock.now() / 1000));
  expect(JSON.parse(store.raw(offCacheKey('3017620422003')) as string)).toEqual({
    text: 'Nutella',
    hit: true,
    fetchedAt: Math.floor(clock.now() / 1000),
  });
});

test('TTL: hit 30 days, miss 1 day, exactly at the boundary is expired', () => {
  const hit: OffCacheEntry = {text: 'Nutella', hit: true, fetchedAt: 1000};
  const miss: OffCacheEntry = {text: null, hit: false, fetchedAt: 1000};
  expect(isOffEntryFresh(hit, 1000)).toBe(true);
  expect(isOffEntryFresh(hit, 1000 + OFF_TTL_HIT_S - 1)).toBe(true);
  expect(isOffEntryFresh(hit, 1000 + OFF_TTL_HIT_S)).toBe(false);
  expect(isOffEntryFresh(miss, 1000 + OFF_TTL_MISS_S - 1)).toBe(true);
  expect(isOffEntryFresh(miss, 1000 + OFF_TTL_MISS_S)).toBe(false);
  // Wall clock moved backwards: age clamps to 0, entry is fresh.
  expect(isOffEntryFresh(hit, 999)).toBe(true);
});

test('eviction drops expired entries first, then the oldest, at the cap', async () => {
  const store = new MemoryKeyValueStore();
  const nowSeconds = 2_000_000_000;
  const cache = new OffCache(store, () => nowSeconds);
  for (let index = 0; index < OFF_CACHE_MAX_ENTRIES + 5; index += 1) {
    const barcode = String(1_000_000_000 + index);
    const age = index === 0 ? OFF_TTL_HIT_S + 10 : index; // first one is expired
    await store.setItem(
      offCacheKey(barcode),
      JSON.stringify({text: 'x', hit: true, fetchedAt: nowSeconds - age}),
    );
  }
  await cache.evictIfNeeded();
  const keys = (await store.getAllKeys()).filter(key =>
    key.startsWith(OFF_CACHE_PREFIX),
  );
  expect(keys).toHaveLength(OFF_CACHE_MAX_ENTRIES);
  // Expired first (index 0), then the four with the smallest fetchedAt (largest age).
  expect(keys.includes(offCacheKey(String(1_000_000_000)))).toBe(false);
  expect(keys.includes(offCacheKey(String(1_000_001_004)))).toBe(false);
  expect(keys.includes(offCacheKey(String(1_000_000_001)))).toBe(true);
});

// --- client (OFF.md §2/§4) -----------------------------------------------------------------

function clientWith(
  fetchImpl: OffFetch,
  store = new MemoryKeyValueStore(),
  clock = mutableClock(),
  options: Partial<OffClientOptions> = {},
) {
  const client = new OffClient({
    store,
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    ...options,
  });
  return {client, store, clock};
}

test('request contract: exact host, path, fields, UA and Accept', async () => {
  const calls: {url: string; headers: Record<string, string>}[] = [];
  const {client} = clientWith(async (url, init) => {
    calls.push({url, headers: init.headers});
    return response(200, HIT_BODY);
  });

  const result = await client.lookup('3017620422003');
  expect(result).toMatchObject({
    barcode: '3017620422003',
    text: 'Nutella',
    hit: true,
    source: 'network',
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(
    `https://world.openfoodfacts.org/api/v2/product/3017620422003.json?fields=${OFF_FIELDS}`,
  );
  expect(calls[0]?.headers).toEqual({
    'User-Agent': OFF_USER_AGENT,
    Accept: 'application/json',
  });
});

test('a fresh hit is served from cache without a request, then expires after 30 days', async () => {
  let fetches = 0;
  const clock = mutableClock();
  const {client} = clientWith(async () => {
    fetches += 1;
    return response(200, HIT_BODY);
  }, new MemoryKeyValueStore(), clock);

  expect((await client.lookup('3017620422003')).source).toBe('network');
  const cached = await client.lookup('3017620422003');
  expect(cached).toMatchObject({text: 'Nutella', hit: true, source: 'cache'});
  expect(fetches).toBe(1);

  clock.advance((OFF_TTL_HIT_S - 1) * 1000);
  expect((await client.lookup('3017620422003')).source).toBe('cache');

  clock.advance(2_000);
  expect((await client.lookup('3017620422003')).source).toBe('network');
  expect(fetches).toBe(2);
});

test('404 is a cached miss for one day; a hit with no name is a positive entry', async () => {
  let fetches = 0;
  const clock = mutableClock();
  const store = new MemoryKeyValueStore();
  const {client} = clientWith(async () => {
    fetches += 1;
    return fetches === 1
      ? response(404, {status: 0})
      : response(200, {status: 1, product: {product_name: ''}});
  }, store, clock);

  const miss = await client.lookup('3245390098214');
  expect(miss).toMatchObject({text: null, hit: false, source: 'network'});
  expect(await client.lookup('3245390098214')).toMatchObject({
    text: null,
    source: 'cache',
  });
  clock.advance(OFF_TTL_MISS_S * 1000);
  const nameless = await client.lookup('3245390098214');
  expect(nameless).toMatchObject({text: null, hit: true, source: 'network'});
  expect(fetches).toBe(2);
});

test('invalid barcode: no request, no cache entry', async () => {
  let fetches = 0;
  const {client, store} = clientWith(async () => {
    fetches += 1;
    return response(200, HIT_BODY);
  });
  const result = await client.lookup('not-a-barcode');
  expect(result).toMatchObject({text: null, hit: false, source: 'invalid'});
  expect(fetches).toBe(0);
  expect(
    (await store.getAllKeys()).filter(key => key.startsWith(OFF_CACHE_PREFIX)),
  ).toHaveLength(0);
});

test('transient failure with a stale entry: stale text is used and fetchedAt is not extended', async () => {
  const store = new MemoryKeyValueStore();
  const clock = mutableClock();
  const nowSeconds = Math.floor(clock.now() / 1000);
  await store.setItem(
    offCacheKey('3017620422003'),
    JSON.stringify({
      text: 'Nutella',
      hit: true,
      fetchedAt: nowSeconds - OFF_TTL_HIT_S - 10,
    }),
  );
  const {client} = clientWith(
    async () => response(503, 'html'),
    store,
    clock,
  );

  const result = await client.lookup('3017620422003');
  expect(result).toMatchObject({text: 'Nutella', hit: true, source: 'stale'});
  const stored = JSON.parse(
    store.raw(offCacheKey('3017620422003')) as string,
  ) as OffCacheEntry;
  expect(stored.fetchedAt).toBe(nowSeconds - OFF_TTL_HIT_S - 10);
});

test('transient failure without a stale entry is "none", never a throw', async () => {
  const {client} = clientWith(async () => {
    throw new Error('ENOTFOUND');
  });
  const result = await client.lookup('3017620422003');
  expect(result).toMatchObject({text: null, hit: false, source: 'none'});
  expect(result.note).toContain('ENOTFOUND');
});

test('a 5xx or timeout is retried at most 3 times per scan session', async () => {
  let fetches = 0;
  const clock = mutableClock(0);
  const {client} = clientWith(
    async () => {
      fetches += 1;
      return response(500, 'error');
    },
    new MemoryKeyValueStore(),
    clock,
    {minSpacingMs: 0},
  );
  // Each retry waits its 1 s / 2 s backoff, so the clock is advanced between attempts.
  for (const at of [0, 1_000, 3_000, 7_000, 120_000]) {
    clock.advance(at - clock.now());
    await client.lookup('3017620422003');
  }
  expect(fetches).toBe(3);
  // A new scan session starts the counter again.
  client.resetSession();
  await client.lookup('3017620422003');
  expect(fetches).toBe(4);
});

test('429 honours Retry-After before the next attempt at that barcode', async () => {
  let fetches = 0;
  const clock = mutableClock();
  const {client} = clientWith(
    async () => {
      fetches += 1;
      return fetches === 1
        ? response(429, {}, {'retry-after': '2'})
        : response(200, HIT_BODY);
    },
    new MemoryKeyValueStore(),
    clock,
  );

  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(1);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(1); // still inside Retry-After

  clock.advance(2_000);
  const after = await client.lookup('3017620422003');
  expect(after.source).toBe('network');
  expect(after.text).toBe('Nutella');
  expect(fetches).toBe(2);
});

// --- OFF.md §4.4/§5 retry timing (Kotlin OffResolver parity) --------------------------------

test('a 5xx backs off 1 s → 2 s → 4 s and stops after the third attempt', async () => {
  let fetches = 0;
  const clock = mutableClock(0);
  const {client} = clientWith(
    async () => {
      fetches += 1;
      return response(500, 'down');
    },
    new MemoryKeyValueStore(),
    clock,
    {minSpacingMs: 0},
  );

  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(1);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(1); // inside the 1 s backoff

  clock.advance(1_000);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(2); // 1 s after the first failure

  clock.advance(1_999);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(2); // still inside the 2 s backoff

  clock.advance(1);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(3); // 2 s after the second failure

  const exhausted = await client.lookup('3017620422003');
  expect(exhausted.source).toBe('none');
  expect(exhausted.note).toContain('retry budget exhausted');
  clock.advance(10 * 60_000);
  await client.lookup('3017620422003');
  expect(fetches).toBe(3); // the third failure's 4 s value never buys a fourth request
});

test('the exponential backoff is capped at 60 s', async () => {
  let fetches = 0;
  const clock = mutableClock(0);
  const {client} = clientWith(
    async () => {
      fetches += 1;
      return response(500, 'down');
    },
    new MemoryKeyValueStore(),
    clock,
    // A higher budget than the default exposes the later rungs of the ladder.
    {minSpacingMs: 0, maxTransientAttempts: 8},
  );
  expect(OFF_BACKOFF_CAP_MS).toBe(60_000);

  // 1 s, 2 s, 4 s, 8 s, 16 s, 32 s between the first seven failures.
  for (const at of [0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000]) {
    clock.advance(at - clock.now());
    expect((await client.lookup('3017620422003')).source).toBe('none');
  }
  expect(fetches).toBe(7);

  // The seventh failure would schedule 64 s; the cap makes it 60 s.
  clock.advance(59_999);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(7);
  clock.advance(1);
  await client.lookup('3017620422003');
  expect(fetches).toBe(8);
});

test('Retry-After wins over the exponential schedule, even on a 5xx', async () => {
  let fetches = 0;
  const clock = mutableClock(0);
  const {client} = clientWith(
    async () => {
      fetches += 1;
      return fetches === 1
        ? response(503, 'busy', {'retry-after': '7'})
        : response(200, HIT_BODY);
    },
    new MemoryKeyValueStore(),
    clock,
    {minSpacingMs: 0},
  );

  expect((await client.lookup('3017620422003')).source).toBe('none');
  clock.advance(6_999);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(1);
  clock.advance(1);
  expect((await client.lookup('3017620422003')).source).toBe('network');
  expect(fetches).toBe(2);
});

test('a 429 without Retry-After waits the 60 s default', async () => {
  let fetches = 0;
  const clock = mutableClock(0);
  const {client} = clientWith(
    async () => {
      fetches += 1;
      return fetches === 1 ? response(429, {}) : response(200, HIT_BODY);
    },
    new MemoryKeyValueStore(),
    clock,
    {minSpacingMs: 0},
  );

  expect((await client.lookup('3017620422003')).source).toBe('none');
  clock.advance(59_999);
  expect((await client.lookup('3017620422003')).source).toBe('none');
  expect(fetches).toBe(1);
  clock.advance(1);
  expect((await client.lookup('3017620422003')).source).toBe('network');
  expect(fetches).toBe(2);
});

test('a failing barcode does not delay another barcode’s first attempt', async () => {
  const a = '3017620422003';
  const b = '8076800195057';
  const urls: string[] = [];
  const clock = mutableClock(0);
  const {client} = clientWith(
    async url => {
      urls.push(url);
      return url.includes(a)
        ? response(500, 'down')
        : response(200, {status: 1, product: {product_name: 'Barilla'}});
    },
    new MemoryKeyValueStore(),
    clock,
    {minSpacingMs: 0},
  );

  expect((await client.lookup(a)).source).toBe('none');
  const gated = await client.lookup(a);
  expect(gated.note).toContain('backing off');
  expect(urls).toHaveLength(1); // A is in its 1 s backoff

  const other = await client.lookup(b);
  expect(other).toMatchObject({text: 'Barilla', source: 'network'});
  expect(urls).toHaveLength(2); // B reached the network at the same instant
});

test('after three transient failures the answer is cache-only, with an honest note', async () => {
  const store = new MemoryKeyValueStore();
  const clock = mutableClock(0);
  const staleAt = 0 - OFF_TTL_HIT_S - 10; // expired 10 s ago: usable as stale only
  await store.setItem(
    offCacheKey('3017620422003'),
    JSON.stringify({text: 'Nutella', hit: true, fetchedAt: staleAt}),
  );
  let fetches = 0;
  const {client} = clientWith(
    async () => {
      fetches += 1;
      return response(503, 'down');
    },
    store,
    clock,
    {minSpacingMs: 0},
  );

  for (const at of [0, 1_000, 3_000]) {
    clock.advance(at - clock.now());
    const result = await client.lookup('3017620422003');
    expect(result).toMatchObject({text: 'Nutella', source: 'stale'});
  }
  expect(fetches).toBe(3);
  const exhausted = await client.lookup('3017620422003');
  expect(exhausted).toMatchObject({text: 'Nutella', source: 'stale'});
  expect(exhausted.note).toContain('retry budget exhausted');
  const stored = JSON.parse(
    store.raw(offCacheKey('3017620422003')) as string,
  ) as OffCacheEntry;
  expect(stored.fetchedAt).toBe(staleAt);
});

// --- OFF.md §2 redirects (Kotlin OffRedirect parity) ----------------------------------------

test('redirect policy: three hops, HTTPS only, relative targets resolve', () => {
  let url = `https://world.openfoodfacts.org/api/v2/product/3017620422003.json`;
  for (let followed = 0; followed < OFF_REDIRECT_MAX_HOPS; followed += 1) {
    const next = resolveOffRedirect(
      url,
      `https://world.openfoodfacts.org/hop${followed + 1}`,
      followed,
    );
    expect(next).toBe(`https://world.openfoodfacts.org/hop${followed + 1}`);
    url = next as string;
  }
  expect(
    resolveOffRedirect(url, 'https://world.openfoodfacts.org/hop4', 3),
  ).toBeNull();
  expect(resolveOffRedirect(url, '/next', 0)).toBe(
    'https://world.openfoodfacts.org/next',
  );
  expect(resolveOffRedirect(url, null, 0)).toBeNull();
  expect(resolveOffRedirect(url, '   ', 0)).toBeNull();
  expect(() =>
    resolveOffRedirect(url, 'http://world.openfoodfacts.org/y', 0),
  ).toThrow(/HTTPS/);
});

test('the client follows three HTTPS hops and refuses a fourth', async () => {
  const urls: string[] = [];
  const {client} = clientWith(async (url, init) => {
    urls.push(url);
    expect(init.redirect).toBe('manual');
    return urls.length <= 3
      ? response(302, null, {location: `/hop${urls.length}`})
      : response(302, null, {location: '/hop4'});
  });

  const result = await client.lookup('3017620422003');
  expect(result).toMatchObject({text: null, hit: false, source: 'none'});
  expect(result.note).toContain('redirect not followed');
  expect(urls).toEqual([
    `https://world.openfoodfacts.org/api/v2/product/3017620422003.json?fields=${OFF_FIELDS}`,
    'https://world.openfoodfacts.org/hop1',
    'https://world.openfoodfacts.org/hop2',
    'https://world.openfoodfacts.org/hop3',
  ]);
});

test('a redirect that leaves HTTPS is refused and degrades', async () => {
  const {client} = clientWith(async () =>
    response(302, null, {location: 'http://world.openfoodfacts.org/y'}),
  );
  const result = await client.lookup('3017620422003');
  expect(result).toMatchObject({text: null, source: 'none'});
  expect(result.note).toMatch(/HTTPS/);
});

test('a silently auto-followed response that ends on http is refused', async () => {
  // RN's fetch follows redirects itself; `Response.url` is the one trace we get.
  const {client} = clientWith(async () => ({
    ...response(200, HIT_BODY),
    url: 'http://world.openfoodfacts.org/x',
  }));
  const result = await client.lookup('3017620422003');
  expect(result).toMatchObject({text: null, source: 'none'});
  expect(result.note).toMatch(/left HTTPS/);
});

// --- OFF.md §4.5/§4.6 single-flight, eviction and timeouts ---------------------------------

test('the in-flight entry is evicted on completion and on failure', async () => {
  let release: (value: OffResponseLike) => void = () => undefined;
  const pending = new Promise<OffResponseLike>(resolve => {
    release = resolve;
  });
  const {client} = clientWith(async () => pending);

  const lookup = client.lookup('3017620422003');
  expect(client.isInFlight('3017620422003')).toBe(true);
  release(response(200, HIT_BODY));
  await lookup;
  expect(client.isInFlight('3017620422003')).toBe(false);

  const failing = clientWith(async () => {
    throw new Error('boom');
  });
  const bad = failing.client.lookup('3017620422003');
  expect(failing.client.isInFlight('3017620422003')).toBe(true);
  await bad;
  expect(failing.client.isInFlight('3017620422003')).toBe(false);
});

test('the 3 s connect budget aborts a hanging request', async () => {
  jest.useFakeTimers();
  try {
    expect(OFF_CONNECT_TIMEOUT_MS).toBe(3_000);
    const client = new OffClient({
      store: new MemoryKeyValueStore(),
      fetch: (_url, init) =>
        new Promise<OffResponseLike>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        }),
    });
    const lookup = client.lookup('3017620422003');
    await jest.advanceTimersByTimeAsync(OFF_CONNECT_TIMEOUT_MS);
    const result = await lookup;
    expect(result).toMatchObject({text: null, hit: false, source: 'none'});
    expect(result.note).toContain('connect timeout');
    expect(client.isInFlight('3017620422003')).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('single-flight: concurrent lookups for one barcode share one request', async () => {
  let fetches = 0;
  let release: (value: OffResponseLike) => void = () => undefined;
  const pending = new Promise<OffResponseLike>(resolve => {
    release = resolve;
  });
  const {client} = clientWith(async () => {
    fetches += 1;
    return pending;
  });

  const first = client.lookup('3017620422003');
  const second = client.lookup('3017620422003');
  expect(second).toBe(first);
  release(response(200, HIT_BODY));
  const [a, b] = await Promise.all([first, second]);
  expect(a.text).toBe('Nutella');
  expect(b.text).toBe('Nutella');
  expect(fetches).toBe(1);
});

test('the request aborts after the total timeout and reports "none"', async () => {
  // The default is 10 s; this test only exercises the abort path, so a 10 ms client is used.
  const client = new OffClient({
    store: new MemoryKeyValueStore(),
    fetch: (_url, init) =>
      new Promise<OffResponseLike>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new Error('Aborted')),
        );
      }),
    timeoutMs: 10,
  });
  expect((await client.lookup('3017620422003')).source).toBe('none');
});

test('requests are spaced at least 100 ms apart', async () => {
  const clock = mutableClock();
  const {client} = clientWith(
    async () => response(200, HIT_BODY),
    new MemoryKeyValueStore(),
    clock,
  );
  await client.lookup('3017620422003');
  await client.lookup('3017620425035');
  expect(clock.sleeps.length).toBe(1);
  expect(clock.sleeps[0]).toBeGreaterThanOrEqual(100);
});
