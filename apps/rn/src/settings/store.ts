/**
 * Persisted settings (card A6) — the RN twin of B6's `SettingsStore.kt`.
 *
 * One versioned JSON document under `scanlist/settings/embedding` (the list track's key scheme,
 * `src/list/store.ts`), inspectable with `adb shell run-as … cat`, and written whole so a partial
 * write can never produce a half-valid settings file:
 *
 *   {
 *     "version": 1,
 *     "embedding": {"backend": "auto"},
 *     "ui": {"haptics": true}
 *   }
 *
 * A missing, empty or corrupt document means "never chosen" → the shipped defaults. Reading never
 * throws: a settings file must never brick the app (B6's rule, LIST.md §5's spirit).
 *
 * The store is behind a three-method interface (no `getAllKeys`: settings live under one known key)
 * so Jest covers every branch with `MemoryKeyValueStore` and `asyncStorage.ts` stays the one file
 * that imports the native module.
 */
import {
  DEFAULT_BACKEND,
  parseBackendChoice,
  type BackendChoice,
} from './backend';

/** Storage key of the one settings document (a sibling of `scanlist/list/<id>` and `scanlist/index`). */
export const SETTINGS_KEY = 'scanlist/settings/embedding';

/** Schema version of the document; bump only with a migration in {@linkcode parseStoredSettings}. */
export const SETTINGS_VERSION = 1;

/** What survives a restart: the picker choice and the haptics switch. */
export interface StoredSettings {
  backend: BackendChoice;
  haptics: boolean;
}

/** Never chosen: the shipped GPU→CPU ladder with haptics on (style guide §4). */
export const defaultStoredSettings: StoredSettings = Object.freeze({
  backend: DEFAULT_BACKEND,
  haptics: true,
});

/** The slice of AsyncStorage the settings need (see `KeyValueStore` in `list/store.ts`). */
export interface SettingsKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pure parse of a stored document. Every field is validated on its own, so one corrupt field only
 * resets that field (B6's `parse`).
 */
export function parseStoredSettings(
  text: string | null | undefined,
): StoredSettings {
  if (typeof text !== 'string' || text.trim() === '') {
    return defaultStoredSettings;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return defaultStoredSettings;
  }
  const root = asRecord(doc);
  if (root === null) {
    return defaultStoredSettings;
  }
  const embedding = asRecord(root.embedding);
  const ui = asRecord(root.ui);
  return {
    backend: parseBackendChoice(embedding?.backend),
    // Only an explicit boolean `false` turns haptics off; `"no"`, `null` and absent all stay on.
    haptics: ui?.haptics !== false,
  };
}

/** The document written to storage (pretty-printed + trailing newline: diff- and adb-friendly). */
export function serializeStoredSettings(settings: StoredSettings): string {
  const doc = {
    version: SETTINGS_VERSION,
    embedding: {backend: settings.backend},
    ui: {haptics: settings.haptics},
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Read/write the settings document. Writes are serialised through one promise chain so two
 * near-simultaneous toggles cannot lose each other (read → merge → write); a failed write rejects
 * that caller only and the chain survives (the next attempt still runs).
 */
export class SettingsRepository {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: SettingsKeyValueStore) {}

  /** The stored settings, or the defaults for a missing/broken/throw-store. Never throws. */
  async load(): Promise<StoredSettings> {
    try {
      return parseStoredSettings(await this.store.getItem(SETTINGS_KEY));
    } catch {
      return defaultStoredSettings;
    }
  }

  /** Persist the picker choice, keeping the other field. */
  setBackend(choice: BackendChoice): Promise<StoredSettings> {
    return this.write(current => ({...current, backend: choice}));
  }

  /** Persist the haptics switch, keeping the other field. */
  setHaptics(enabled: boolean): Promise<StoredSettings> {
    return this.write(current => ({...current, haptics: enabled}));
  }

  private write(
    mutate: (current: StoredSettings) => StoredSettings,
  ): Promise<StoredSettings> {
    const task = this.chain.then(async () => {
      const next = mutate(await this.load());
      await this.store.setItem(SETTINGS_KEY, serializeStoredSettings(next));
      return next;
    });
    // Keep the chain alive after a rejection: the next write must still queue behind this one.
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
