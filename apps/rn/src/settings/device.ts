/**
 * Device wiring for the settings screen (card A6) — the counterpart of B6's
 * `rememberSettingsState()`: AsyncStorage, the shared Android engine through `modules/embed`, and the
 * bundled `prompts.json` as the prefix source. Kept apart from `state.ts` so every rule stays a plain
 * Jest test with fakes and this file is the only one that touches the bridge.
 */
import {
  closeEmbed,
  embedDocs,
  embedder,
  embedStatus,
  setBackend,
} from '../../modules/embed';
import type {BackendChoice} from './backend';
import {createSelfTestRunner, type EngineProbe} from './latency';
import {factsFromNativeStatus} from './modelStatus';
import {prefixInfoFromNative} from './prefix';
import {createSettingsRepository} from './asyncStorage';
import {applyStoredSettings, type StartupOutcome} from './startup';
import {SettingsController, type SettingsDeps} from './state';
import {setHapticsEnabled} from '../ui/haptics';

/**
 * Opens the engine under the picked policy and hands the runner a live view of it.
 *
 * `setBackend` persists the policy in the native module and unloads any open engine, so the first
 * `embedDocs` pays the load on the chosen ladder; the getters are read *after* that warm-up, which is
 * why they are getters and not copied fields.
 */
async function openProbe(choice: BackendChoice): Promise<EngineProbe> {
  await setBackend(choice);
  const status = await embedStatus();
  return {
    get backend() {
      return embedder.backend;
    },
    get dims() {
      return status.dims;
    },
    get supportsImages() {
      return status.supportsImages;
    },
    embedDocs: async texts => {
      await embedDocs(texts);
    },
    close: () => closeEmbed(),
  };
}

/** The model file the scanning pipeline actually opens (native `status()`), not a guess. */
async function probeModel() {
  return factsFromNativeStatus(await embedStatus());
}

/** The prefix set the engine reads from the bundled `prompts.json`; null on an older binary. */
async function probePrefixes() {
  const status = await embedStatus();
  return prefixInfoFromNative(status.prompts, status.dims);
}

/** The package-specific fix for a missing bundle (`scripts/model.sh push <package>`). */
async function probeModelHint(): Promise<string | null> {
  const status = await embedStatus();
  return status.hint;
}

/** The app's controller: AsyncStorage + the native engine + the bundled prefix set. */
export function createNativeSettingsController(): SettingsController {
  const runner = createSelfTestRunner({
    open: openProbe,
    checkModel: async () => {
      const status = await embedStatus();
      return {present: status.modelPresent, path: status.modelPath};
    },
  });
  const deps: SettingsDeps = {
    repository: createSettingsRepository(),
    runner,
    probeModel,
    probePrefixes,
    probeModelHint,
  };
  return new SettingsController(deps);
}

/**
 * App start-up wiring (card A6-followup): read the persisted document once and put it in force —
 * the backend policy in the native engine (`setBackend`, which also unloads any open engine, so the
 * first embed opens on the chosen ladder) and the haptics flag in the UI kit. Called
 * fire-and-forget from `App.tsx`: it never rejects and never blocks the first render
 * (`startup.ts` has the rules; the `auto` choice is re-applied every start because the native
 * policy is process-local).
 */
export function applyPersistedSettings(): Promise<StartupOutcome> {
  return applyStoredSettings({
    repository: createSettingsRepository(),
    applyBackend: setBackend,
    applyHaptics: setHapticsEnabled,
  });
}
