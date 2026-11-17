/**
 * The one file that talks to the device (card A2): `@react-native-async-storage/async-storage`
 * behind the `KeyValueStore` interface from `store.ts`.
 *
 * Keeping the native module here means every parsing/persisting/exporting test runs in plain Jest
 * with `MemoryKeyValueStore`, and swapping the backend (MMKV, SQLite, a real file store) is a
 * one-file change that cannot touch the LIST.md contract.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {ListRepository, type KeyValueStore} from './store';

/** AsyncStorage as the repository's `KeyValueStore`. */
export const asyncStorageKeyValue: KeyValueStore = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: key => AsyncStorage.removeItem(key),
  getAllKeys: () => AsyncStorage.getAllKeys(),
};

/** The app's repository: persistence under `scanlist/*` in AsyncStorage. */
export function createListRepository(): ListRepository {
  return new ListRepository(asyncStorageKeyValue);
}
