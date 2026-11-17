/**
 * Scan UI (card A5) — the magic scan screen and its testable heart.
 *
 *  - `ScanScreen` — camera preview (top ~45 %), source chips, hero card with the big tick button,
 *    ranked list. Thin: it wires A4 sources + A3 embedder + A2 repository into the engine below.
 *  - `tick.ts` — `ScanTickEngine`: signals → OFF → text queries (barcode first) → ts-core `rank`.
 *  - `pool.ts` — the ≤16 text-query pool with the barcode-priority ordering fix + sticky barcode.
 *  - `off.ts` / `offAsyncStorage.ts` — Open Food Facts lookup, derivation and the AsyncStorage cache
 *    (`scanlist/off/<barcode>`; OFF.md is the contract).
 *
 * Mounting (outside this card's `owns`, see Notes): from `ListDetailScreen` or `App.tsx`, with the
 * same props as the detail screen:
 *
 *   <ScanScreen repository={repository} stored={stored} onBack={…} onChanged={…} />
 */
export {ScanScreen, CAMERA_HEIGHT_RATIO} from './ScanScreen';
export {ScanTickEngine} from './tick';
export type {
  OffTextLookup,
  ScanEmbedder,
  ScanTick,
  ScanTickEngineOptions,
  ScanTickReason,
  ScanTickSnapshot,
} from './tick';
export {
  DEFAULT_BARCODE_HOLD_MS,
  DEFAULT_IMAGE_WINDOW_MS,
  DEFAULT_MAX_IMAGE_QUERIES,
  SignalPool,
  buildTextQueries,
} from './pool';
export type {
  BarcodePoolEntry,
  ImagePoolEntry,
  OcrPoolEntry,
  PoolSnapshot,
  ScanPoolOptions,
} from './pool';
export {
  OFF_CACHE_MAX_ENTRIES,
  OFF_CACHE_PREFIX,
  OFF_FIELDS,
  OFF_HOST,
  OFF_MAX_REQUESTS_PER_MINUTE,
  OFF_MIN_SPACING_MS,
  OFF_TIMEOUT_MS,
  OFF_TTL_HIT_S,
  OFF_TTL_MISS_S,
  OFF_USER_AGENT,
  OffCache,
  OffClient,
  cleanOffBrands,
  cleanOffField,
  defaultOffFetch,
  deriveProductText,
  isOffEntryFresh,
  isValidBarcode,
  offCacheKey,
  truncateOffText,
} from './off';
export type {
  OffCacheEntry,
  OffClientOptions,
  OffFetch,
  OffFetchInit,
  OffKeyValueStore,
  OffLookupResult,
  OffLookupSource,
  OffResponseLike,
} from './off';
export {createOffClient} from './offAsyncStorage';
export {useScanSession} from './useScanSession';
export type {ScanActivity, ScanSession} from './useScanSession';
