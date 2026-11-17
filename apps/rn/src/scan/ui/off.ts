/**
 * Open Food Facts lookup for the magic scan (card A5) — `shared/off/OFF.md` is the normative spec.
 *
 * Three layers, all native-free so Jest exercises them:
 *
 *  1. `deriveProductText` — OFF.md §3: `product_name` → `generic_name` → brands fallback, never a
 *     concatenation; NFC + every Unicode White_Space run collapsed to one U+0020; 160 **code
 *     points** maximum, trailing spaces trimmed. The result is the raw query text (the query prefix
 *     is added later by the embedder) and the `barcodeName` the ranker boosts (§6).
 *  2. `OffCache` — OFF.md §4: one entry per barcode, persisted through the same `KeyValueStore`
 *     shape card A2 uses, so `scanlist/off/<barcode>` sits next to `scanlist/list/<id>` in
 *     AsyncStorage. Entry = `{text, hit, fetchedAt}` in **seconds**, TTL 30 days on a hit and 1 day
 *     on a miss. Expired entries are kept for stale-while-revalidate but never extended on failure.
 *  3. `OffClient` — the request contract of OFF.md §2: digit-only barcode validation, HTTP status
 *     authoritative (never `status_verbose`), single-flight per barcode, ≥100 ms between requests,
 *     ≤100 requests/minute, `Retry-After` on 429, at most 3 transient attempts per scan session,
 *     and a 10 s total timeout.
 *
 * Failure is normal (OFF.md §5): every path resolves to "no barcode text", never throws, so the
 * camera and the ranking loop keep running when OFF is down.
 */
import {casefold} from '@scanlist/ts-core';

// --- OFF.md §2: request contract ------------------------------------------------------------

export const OFF_HOST = 'world.openfoodfacts.org';
export const OFF_USER_AGENT = 'ScanList/0.1';
/** Exactly these five fields, nothing else (OFF.md §2). */
export const OFF_FIELDS = 'code,product_name,brands,generic_name,categories';
export const OFF_MIN_SPACING_MS = 100;
export const OFF_MAX_REQUESTS_PER_MINUTE = 100;
export const OFF_TIMEOUT_MS = 10_000;
/** Transient failures retried per barcode per scan session (OFF.md §4.4). */
export const OFF_MAX_TRANSIENT_ATTEMPTS = 3;

// --- OFF.md §4: cache rules -----------------------------------------------------------------

export const OFF_TTL_HIT_S = 30 * 24 * 60 * 60; // 2,592,000 s
export const OFF_TTL_MISS_S = 24 * 60 * 60; // 86,400 s
export const OFF_CACHE_PREFIX = 'scanlist/off/';
/** OFF.md §4.6 is a SHOULD: cap the cache at 1,000 entries. */
export const OFF_CACHE_MAX_ENTRIES = 1_000;

/** The slice of AsyncStorage the OFF cache needs — structurally the `KeyValueStore` of A2. */
export interface OffKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}

/** One cache entry, exactly the three fields OFF.md §4 allows. */
export interface OffCacheEntry {
  /** Raw derived text (§3) or `null` for a hit with no usable name. */
  text: string | null;
  /** `true` = positive entry (30 d), `false` = miss (1 d). */
  hit: boolean;
  /** Wall clock in seconds, when the HTTP response was received. */
  fetchedAt: number;
}

// --- OFF.md §3: derived query text ----------------------------------------------------------

/**
 * Unicode White_Space per OFF.md §3.1 step 3. Deliberately *not* `\s`: U+200B and U+FEFF are not
 * whitespace in the spec and must be kept.
 */
const WHITE_SPACE_RUN =
  // eslint-disable-next-line no-control-regex -- OFF.md's White_Space set includes U+0009-U+000D
  /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/** OFF.md §3.1 `clean(v)`: NFC, whitespace runs → one space, strip spaces. */
export function cleanOffField(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.normalize('NFC').replace(WHITE_SPACE_RUN, ' ').trim();
}

/** OFF.md §3.1 `clean_brands`: comma list, each piece cleaned, casefold-deduped, joined ", ". */
export function cleanOffBrands(value: unknown): string {
  const cleaned = cleanOffField(value);
  if (cleaned === '') {
    return '';
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of cleaned.split(',')) {
    const part = cleanOffField(piece);
    if (part === '') {
      continue;
    }
    const key = casefold(part.normalize('NFC'));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(part);
  }
  return out.join(', ');
}

