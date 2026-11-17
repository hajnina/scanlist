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
 *     ≤100 requests/minute, at most 3 transient attempts per barcode per scan session, a 3 s
 *     connect budget and a 10 s total timeout, and OFF.md §2's redirect policy (≤3 hops, HTTPS
 *     only). §4.4/§5 retry timing is per barcode: `Retry-After` wins, a bare 429 waits 60 s, a
 *     5xx/timeout backs off 1 s → 2 s → 4 s (cap 60 s). This mirrors the Kotlin track's
 *     `OffResolver`/`OffRedirect` (apps/kotlin/.../scan/ui/OffLookup.kt) rule for rule.
 *
 * Failure is normal (OFF.md §5): every path resolves to "no barcode text", never throws, so the
 * camera and the ranking loop keep running when OFF is down.
 *
 * Platform note: RN's `fetch` (the whatwg-fetch/XHR polyfill) has no native connect timeout and
 * ignores `redirect: 'manual'` — XHR follows redirects itself. The connect budget is therefore an
 * AbortController approximation (abort if no response headers arrived within 3 s), and hop control
 * runs whenever the adapter exposes redirects to us (the tests' fake fetch, or any runtime that
 * honours `'manual'`); on RN the HTTPS-only half is still enforced on the final `Response.url`.
 * See `resolveOffRedirect` and `followRedirects` for the exact split.
 */
import {casefold} from '@scanlist/ts-core';

// --- OFF.md §2: request contract ------------------------------------------------------------

export const OFF_HOST = 'world.openfoodfacts.org';
export const OFF_USER_AGENT = 'ScanList/0.1';
/** Exactly these five fields, nothing else (OFF.md §2). */
export const OFF_FIELDS = 'code,product_name,brands,generic_name,categories';
export const OFF_MIN_SPACING_MS = 100;
export const OFF_MAX_REQUESTS_PER_MINUTE = 100;
/** Total request budget (OFF.md §2); the connect budget below is carved out of it. */
export const OFF_TIMEOUT_MS = 10_000;
/**
 * OFF.md §2's 3 s connect budget. RN's `fetch` cannot set one natively, so this is enforced with an
 * AbortController: no response headers within 3 s aborts the request (see `OffClient.request`).
 */
export const OFF_CONNECT_TIMEOUT_MS = 3_000;
/** Transient failures retried per barcode per scan session (OFF.md §4.4). */
export const OFF_MAX_TRANSIENT_ATTEMPTS = 3;
/** Backoff after a 5xx/timeout: 1 s, 2 s, 4 s … capped here (OFF.md §5). */
export const OFF_BACKOFF_BASE_MS = 1_000;
export const OFF_BACKOFF_CAP_MS = 60_000;
/** A 429 without `Retry-After` waits this long (OFF.md §4.4). */
export const OFF_RETRY_AFTER_DEFAULT_MS = 60_000;
/** OFF.md §2 redirect policy: follow at most 3 hops and never leave HTTPS. */
export const OFF_REDIRECT_MAX_HOPS = 3;

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
  /** `Response.headers.get` for `Retry-After` / `Location`. */
  header(name: string): string | null;
  json(): Promise<unknown>;
  /**
   * Final URL of the response when the adapter exposes it (`Response.url` / XHR's `responseURL`).
   * Used to refuse a redirect that silently left HTTPS when the runtime followed it itself.
   */
  url?: string;
}

export interface OffFetchInit {
  headers: Record<string, string>;
  signal?: AbortSignal;
  /**
   * `'manual'` asks the runtime to hand redirects back to us so OFF.md's hop/HTTPS policy can be
   * enforced by {@linkcode resolveOffRedirect}. Runtimes that auto-follow (RN's XHR) ignore it.
   */
  redirect: 'manual' | 'follow';
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
  /** Connect budget (`OFF_CONNECT_TIMEOUT_MS`); the total `timeoutMs` still bounds the chain. */
  connectTimeoutMs?: number;
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
    // RN's polyfill ignores this and lets XHR follow redirects; documented at the top of the file.
    redirect: init.redirect,
  });
  return {
    status: response.status,
    header: name => response.headers.get(name),
    json: () => response.json(),
    url: response.url,
  };
};

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * OFF.md §2 redirect policy, the twin of Kotlin's `OffRedirect` (MAX_HOPS = 3): resolve `location`
 * against `current`, or `null` when there is no Location or the hop budget is spent.
 *
 * Throws for a non-HTTPS target — a downgrade is a policy violation, not a hop, and the caller
 * surfaces it as a transient failure (the camera and ranking loop keep working).
 */
