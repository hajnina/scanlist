/**
 * AsyncStorage binding for the settings document (card A6) — the only file in `src/settings` that
 * imports the native storage module, so every parsing/persisting rule in `store.ts` is tested with
 * `MemoryKeyValueStore` (A2's pattern, `src/list/asyncStorage.ts`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SettingsRepository, type SettingsKeyValueStore} from './store';

export const asyncStorageSettingsStore: SettingsKeyValueStore = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: key => AsyncStorage.removeItem(key),
};

/** The app's settings repository: one document under `scanlist/settings/embedding`. */
export function createSettingsRepository(): SettingsRepository {
  return new SettingsRepository(asyncStorageSettingsStore);
}