/** OFF.md §3.3: hard cut at 160 **code points**, then strip trailing spaces. */
export function truncateOffText(text: string): string {
  const codePoints = Array.from(text);
  const cut = codePoints.length > 160 ? codePoints.slice(0, 160).join('') : text;
  return cut.replace(/ +$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * OFF.md §3: the derived query text of one API v2 body, or `null`.
 *
 * `status` must be the number 1 — never `status_verbose` (a real fixture returns 404 with
 * `status: 0` while `status_verbose` claims the product was found), and extra keys are ignored.
 */
export function deriveProductText(body: unknown): string | null {
  if (!isRecord(body) || body.status !== 1) {
    return null;
  }
  const product = isRecord(body.product) ? body.product : {};
  const candidates = [
    cleanOffField(product.product_name),
    cleanOffField(product.generic_name),
    cleanOffBrands(product.brands),
  ];
  for (const candidate of candidates) {
    if (candidate !== '') {
      return truncateOffText(candidate);
    }
  }
  return null;
}

/** OFF.md §2: `^[0-9]{8,14}$`, sent verbatim (no zero-stripping, no re-padding). */
export function isValidBarcode(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{8,14}$/.test(value);
}

/** AsyncStorage key of one barcode entry. */
export function offCacheKey(barcode: string): string {
  return OFF_CACHE_PREFIX + barcode;
}

/** OFF.md §4 validity: `0 <= now - fetchedAt < TTL`, backwards clocks count as fresh. */
export function isOffEntryFresh(
  entry: OffCacheEntry,
  nowSeconds: number,
): boolean {
  const ttl = entry.hit ? OFF_TTL_HIT_S : OFF_TTL_MISS_S;
  const age = Math.max(0, nowSeconds - entry.fetchedAt);
  return age < ttl;
}

function parseEntry(raw: string | null): OffCacheEntry | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    const {text, hit, fetchedAt} = parsed;
    if (
      (text !== null && typeof text !== 'string') ||
      typeof hit !== 'boolean' ||
      typeof fetchedAt !== 'number' ||
      !Number.isFinite(fetchedAt)
    ) {
      return null;
    }
    return {text, hit, fetchedAt};
  } catch {
    return null;
  }
}

/** OFF.md §4 persistence: `scanlist/off/<barcode>` → `{text, hit, fetchedAt}`. */
export class OffCache {
  constructor(
    private readonly store: OffKeyValueStore,
    /** Wall clock in **seconds** (OFF.md §4 stores `fetchedAt` in seconds). */
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** The stored entry (fresh *or* expired) and whether it may be used without a request. */
  async read(
    barcode: string,
  ): Promise<{entry: OffCacheEntry; fresh: boolean} | null> {
    if (!isValidBarcode(barcode)) {
      return null;
    }
    const entry = parseEntry(await this.store.getItem(offCacheKey(barcode)));
    if (entry === null) {
      return null;
    }
    return {entry, fresh: isOffEntryFresh(entry, this.nowSeconds())};
  }

  /** Persist one outcome (hit or miss) with `fetchedAt = now`; evicts when over the cap. */
  async write(
    barcode: string,
    text: string | null,
    hit: boolean,
  ): Promise<OffCacheEntry> {
    const entry: OffCacheEntry = {text, hit, fetchedAt: this.nowSeconds()};
    await this.store.setItem(offCacheKey(barcode), JSON.stringify(entry));
    await this.evictIfNeeded();
    return entry;
  }

  /**
   * OFF.md §4.6: keep at most 1,000 entries, evicting expired ones first and then the least
   * recently fetched. Entries are independent keys (no index), so this is a best-effort sweep.
   */
  async evictIfNeeded(): Promise<void> {
    const offKeys = (await this.store.getAllKeys()).filter(key =>
      key.startsWith(OFF_CACHE_PREFIX),
    );
    if (offKeys.length <= OFF_CACHE_MAX_ENTRIES) {
      return;
    }
    const now = this.nowSeconds();
    const entries: {key: string; entry: OffCacheEntry | null}[] = [];
    for (const key of offKeys) {
      entries.push({key, entry: parseEntry(await this.store.getItem(key))});
    }
    const rank = (candidate: {entry: OffCacheEntry | null}): number => {
      if (candidate.entry === null) {
        return -1; // unreadable: drop first
      }
      return isOffEntryFresh(candidate.entry, now)
        ? candidate.entry.fetchedAt
        : -1; // expired before any fresh entry
    };
    entries.sort((a, b) => rank(a) - rank(b));
    let excess = offKeys.length - OFF_CACHE_MAX_ENTRIES;
    for (const candidate of entries) {
      if (excess <= 0) {
        break;
      }
      await this.store.removeItem(candidate.key);
      excess -= 1;
    }
  }
}

// --- OFF.md §2/§4: the client ---------------------------------------------------------------

/** The minimal response surface the client needs; the real fetch adapter fills it in. */
export interface OffResponseLike {
  status: number;
  /** `Response.headers.get` for `Retry-After`. */
  header(name: string): string | null;
  json(): Promise<unknown>;
}

export interface OffFetchInit {
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export type OffFetch = (
  url: string,
  init: OffFetchInit,
) => Promise<OffResponseLike>;

export type OffLookupSource =
  | 'cache'
  | 'network'
  | 'stale'
  | 'none'
  | 'invalid';

export interface OffLookupResult {
  /** Verbatim digit string (OFF.md §2). */
  barcode: string;
  /** Derived query text, `null` when the product has no usable name or the lookup failed. */
  text: string | null;
  /** Whether the last HTTP answer was a product hit (not whether `text` is usable). */
  hit: boolean;
  /** Where the result came from; the UI shows it, the ranker does not care. */
  source: OffLookupSource;
  /** Human-readable reason for `source: 'none'` (never parsed by anything). */
  note?: string;
}

export interface OffClientOptions {
  store: OffKeyValueStore;
  /** Injectable for tests; defaults to RN's global `fetch`. */
  fetch?: OffFetch;
  /** Milliseconds (pacing + retry windows). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  minSpacingMs?: number;
  maxRequestsPerMinute?: number;
  maxTransientAttempts?: number;
}

const systemNow = () => Date.now();
const systemSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** RN `fetch` → {@linkcode OffResponseLike}; the only place the global is touched. */
export const defaultOffFetch: OffFetch = async (url, init) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: init.headers,
    signal: init.signal,
    redirect: 'follow',
  });
  return {
    status: response.status,
    header: name => response.headers.get(name),
    json: () => response.json(),
  };
};