export function resolveOffRedirect(
  current: string,
  location: string | null,
  followed: number,
): string | null {
  const target = (location ?? '').trim();
  if (target === '' || followed >= OFF_REDIRECT_MAX_HOPS) {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(target, current);
  } catch {
    throw new Error(`OFF redirect target is not a URL (got ${target})`);
  }
  if (resolved.protocol !== 'https:') {
    throw new Error(`OFF redirects must stay on HTTPS (got ${resolved.toString()})`);
  }
  return resolved.toString();
}

/**
 * `Retry-After` in milliseconds, or `null` when the header is absent/unusable. Both the delta form
 * and the HTTP-date form are honoured; the Kotlin transport only reads the delta form and treats a
 * date as the default (a documented superset, A5's original behaviour).
 */
function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

/**
 * OFF.md §4.4/§5: `Retry-After` when OFF sent one, 60 s for a 429 without it, otherwise exponential
 * 1 s, 2 s, 4 s … capped at 60 s. The third failure's 4 s value is recorded, but the attempt budget
 * refuses the fourth request.
 */
function retryDelayMs(
  status: number,
  retryAfter: string | null,
  failures: number,
  now: number,
): number {
  const header = parseRetryAfterMs(retryAfter, now);
  if (header !== null) {
    return header;
  }
  if (status === 429) {
    return OFF_RETRY_AFTER_DEFAULT_MS;
  }
  const shift = Math.min(Math.max(failures - 1, 0), 16);
  return Math.min(OFF_BACKOFF_BASE_MS * 2 ** shift, OFF_BACKOFF_CAP_MS);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Per-barcode retry schedule, the TS twin of Kotlin's private `Retry` data class. */
interface OffRetryState {
  failures: number;
  nextAttemptAtMs: number;
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
  private readonly connectTimeoutMs: number;
  private readonly minSpacingMs: number;
  private readonly maxRequestsPerMinute: number;
  private readonly maxTransientAttempts: number;

  private readonly inFlight = new Map<string, Promise<OffLookupResult>>();
  /**
   * Per barcode retry schedule (OFF.md §4.4/§5), exactly the Kotlin `Retry(failures,
   * nextAttemptAtMs)`: a failing barcode must never gate another barcode's first attempt.
   */
  private readonly retries = new Map<string, OffRetryState>();
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
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? OFF_CONNECT_TIMEOUT_MS;
    this.minSpacingMs = options.minSpacingMs ?? OFF_MIN_SPACING_MS;
    this.maxRequestsPerMinute =
      options.maxRequestsPerMinute ?? OFF_MAX_REQUESTS_PER_MINUTE;
    this.maxTransientAttempts =
      options.maxTransientAttempts ?? OFF_MAX_TRANSIENT_ATTEMPTS;
  }

  /** Clear the per-session counters (a new scan session starts fresh). */
  resetSession(): void {
    this.retries.clear();
    this.requestTimes.length = 0;
    this.lastRequestAt = Number.NEGATIVE_INFINITY;
  }

  /** Single-flight per barcode: concurrent ticks share one result (OFF.md §4.5). */
  lookup(barcode: string): Promise<OffLookupResult> {
    const existing = this.inFlight.get(barcode);
    if (existing !== undefined) {
      return existing;
    }
    // §4.6: the map entry lives exactly as long as the request does — completion, error and abort
    // all run `finally`, so a failing barcode never leaks an entry (and never blocks a retry).
    const promise = this.resolve(barcode).finally(() => {
      this.inFlight.delete(barcode);
    });
    this.inFlight.set(barcode, promise);
    return promise;
  }

  /** Whether a request for this barcode is currently in flight (OFF.md §4.5/§4.6). */
  isInFlight(barcode: string): boolean {
    return this.inFlight.has(barcode);
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

    // §4.4/§5: after the fresh-cache shortcut and before pacing, a barcode that just failed waits
    // out its Retry-After/backoff window; the tick keeps ranking from the cache meanwhile.
    const gate = this.retryGate(barcode, this.now());
    if (gate !== null) {
      return this.fallback(barcode, stale, gate);
    }

    await this.pace();
    try {
      const response = await this.request(barcode);
      return await this.handleResponse(barcode, response, stale);
    } catch (error) {
      // No usable response (network error, timeout, refused redirect): transient, no cache write.
      this.noteTransient(barcode, 0, null, this.now());
      return this.fallback(barcode, stale, messageOf(error));
    }
  }

  /** Null while a request may go ahead; otherwise the honest reason the tick uses the cache. */
  private retryGate(barcode: string, now: number): string | null {
    const state = this.retries.get(barcode);
    if (state === undefined) {
      return null;
    }
    if (state.failures >= this.maxTransientAttempts) {
      return 'OFF retry budget exhausted — using the cache';
    }
    if (now < state.nextAttemptAtMs) {
      return 'OFF backing off — using the cache';
    }
    return null;
  }

  /**
   * Record one transient failure and schedule the next allowed attempt. `status` 0 means the
   * request produced no HTTP answer (network error, connect/total timeout, refused redirect).
   */
  private noteTransient(
    barcode: string,
    status: number,
    retryAfter: string | null,
    failedAtMs: number,
  ): void {
    const failures = (this.retries.get(barcode)?.failures ?? 0) + 1;
    const delay = retryDelayMs(status, retryAfter, failures, failedAtMs);
    this.retries.set(barcode, {
      failures,
      nextAttemptAtMs: failedAtMs + delay,
    });
  }

  /** Any cacheable answer clears the barcode's retry state (Kotlin `noteSuccess`). */
  private noteSuccess(barcode: string): void {
    this.retries.delete(barcode);
  }

  private async request(barcode: string): Promise<OffResponseLike> {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.followRedirects(
        `https://${OFF_HOST}/api/v2/product/${barcode}.json?fields=${OFF_FIELDS}`,
        controller,
      );
    } finally {
      clearTimeout(totalTimer);
    }
  }

  /**
   * OFF.md §2 redirects: ≤3 hops, HTTPS only. Each hop goes through
   * {@linkcode resolveOffRedirect}; a 3xx with no Location or after the hop budget is returned to
   * `handleResponse` and degrades as transient (never cached).
   *
   * On RN, `fetch` follows redirects itself, so this loop only sees them when the runtime honours
   * `redirect: 'manual'`. The one part that still holds on RN is the HTTPS check on `Response.url`
   * below: a silent downgrade is refused.
   */
  private async followRedirects(
    url: string,
    controller: AbortController,
  ): Promise<OffResponseLike> {
    let current = url;
    let followed = 0;
    for (;;) {
      const response = await this.fetchOnce(current, controller);
      if (response.url !== undefined && !isHttpsUrl(response.url)) {
        throw new Error(`OFF response left HTTPS (got ${response.url})`);
      }
      if (response.status < 300 || response.status > 399) {
        return response;
      }
      const next = resolveOffRedirect(
        current,
        response.header('Location'),
        followed,
      );
      if (next === null) {
        return response;
      }
      current = next;
      followed += 1;
    }
  }

  /**
   * One HTTP hop with OFF.md §2's 3 s connect budget: RN has no native connect timeout, so if the
   * response headers have not arrived within `connectTimeoutMs` the shared controller is aborted.
   * The 10 s total budget is the caller's timer and covers the whole redirect chain.
   */
  private async fetchOnce(
    url: string,
    controller: AbortController,
  ): Promise<OffResponseLike> {
    let connectTimedOut = false;
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      controller.abort();
    }, this.connectTimeoutMs);
    try {
      return await this.fetchImpl(url, {
        headers: {
          'User-Agent': OFF_USER_AGENT,
          Accept: 'application/json',
        },
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (connectTimedOut) {
        throw new Error(`OFF connect timeout after ${this.connectTimeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(connectTimer);
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
        this.noteTransient(barcode, status, null, this.now());
        return this.fallback(barcode, stale, `unreadable body: ${messageOf(error)}`);
      }
      const text = deriveProductText(body);
      const hit =
        isRecord(body) && body.status === 1 && isRecord(body.product);
      this.noteSuccess(barcode);
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
      this.noteSuccess(barcode);
      await this.cache.write(barcode, null, false);
      return {barcode, text: null, hit: false, source: 'network'};
    }

    // Any other status is transient. `Retry-After` wins when present; 429 without it waits 60 s;
    // 5xx/timeout back off 1 s → 2 s → 4 s. A 3xx here means the hop/scheme policy stopped it.
    this.noteTransient(
      barcode,
      status,
      response.header('Retry-After'),
      this.now(),
    );
    if (status >= 300 && status <= 399) {
      return this.fallback(
        barcode,
        stale,
        `OFF redirect not followed (HTTP ${status})`,
      );
    }
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
