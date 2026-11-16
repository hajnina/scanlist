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

test('renders the skeleton home screen', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });

  const json = JSON.stringify(tree?.toJSON());
  expect(json).toContain('Shopping list');
  expect(json).toContain('Magic scan');

  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  jest.clearAllTimers();
});
