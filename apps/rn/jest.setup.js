/* eslint-env jest */
/**
 * Jest setup for the Track A skeleton.
 *
 * react-native-safe-area-context's provider measures the window with onLayout, which never fires
 * in react-test-renderer — use the mock the library ships so screen content is rendered in tests.
 */
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
