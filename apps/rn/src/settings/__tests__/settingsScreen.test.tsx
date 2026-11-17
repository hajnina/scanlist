/**
 * Card A6 — render smoke test for the settings screen: it renders the controller's snapshot (picker,
 * latency, model status, prefix set, haptics) and routes the two actions through the controller.
 * The decisions are covered by the module tests; this is the wiring the jsdom-level tests cannot see.
 *
 * Every tree is unmounted in `afterEach`: `SpringIn` uses a native-driver spring, and a tree left
 * mounted would keep that animation scheduled past Jest's teardown (the worker then crashes on a
 * dead native handle even though the test itself PASSed).
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {ScanListThemeProvider} from '../../theme';
import {MemoryKeyValueStore} from '../../list/store';
import type {BackendChoice} from '../backend';
import {E_NO_BACKEND, type SelfTestRunner} from '../latency';
import {EXPECTED_MODEL_BYTES, type ModelFileFacts} from '../modelStatus';
import type {PrefixInfo} from '../prefix';
import {SettingsScreen} from '../SettingsScreen';
import {SettingsController, type SettingsDeps} from '../state';
import {SettingsRepository} from '../store';

const MODEL: ModelFileFacts = {
  path: '/data/user/0/dev.hajnina.scanlist.rn/files/models/embeddinggemma-2-740m.litertlm',
  exists: true,
  isFile: true,
  readable: true,
  bytes: EXPECTED_MODEL_BYTES,
};

const PREFIXES: PrefixInfo = {
  active: 'mnemothera',
  version: 1,
  model: 'embeddinggemma-2-740m',
  docPrefix: 'task: search result | text: ',
  queryPrefix: 'task: search query | text: ',
  imagePrefix: '',
  dims: 256,
  nativeDims: 768,
};

function fakeRunner(backend: BackendChoice = 'cpu'): SelfTestRunner {
  return {
    selfTest: async (choice: BackendChoice) => ({
      ok: true as const,
      choice,
      report: {
        backend: backend === 'npu' ? 'npu' : backend === 'gpu' ? 'gpu' : 'cpu',
        samples: [{text: 'milk', millis: 12.34}],
        loadMillis: 1234,
        supportsImages: true,
        dims: 256,
      },
    }),
  } as unknown as SelfTestRunner;
}

/** A runner that fails with a stable code and the per-backend ladder reasons. */
function failingRunner(): SelfTestRunner {
  return {
    selfTest: async (choice: BackendChoice) => ({
      ok: false as const,
      choice,
      code: E_NO_BACKEND,
      message: 'all backends failed to open the bundle',
      reasons: ['gpu: E_GPU_INIT', 'cpu: E_EMBEDDER'],
    }),
  };
}

function controller(
  options: {
    model?: ModelFileFacts;
    prefixes?: PrefixInfo | null;
    runner?: SelfTestRunner;
  } = {},
): SettingsController {
  const deps: SettingsDeps = {
    repository: new SettingsRepository(new MemoryKeyValueStore()),
    runner: options.runner ?? fakeRunner(),
    probeModel: async () => options.model ?? MODEL,
    probePrefixes: async () =>
      options.prefixes === undefined ? PREFIXES : options.prefixes,
  };
  return new SettingsController(deps);
}

let tree: ReactTestRenderer.ReactTestRenderer | undefined;

async function mount(ctl: SettingsController): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <ScanListThemeProvider>
        <SettingsScreen onBack={() => undefined} controller={ctl} />
      </ScanListThemeProvider>,
    );
  });
  // init() + the run effect both settle off the first render.
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  return tree!;
}

async function render(ctl: SettingsController): Promise<string> {
  const mounted = await mount(ctl);
  return JSON.stringify(mounted.toJSON());
}

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  tree = undefined;
  jest.clearAllTimers();
});

