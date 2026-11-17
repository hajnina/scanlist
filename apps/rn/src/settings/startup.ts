/**
 * Applying the persisted settings at app start (card A6-followup).
 *
 * A6 persisted the backend choice and the haptics switch, but only the settings screen ever read
 * them: with Settings closed, a restart ran the native module's shipped ladder (the Kotlin side's
 * `backendOrder` starts `null`, i.e. GPU → CPU) and haptics always-on, so the picker was inert
 * until someone opened it. `App.tsx` calls the device wiring ({@linkcode applyPersistedSettings} in
 * `device.ts`) once on mount, so the saved choice is in force before the first scan, embed or tap.
 *
 * Two rules are structural:
 *
 *  - **Never blocks the first render.** The read is AsyncStorage-backed, so this settles after the
 *    first frame; the UI starts on the shipped defaults and adopts the saved values when they land.
 *  - **Never throws.** A missing, corrupt or unreadable document is the store's defaults
 *    (`parseStoredSettings` / `SettingsRepository.load`), and a bridge that refuses the choice (an
 *    older binary, an unlinked module) is reported in {@linkcode StartupOutcome.backendError}
 *    instead of taking the app down — B6's "a settings file must never brick the app" rule.
 *
 * The applied choice is *not* cached here: `SettingsScreen` builds its controller over the same
 * `scanlist/settings/embedding` document, so reopening Settings shows exactly what start-up
 * applied (one source of truth, no second copy to drift).
 */
import type {BackendChoice} from './backend';
import type {SettingsRepository, StoredSettings} from './store';

/** Everything device-specific is injected (tests use fakes; `device.ts` wires the app). */
export interface StartupDeps {
  repository: SettingsRepository;
  /**
   * Persist the policy in the engine and unload any open engine (`setBackend` in `modules/embed`),
   * so the first embed after start opens on the chosen ladder.
   */
  applyBackend: (choice: BackendChoice) => Promise<void>;
  /** Flip the UI kit's one haptics flag (`setHapticsEnabled` in `ui/haptics`). */
  applyHaptics: (enabled: boolean) => void;
}

/** What start-up applied, and what the bridge said about the backend half. */
export interface StartupOutcome {
  /** The settings now in force — the defaults when nothing was ever chosen or the document is junk. */
  settings: StoredSettings;
  /** The bridge's message when it refused the choice; `null` when the choice was applied. */
  backendError: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the persisted document once and put it in force. Resolves (never rejects): the haptics flag
 * is applied first because it is synchronous and must gate the very first tap, then the backend
 * choice is handed to the engine.
 */
export async function applyStoredSettings(
  deps: StartupDeps,
): Promise<StartupOutcome> {
  // `load()` validates every field and catches store failures: a broken document is the defaults.
  const settings = await deps.repository.load();
  deps.applyHaptics(settings.haptics);

  let backendError: string | null = null;
  try {
    await deps.applyBackend(settings.backend);
  } catch (error) {
    // An old binary without `setBackend`, or no native module at all: keep the shipped ladder and
    // report it. The app is still usable and the settings screen shows the failure on its own probe.
    backendError = messageOf(error);
  }
  return {settings, backendError};
}
