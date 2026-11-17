/**
 * Settings barrel (card A6) — the screen plus the tested rules behind it.
 *
 *   <SettingsScreen onBack={…} />                       // device controller, the app path
 *   <SettingsScreen controller={ctl} onBack={…} />      // tests / a provided controller
 *
 * Every rule (backend mapping, latency maths, model file status, prefix formatting, persistence,
 * the serialised self-test) is a plain module below; the screen and the hook only lay state out.
 */
export {
  BACKEND_OPTIONS,
  DEFAULT_BACKEND,
  backendCandidates,
  backendOption,
  backendSummary,
  isBackendChoice,
  isNativeBackend,
  ladderLabel,
  matchesChoice,
  parseBackendChoice,
  parseNativeBackend,
  type BackendChoice,
  type BackendOption,
  type NativeBackend,
} from './backend';
export {
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
  type LatencySample,
  type SelfTestOutcome,
  type SelfTestRunner,
  type SelfTestRunnerOptions,
} from './latency';
export {
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
  type ModelFileFacts,
  type ModelStatus,
} from './modelStatus';
export {
  describePrefix,
  docPrefixLine,
  imagePrefixLine,
  prefixInfoFromNative,
  prefixSummary,
  queryPrefixLine,
  type NativePrompts,
  type PrefixInfo,
} from './prefix';
export {
  QUIET_GUIDANCE_MS,
  quietFor,
  scanGuidance,
  type GuidanceInput,
  type GuidanceKind,
  type ScanGuidance,
  type ScanProgress,
  type SourceActivity,
} from './polish';
export {
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SettingsRepository,
  defaultStoredSettings,
  parseStoredSettings,
  serializeStoredSettings,
  type SettingsKeyValueStore,
  type StoredSettings,
} from './store';
export {
  SettingsController,
  type SettingsDeps,
  type SettingsPhase,
  type SettingsSnapshot,
} from './state';
export {useSettings, type UseSettingsResult} from './useSettings';
export {
  SettingsScreen,
  type SettingsScreenProps,
} from './SettingsScreen';
export {
  createNativeSettingsController,
} from './device';
export {
  asyncStorageSettingsStore,
  createSettingsRepository,
} from './asyncStorage';
export {
  useModelStatus,
  useScanGuidance,
  type ModelProbeState,
  type ScanGuidanceInput,
} from './useScanGuidance';