describe('SettingsScreen', () => {
  test('renders the picker, the latency measurement, the model bundle and the prefix set', async () => {
    const ctl = controller();
    const text = await render(ctl);

    expect(text).toContain('Settings');
    expect(text).toContain('Auto');
    expect(text).toContain('GPU');
    expect(text).toContain('CPU');
    expect(text).toContain('NPU');
    expect(text).toContain('GPU → CPU fallback');
    // Latency hero: mean from the report + load time.
    expect(text).toContain('12.3 ms');
    expect(text).toContain('load 1.23 s');
    expect(text).toContain('text + image');
    // Model card: present at the pinned size, path and the EXPECTED sha label.
    expect(text).toContain(MODEL.path);
    expect(text).toContain('matches the pinned bundle size');
    expect(text).toContain('EXPECTED e7a8a220');
    // Prefix set: the summary and the named trailing spaces. The snapshot is JSON, so the
    // quoted prefix arrives with escaped quotes; the exact quoting is `describePrefix`'s own test.
    expect(text).toContain('mnemothera · v1 · 768→256');
    expect(text).toContain('task: search result | text: ');
    expect(text).toContain('· trailing space');
    expect(ctl.getSnapshot().phase).toBe('done');
  });

  test('a missing bundle shows E_NO_MODEL with the push hint instead of a fake size', async () => {
    const text = await render(
      controller({model: {path: MODEL.path, exists: false}}),
    );
    expect(text).toContain('E_NO_MODEL');
    expect(text).toContain('no bundle at');
    expect(text).toContain('scripts/model.sh push');
  });

  test('a failed self-test renders its code, message and ladder reasons (no stale number)', async () => {
    const text = await render(controller({runner: failingRunner()}));
    expect(text).toContain('E_NO_BACKEND');
    expect(text).toContain('all backends failed to open the bundle');
    expect(text).toContain('gpu: E_GPU_INIT');
    expect(text).toContain('cpu: E_EMBEDDER');
    expect(text).not.toContain('12.3 ms');
  });

  test('an unavailable prefix set says so (no invented prefixes)', async () => {
    const text = await render(controller({prefixes: null}));
    expect(text).toContain('prefix set unavailable');
  });

  test('picking a backend persists it and re-runs the self-test on the new choice', async () => {
    const ctl = controller();
    const mounted = await mount(ctl);

    const cpuChip = mounted.root.findAll(
      node =>
        node.props.accessibilityLabel === 'CPU' &&
        typeof node.props.onPress === 'function',
    );
    expect(cpuChip?.length).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      cpuChip?.[cpuChip.length - 1].props.onPress();
    });
    await ReactTestRenderer.act(async () => {});
    await ReactTestRenderer.act(async () => {});

    expect(ctl.getSnapshot().choice).toBe('cpu');
    expect(JSON.stringify(mounted.toJSON())).toContain(
      'CPU — CPU only · active CPU',
    );
  });

  // A6-followup review: the `(choice, runToken)` guard lives on the controller, so leaving Settings
  // and coming back (a real remount — new hook state) must not open the 484 MB model again.
  test('a remount reuses the measured run instead of re-running the self-test', async () => {
    const selfTest = jest.fn(fakeRunner().selfTest);
    const ctl = controller({runner: {selfTest} as unknown as SelfTestRunner});

    tree = await mount(ctl);
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(ctl.getSnapshot().phase).toBe('done');

    await ReactTestRenderer.act(async () => {
      tree?.unmount();
    });
    tree = undefined;

    // Same controller as `App` keeps; a brand-new tree.
    tree = await mount(ctl);
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(ctl.getSnapshot().phase).toBe('done');
  });

  test('the haptics switch routes through the controller and persists', async () => {
    const ctl = controller();
    const mounted = await mount(ctl);

    const switches = mounted.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Haptics' &&
        typeof node.props.onValueChange === 'function',
    );
    expect(switches?.length).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      switches?.[switches.length - 1].props.onValueChange(false);
    });

    expect(ctl.getSnapshot().haptics).toBe(false);
  });
});
