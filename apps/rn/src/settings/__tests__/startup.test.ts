/**
 * Card A6-followup — the persisted settings actually reach the engine and the haptics flag at app
 * start. These are the wiring rules the A6 review found missing: the store was written and the
 * screen read it, but a restart ran the native default ladder and haptics were always on.
 *
 * Fake store (A2's `MemoryKeyValueStore`), fake backend sink, and the REAL haptics module so the
 * "off means silence" half is pinned at the point of use, not just in `setHapticsEnabled`.
 */
import {Vibration} from 'react-native';
import {MemoryKeyValueStore} from '../../list/store';
import {haptic, setHapticsEnabled} from '../../ui/haptics';
import {SETTINGS_KEY, SettingsRepository, serializeStoredSettings} from '../store';
import {applyStoredSettings, type StartupDeps} from '../startup';

function repository(initial: Record<string, string> = {}) {
  return new SettingsRepository(new MemoryKeyValueStore(initial));
}

function stored(backend: 'auto' | 'gpu' | 'cpu' | 'npu', haptics = true) {
  return {[SETTINGS_KEY]: serializeStoredSettings({backend, haptics})};
}

function deps(
  repo: SettingsRepository,
  overrides: Partial<StartupDeps> = {},
): StartupDeps & {applyBackend: jest.Mock} {
  return {
    repository: repo,
    applyBackend: jest.fn(async () => undefined),
    applyHaptics: jest.fn(),
    ...overrides,
  } as StartupDeps & {applyBackend: jest.Mock};
}

afterEach(() => {
  setHapticsEnabled(true);
  jest.restoreAllMocks();
  // RN's jest preset hands out shared mock functions; clearing keeps one test's calls out of the
  // next one's counts (`restoreAllMocks` cannot un-mock a property that was already a mock).
  jest.clearAllMocks();
});

describe('applyStoredSettings', () => {
  test('applies the persisted choice before the first embed (gpu survives a restart)', async () => {
    const d = deps(repository(stored('gpu')));

    const outcome = await applyStoredSettings(d);

    expect(d.applyBackend).toHaveBeenCalledTimes(1);
    expect(d.applyBackend).toHaveBeenCalledWith('gpu');
    expect(outcome.settings).toEqual({backend: 'gpu', haptics: true});
    expect(outcome.backendError).toBeNull();
  });

  test('"auto" is re-applied too: the native policy is process-local, not persisted natively', async () => {
    const d = deps(repository(stored('auto')));

    await applyStoredSettings(d);

    expect(d.applyBackend).toHaveBeenCalledWith('auto');
  });

  test('a corrupt document applies the shipped defaults instead of crashing', async () => {
    const d = deps(repository({[SETTINGS_KEY]: '{not json'}));

    const outcome = await applyStoredSettings(d);

    expect(d.applyBackend).toHaveBeenCalledWith('auto');
    expect(outcome.settings).toEqual({backend: 'auto', haptics: true});
    expect(outcome.backendError).toBeNull();
  });

  test('an unreadable store also falls back to the defaults (never throws)', async () => {
    const broken = new SettingsRepository({
      getItem: async () => {
        throw new Error('storage unavailable');
      },
      setItem: async () => undefined,
      removeItem: async () => undefined,
    });
    const d = deps(broken);

    await expect(applyStoredSettings(d)).resolves.toEqual({
      settings: {backend: 'auto', haptics: true},
      backendError: null,
    });
    expect(d.applyBackend).toHaveBeenCalledWith('auto');
  });

  test('a bridge that refuses the choice is reported, not thrown (old binary, no module)', async () => {
    const applyBackend = jest.fn(async () => {
      throw new Error('This binary predates the settings picker (card A6)');
    });
    const d = deps(repository(stored('npu')), {applyBackend});

    const outcome = await applyStoredSettings(d);

    expect(outcome.backendError).toContain('predates the settings picker');
    expect(outcome.settings.backend).toBe('npu');
    // Haptics still applied: one failing half must not skip the other.
    expect(d.applyHaptics).toHaveBeenCalledWith(true);
  });
});

describe('the persisted haptics switch gates the next tap', () => {
  test('haptics=false in the store means the first haptic() of the session is silent', async () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    // The app's real wiring: `device.ts` passes `setHapticsEnabled` as `applyHaptics`.
    const d = deps(repository(stored('auto', false)), {applyHaptics: setHapticsEnabled});

    await applyStoredSettings(d);
    haptic('confirm');

    expect(vibrate).not.toHaveBeenCalled();
  });

  test('haptics=true (the default) still vibrates — the gate is the setting, not the module', async () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const d = deps(repository(), {applyHaptics: setHapticsEnabled});

    const outcome = await applyStoredSettings(d);
    haptic('confirm');

    expect(outcome.settings.haptics).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});