function parseRetryAfterMs(value: string | null, now: number): number {
  if (value === null || value.trim() === '') {
    return 60_000;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - now);
  }
  return 60_000;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * OFF lookup with the §4 cache and §2 request rules. Every method resolves: a failure is a
 * `source: 'none'` result, never a rejection (OFF.md §5 "failure is normal").
 */
export class OffClient {
  private readonly cache: OffCache;
  private readonly fetchImpl: OffFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly minSpacingMs: number;
  private readonly maxRequestsPerMinute: number;
  private readonly maxTransientAttempts: number;

  private readonly inFlight = new Map<string, Promise<OffLookupResult>>();
  /** barcode → ms epoch before which no request may be made (429 `Retry-After`). */
  private readonly retryAfter = new Map<string, number>();
  /** barcode → transient failures this scan session (OFF.md §4.4, max 3). */
  private readonly transientAttempts = new Map<string, number>();
  /** Request start times inside the rolling minute. */
  private readonly requestTimes: number[] = [];
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(options: OffClientOptions) {
    this.cache = new OffCache(
      options.store,
      () => Math.floor(this.now() / 1000),
    );
    this.fetchImpl = options.fetch ?? defaultOffFetch;
    this.now = options.now ?? systemNow;
    this.sleep = options.sleep ?? systemSleep;
    this.timeoutMs = options.timeoutMs ?? OFF_TIMEOUT_MS;
    this.minSpacingMs = options.minSpacingMs ?? OFF_MIN_SPACING_MS;
    this.maxRequestsPerMinute =
      options.maxRequestsPerMinute ?? OFF_MAX_REQUESTS_PER_MINUTE;
    this.maxTransientAttempts =
      options.maxTransientAttempts ?? OFF_MAX_TRANSIENT_ATTEMPTS;
  }

  /** Clear the per-session counters (a new scan session starts fresh). */
  resetSession(): void {
    this.retryAfter.clear();
    this.transientAttempts.clear();
    this.requestTimes.length = 0;
    this.lastRequestAt = Number.NEGATIVE_INFINITY;
  }

  /** Single-flight per barcode: concurrent ticks share one result (OFF.md §4.5). */
  lookup(barcode: string): Promise<OffLookupResult> {
    const existing = this.inFlight.get(barcode);
    if (existing !== undefined) {
      return existing;
    }
    const promise = this.resolve(barcode).finally(() => {
      this.inFlight.delete(barcode);
    });
    this.inFlight.set(barcode, promise);
    return promise;
  }

