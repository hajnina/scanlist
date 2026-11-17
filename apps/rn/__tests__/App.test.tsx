/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../src/App';

jest.mock('react-native/Libraries/Vibration/Vibration', () => ({
  vibrate: jest.fn(),
  cancel: jest.fn(),
}));

// SpringIn / press springs are driven by timers; fake them so the test is deterministic and no
// animation outlives the test (RN would touch the torn-down native module afterwards).
jest.useFakeTimers();

// Card A2: the app now opens the lists screen (import / nested list / tick / persist / export)
// instead of A1's static skeleton. The native modules it touches are mocked in jest.setup.js.
test('renders the lists screen', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });

  const json = JSON.stringify(tree?.toJSON());
  expect(json).toContain('Shopping list');
  expect(json).toContain('Import, tick, export.');
  expect(json).toContain('No lists yet');

  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  jest.clearAllTimers();
});
