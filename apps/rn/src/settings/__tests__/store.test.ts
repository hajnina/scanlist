/**
 * Card A6 — persisted settings on A2's repository pattern (mirror of B6's SettingsStoreTest):
 * write, read back, corrupt fallback, and the "never brick the app" rule.
 */
import {MemoryKeyValueStore} from '../../list/store';
import {
  SETTINGS_KEY,
  SETTINGS_VERSION,
  SettingsRepository,
  defaultStoredSettings,
  parseStoredSettings,
  serializeStoredSettings,
} from '../store';

function repository(initial: Record<string, string> = {}) {
  const store = new MemoryKeyValueStore(initial);
  return {store, repository: new SettingsRepository(store)};
}

describe('parseStoredSettings', () => {
  test('a missing or empty document means "never chosen"', () => {
    expect(parseStoredSettings(null)).toEqual(defaultStoredSettings);
    expect(parseStoredSettings(undefined)).toEqual(defaultStoredSettings);
    expect(parseStoredSettings('   ')).toEqual(defaultStoredSettings);
  });

  test('corrupt JSON falls back to the defaults instead of throwing', () => {
    expect(parseStoredSettings('{not json')).toEqual(defaultStoredSettings);
    expect(parseStoredSettings('[]')).toEqual(defaultStoredSettings);
    expect(parseStoredSettings('42')).toEqual(defaultStoredSettings);
  });

  test('an unknown backend id falls back to auto, a known one is kept', () => {
    expect(
      parseStoredSettings('{"embedding":{"backend":"server"}}').backend,
    ).toBe('auto');
    expect(
      parseStoredSettings('{"embedding":{"backend":" CPU "}}').backend,
    ).toBe('cpu');
    expect(
      parseStoredSettings('{"embedding":{"backend":"npu"}}').backend,
    ).toBe('npu');
  });

  test('a corrupt field only resets that field', () => {
    const parsed = parseStoredSettings(
      '{"embedding":{"backend":"gpu"},"ui":{"haptics":"no"}}',
    );
    expect(parsed).toEqual({backend: 'gpu', haptics: true});
  });

  test('a valid haptics=false survives, absent/other shapes default to on', () => {
    expect(
      parseStoredSettings('{"ui":{"haptics":false}}'),
    ).toEqual({backend: 'auto', haptics: false});
    expect(parseStoredSettings('{"ui":{}}').haptics).toBe(true);
    expect(parseStoredSettings('{"ui":null}').haptics).toBe(true);
  });
});

describe('serializeStoredSettings', () => {
  test('writes a versioned, inspectable document (B6 naming + the RN haptics field)', () => {
    const text = serializeStoredSettings({backend: 'gpu', haptics: false});
    expect(JSON.parse(text)).toEqual({
      version: SETTINGS_VERSION,
      embedding: {backend: 'gpu'},
      ui: {haptics: false},
    });
    expect(text.endsWith('\n')).toBe(true);
  });

  test('round-trips through the parser', () => {
    const settings = {backend: 'cpu' as const, haptics: false};
    expect(parseStoredSettings(serializeStoredSettings(settings))).toEqual(
      settings,
    );
  });
});

describe('SettingsRepository', () => {
  test('loads the defaults from an empty store (one key, no scanlist/list read)', async () => {
    const {store, repository: repo} = repository();
    expect(await repo.load()).toEqual(defaultStoredSettings);
    expect(await store.getAllKeys()).toEqual([]);
  });

  test('setBackend persists under scanlist/settings/embedding and keeps haptics', async () => {
    const {store, repository: repo} = repository();
    await repo.setHaptics(false);
    const saved = await repo.setBackend('cpu');

    expect(saved).toEqual({backend: 'cpu', haptics: false});
    expect(await store.getItem(SETTINGS_KEY)).toContain('"backend": "cpu"');
    expect(await repo.load()).toEqual({backend: 'cpu', haptics: false});
  });

  test('setHaptics persists and keeps the backend', async () => {
    const {repository: repo} = repository();
    await repo.setBackend('npu');
    await repo.setHaptics(false);
    expect(await repo.load()).toEqual({backend: 'npu', haptics: false});
    await repo.setHaptics(true);
    expect(await repo.load()).toEqual({backend: 'npu', haptics: true});
  });

  test('concurrent writes are serialised: neither field is lost', async () => {
    const {repository: repo} = repository();
    await Promise.all([repo.setBackend('gpu'), repo.setHaptics(false)]);
    expect(await repo.load()).toEqual({backend: 'gpu', haptics: false});
  });

  test('a corrupt stored document loads as defaults and the next write repairs it', async () => {
    const {repository: repo} = repository({[SETTINGS_KEY]: '{broken'});
    expect(await repo.load()).toEqual(defaultStoredSettings);
    await repo.setBackend('gpu');
    expect(await repo.load()).toEqual({backend: 'gpu', haptics: true});
  });

  test('a broken store reads as defaults (never throws) and a failed write rejects once', async () => {
    const failing = {
      getItem: async () => {
        throw new Error('store unavailable');
      },
      setItem: async () => {
        throw new Error('disk full');
      },
      removeItem: async () => undefined,
    };
    const repo = new SettingsRepository(failing);
    expect(await repo.load()).toEqual(defaultStoredSettings);
    await expect(repo.setBackend('cpu')).rejects.toThrow('disk full');
    // The write chain survives a rejection: the next attempt still runs.
    await expect(repo.setHaptics(false)).rejects.toThrow('disk full');
  });
});
