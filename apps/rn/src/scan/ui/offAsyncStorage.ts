/**
 * AsyncStorage binding for the OFF cache (card A5) — the only file in this directory that imports
 * a native module, so every rule of `off.ts` is tested in plain Jest.
 *
 * Key scheme (A2's persistence precedent, `apps/rn/src/list/store.ts`):
 *   `scanlist/off/<barcode digits verbatim>` → `{"text":"Nutella","hit":true,"fetchedAt":1794857704}`
 *
 * It sits beside `scanlist/list/<id>` and `scanlist/index`: OFF product texts survive app restarts
 * (OFF.md §4.7) and never leave the device. The raw OFF payload is not persisted (OFF.md §4).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {OffClient, type OffKeyValueStore} from './off';

export const asyncStorageOffStore: OffKeyValueStore = {
  getItem: key => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: key => AsyncStorage.removeItem(key),
  getAllKeys: () => AsyncStorage.getAllKeys(),
};

/** The app's OFF lookup: AsyncStorage cache + RN `fetch` to world.openfoodfacts.org. */
export function createOffClient(): OffClient {
  return new OffClient({store: asyncStorageOffStore});
}
