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
import {SettingsController, type SettingsDeps} from './state';

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
