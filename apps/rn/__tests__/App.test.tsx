/**
 * @format
 */

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {BackHandler} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../src/App';
import {SETTINGS_KEY, serializeStoredSettings} from '../src/settings';
import {hapticsEnabled, setHapticsEnabled} from '../src/ui/haptics';

jest.mock('react-native/Libraries/Vibration/Vibration', () => ({
  vibrate: jest.fn(),
  cancel: jest.fn(),
}));

// Card A6-followup: the App root now applies the persisted settings at start-up and can mount the
// settings screen, so the bridge needs a spy-able stand-in. `modelPresent: false` keeps the screen's
// self-test on the honest E_NO_MODEL path — no engine is opened in Jest (there is no native module).
const mockSetBackend = jest.fn(async (_choice: string) => undefined);
const mockEmbedDocs = jest.fn(async (_texts: string[]) => ({
  vectors: [] as string[],
  backend: 'none',
  dims: 256,
  latencyMs: 0,
  openMs: 0,
}));
const mockStatus = {
  linked: false,
  backend: 'none',
  dims: 256,
  supportsImages: false,
  modelId: 'embeddinggemma-2-740m',
  modelPresent: false,
  modelPath: '',
  modelFile: '',
  open: false,
  hint: 'scripts/model.sh push dev.hajnina.scanlist.rn',
  modelBytes: 0,
  modelReadable: false,
  modelSha256: '',
  prompts: null,
};

jest.mock('../modules/embed', () => ({
  setBackend: (choice: string) => mockSetBackend(choice),
  embedDocs: (texts: string[]) => mockEmbedDocs(texts),
  embedStatus: async () => mockStatus,
  closeEmbed: async () => undefined,
  embedder: {
    name: 'android-embed',
    backend: 'none',
    dims: 256,
    embedDocs: mockEmbedDocs,
    embedQuery: mockEmbedDocs,
    embedImage: mockEmbedDocs,
  },
}));

// SpringIn / press springs are driven by timers; fake them so the tests are deterministic and no
// animation outlives a test (RN would touch the torn-down native module afterwards).
jest.useFakeTimers();

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });
  return tree!;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  accessibilityLabel: string,
): Promise<void> {
  const targets = tree.root.findAll(
    node =>
      node.props.accessibilityLabel === accessibilityLabel &&
      typeof node.props.onPress === 'function',
  );
  expect(targets.length).toBeGreaterThan(0);
  await ReactTestRenderer.act(async () => {
    targets[targets.length - 1].props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
}

let tree: ReactTestRenderer.ReactTestRenderer | undefined;

beforeEach(async () => {
  await AsyncStorage.clear();
  mockSetBackend.mockClear();
  mockEmbedDocs.mockClear();
  setHapticsEnabled(true);
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  tree = undefined;
  setHapticsEnabled(true);
  jest.clearAllTimers();
});

// Card A2: the app opens the lists screen (import / nested list / tick / persist / export). The
// native modules it touches are mocked in jest.setup.js.
test('renders the lists screen', async () => {
  tree = await mount();

  const json = JSON.stringify(tree.toJSON());
  expect(json).toContain('Shopping list');
  expect(json).toContain('Import, tick, export.');
  expect(json).toContain('No lists yet');
  // Card A6-followup: the one way into Settings.
  expect(json).toContain('Settings');
});

// Card A6-followup requirement 2: the persisted backend choice reaches the engine on mount, before
// Settings is ever opened (the native policy is process-local; a restart used to lose the choice).
test('applies the persisted backend choice at start-up', async () => {
  await AsyncStorage.setItem(
    SETTINGS_KEY,
    serializeStoredSettings({backend: 'gpu', haptics: true}),
  );

  tree = await mount();

  expect(mockSetBackend).toHaveBeenCalledTimes(1);
  expect(mockSetBackend).toHaveBeenCalledWith('gpu');
});

// Card A6-followup requirement 3: the saved haptics switch is in force before Settings is opened.
test('applies the persisted haptics switch at start-up', async () => {
  await AsyncStorage.setItem(
    SETTINGS_KEY,
    serializeStoredSettings({backend: 'auto', haptics: false}),
  );
  expect(hapticsEnabled()).toBe(true);

  tree = await mount();

  expect(hapticsEnabled()).toBe(false);
});

test('a corrupt settings document starts on the defaults without crashing', async () => {
  await AsyncStorage.setItem(SETTINGS_KEY, '{not json');

  tree = await mount();

  expect(mockSetBackend).toHaveBeenCalledWith('auto');
  expect(JSON.stringify(tree.toJSON())).toContain('No lists yet');
});

// Card A6-followup requirement 1: Settings is reachable from the lists screen and shows the same
// persisted choice the app just applied (one source of truth, no second copy).
test('lifts the lists screen into settings and back, showing the applied choice', async () => {
  await AsyncStorage.setItem(
    SETTINGS_KEY,
    serializeStoredSettings({backend: 'gpu', haptics: true}),
  );
  tree = await mount();

  await press(tree, 'Settings');
  // init() + the self-test effect settle off the render.
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});

  const settings = JSON.stringify(tree.toJSON());
  expect(settings).toContain('Backends, model, scanner.');
  expect(settings).toContain('Embedding backend');
  // The picker reflects the persisted document (the choice start-up applied), not `auto`.
  expect(settings).toContain('GPU — GPU only');

  await press(tree, 'Back');
  const back = JSON.stringify(tree.toJSON());
  expect(back).toContain('Shopping list');
  expect(back).not.toContain('Backends, model, scanner.');
});

// Card A6-followup review: the on-screen Back button was the only way out of Settings — Android's
// system back exited the app. Same BackHandler contract as ListDetailScreen/ScanScreen.
test('Android hardware back from Settings returns to the lists screen', async () => {
  const remove = jest.fn();
  const handlers: Array<() => boolean | null | undefined> = [];
  const add = jest.spyOn(BackHandler, 'addEventListener');
  add.mockImplementation(((
    event: string,
    handler: () => boolean | null | undefined,
  ) => {
    if (event === 'hardwareBackPress') {
      handlers.push(handler);
    }
    return {remove};
  }) as unknown as typeof BackHandler.addEventListener);

  tree = await mount();
  await press(tree, 'Settings');
  expect(add).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
  expect(handlers.length).toBeGreaterThan(0);

  let handled: boolean | null | undefined;
  await ReactTestRenderer.act(async () => {
    handled = handlers[handlers.length - 1]();
  });
  // Consumed by Settings, not by the system (which would exit the app).
  expect(handled).toBe(true);

  const back = JSON.stringify(tree.toJSON());
  expect(back).toContain('Shopping list');
  expect(back).not.toContain('Backends, model, scanner.');

  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  tree = undefined;
  expect(remove).toHaveBeenCalled();
  add.mockRestore();
});