  private async resolve(barcode: string): Promise<OffLookupResult> {
    if (!isValidBarcode(barcode)) {
      return {
        barcode,
        text: null,
        hit: false,
        source: 'invalid',
        note: 'not an 8–14 digit product code',
      };
    }

    const cached = await this.cache.read(barcode);
    if (cached !== null && cached.fresh) {
      return {
        barcode,
        text: cached.entry.text,
        hit: cached.entry.hit,
        source: 'cache',
      };
    }
    const stale = cached?.entry ?? null;

    const now = this.now();
    const blockedUntil = this.retryAfter.get(barcode) ?? 0;
    if (now < blockedUntil) {
      return this.fallback(barcode, stale, 'rate-limited by Retry-After');
    }
    const attempts = this.transientAttempts.get(barcode) ?? 0;
    if (attempts >= this.maxTransientAttempts) {
      return this.fallback(barcode, stale, 'transient attempts exhausted');
    }

    await this.pace();
    try {
      const response = await this.request(barcode);
      return await this.handleResponse(barcode, response, stale);
    } catch (error) {
      this.transientAttempts.set(barcode, attempts + 1);
      return this.fallback(barcode, stale, messageOf(error));
    }
  }

  private async request(barcode: string): Promise<OffResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(
        `https://${OFF_HOST}/api/v2/product/${barcode}.json?fields=${OFF_FIELDS}`,
        {
          headers: {
            'User-Agent': OFF_USER_AGENT,
            Accept: 'application/json',
          },
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleResponse(
    barcode: string,
    response: OffResponseLike,
    stale: OffCacheEntry | null,
  ): Promise<OffLookupResult> {
    const status = response.status;
    if (status === 200) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch (error) {
        this.transientAttempts.set(
          barcode,
          (this.transientAttempts.get(barcode) ?? 0) + 1,
        );
        return this.fallback(barcode, stale, `unreadable body: ${messageOf(error)}`);
      }
      const text = deriveProductText(body);
      const hit =
        isRecord(body) && body.status === 1 && isRecord(body.product);
      if (!hit) {
        // 200 + status 0 / no product = miss (OFF.md §2.1) — negative cache, 1 day.
        await this.cache.write(barcode, null, false);
        return {barcode, text: null, hit: false, source: 'network'};
      }
      // A hit with no usable name is still a positive entry (OFF.md §3.4).
      await this.cache.write(barcode, text, true);
      return {barcode, text, hit: true, source: 'network'};
    }

    if (status === 404) {
      await this.cache.write(barcode, null, false);
      return {barcode, text: null, hit: false, source: 'network'};
    }

    if (status === 429) {
      const waitMs = parseRetryAfterMs(response.header('Retry-After'), this.now());
      this.retryAfter.set(barcode, this.now() + waitMs);
      return this.fallback(barcode, stale, 'HTTP 429');
    }

    this.transientAttempts.set(
      barcode,
      (this.transientAttempts.get(barcode) ?? 0) + 1,
    );
    return this.fallback(barcode, stale, `HTTP ${status}`);
  }

  /** Stale text is always better than a spinner (OFF.md §4.3/§5). */
  private fallback(
    barcode: string,
    stale: OffCacheEntry | null,
    note: string,
  ): OffLookupResult {
    if (stale !== null) {
      return {
        barcode,
        text: stale.text,
        hit: stale.hit,
        source: 'stale',
        note,
      };
    }
    return {barcode, text: null, hit: false, source: 'none', note};
  }

  /** ≥100 ms between requests and ≤100 per rolling minute (OFF.md §5). */
  private async pace(): Promise<void> {
    let now = this.now();
    const windowStart = now - 60_000;
    while (
      this.requestTimes.length > 0 &&
      (this.requestTimes[0] as number) < windowStart
    ) {
      this.requestTimes.shift();
    }
    if (this.requestTimes.length >= this.maxRequestsPerMinute) {
      const oldest = this.requestTimes[0] as number;
      const wait = oldest + 60_000 - now;
      if (wait > 0) {
        await this.sleep(wait);
        now = this.now();
      }
      this.requestTimes.shift();
    }
    const earliest = this.lastRequestAt + this.minSpacingMs;
    if (now < earliest) {
      await this.sleep(earliest - now);
      now = this.now();
    }
    this.lastRequestAt = now;
    this.requestTimes.push(now);
  }
}
