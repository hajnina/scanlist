/* eslint-env jest */
/**
 * Jest setup for Track A.
 *
 * react-native-safe-area-context's provider measures the window with onLayout, which never fires
 * in react-test-renderer — use the mock the library ships so screen content is rendered in tests.
 */
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

/**
 * Card A2 added three native modules (persistence, document picker, clipboard). Their JS entry
 * points are ESM and call `TurboModuleRegistry.getEnforcing`, neither of which works in Jest on a
 * host without the native side. The logic tests are deliberately native-free (they use
 * `MemoryKeyValueStore`), so these mocks only keep the screen render smoke test loading — the real
 * implementations run on device.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    __esModule: true,
    default: {
      getItem: async key => store.get(key) ?? null,
      setItem: async (key, value) => {
        store.set(key, value);
      },
      removeItem: async key => {
        store.delete(key);
      },
      getAllKeys: async () => [...store.keys()],
      clear: async () => store.clear(),
    },
  };
});

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(async () => []),
  saveDocuments: jest.fn(async () => []),
  keepLocalCopy: jest.fn(async () => []),
  errorCodes: {OPERATION_CANCELED: 'OPERATION_CANCELED'},
  isErrorWithCode: () => false,
  types: {json: 'application/json'},
}));

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: {setString: jest.fn(), getString: jest.fn(async () => '')},
}));
