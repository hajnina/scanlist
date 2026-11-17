/**
 * Card A6 — the settings controller: persistence, stale-number clearing, and the B6 review lessons
 * (serialised self-test runs; a mid-run switch must not strand the RUNNING phase or report the old
 * backend's numbers).
 */
import {MemoryKeyValueStore} from '../../list/store';
import type {BackendChoice} from '../backend';
import {EXPECTED_MODEL_BYTES} from '../modelStatus';
import {SettingsController, type SettingsDeps} from '../state';
import {SettingsRepository} from '../store';
import type {SelfTestRunner} from '../latency';
import type {PrefixInfo} from '../prefix';

const MODEL = {
  path: '/files/models/embeddinggemma-2-740m.litertlm',
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

/** Let queued promise callbacks run (no fake timers involved). */
const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};

interface FakeRunner {
  runner: SelfTestRunner;
  calls: BackendChoice[];
  gates: Array<() => void>;
  maxActive: () => number;
}

function fakeRunner(): FakeRunner {
  const calls: BackendChoice[] = [];
  const gates: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const runner = {
    async selfTest(choice: BackendChoice) {
      calls.push(choice);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => gates.push(resolve));
      active -= 1;
      const backend = choice === 'cpu' ? 'cpu' : choice === 'npu' ? 'npu' : 'gpu';
      return {
        ok: true as const,
        choice,
        report: {
          backend,
          samples: [{text: 'milk', millis: 10}],
          loadMillis: 20,
          supportsImages: false,
          dims: 256,
        },
      };
    },
  };
  return {
    runner: runner as unknown as SelfTestRunner,
    calls,
    gates,
    maxActive: () => maxActive,
  };
}

function makeController(
  initial: Record<string, string> = {},
  overrides: Partial<SettingsDeps> = {},
) {
  const store = new MemoryKeyValueStore(initial);
  const repository = new SettingsRepository(store);
  const fake = fakeRunner();
  const applyHaptics = jest.fn();
  const probeModel = jest.fn(async () => MODEL);
  const probePrefixes = jest.fn(async () => PREFIXES);
  const deps: SettingsDeps = {
    repository,
    runner: fake.runner,
    probeModel,
    probePrefixes,
    applyHaptics,
    ...overrides,
  };
  return {
    controller: new SettingsController(deps),
    repository,
    store,
    fake,
    applyHaptics,
    probeModel,
    probePrefixes,
  };
}

describe('SettingsController.init', () => {
  test('loads the stored choice + haptics, applies haptics, probes model and prefixes', async () => {
    const {controller, applyHaptics, probeModel, probePrefixes} =
      makeController({
        'scanlist/settings/embedding':
          '{"version":1,"embedding":{"backend":"cpu"},"ui":{"haptics":false}}',
      });
    expect(controller.getSnapshot().ready).toBe(false);

    await controller.init();

    expect(controller.getSnapshot()).toMatchObject({
      ready: true,
      choice: 'cpu',
      haptics: false,
      phase: 'idle',
      result: null,
    });
    expect(applyHaptics).toHaveBeenCalledWith(false);
    expect(probeModel).toHaveBeenCalled();
    expect(probePrefixes).toHaveBeenCalled();
    expect(controller.getSnapshot().model).toMatchObject({kind: 'present'});
    expect(controller.getSnapshot().prefixes).toEqual(PREFIXES);
  });

  test('is idempotent (StrictMode double effect must not load twice)', async () => {
    const {controller, probeModel} = makeController();
    await controller.init();
    await controller.init();
    expect(probeModel).toHaveBeenCalledTimes(1);
  });

  test('a failing probe becomes a hint, never a crash', async () => {
    const {controller} = makeController({}, {
      probeModel: async () => {
        throw new Error('stat failed');
      },
    });
    await controller.init();
    expect(controller.getSnapshot().error).toContain('stat failed');
    expect(controller.getSnapshot().ready).toBe(true);
  });
});

describe('SettingsController.select', () => {
  test('persists the choice and clears stale numbers', async () => {
    const {controller, repository, fake} = makeController();
    await controller.init();
    const run = controller.run();
    await flush();
    expect(controller.getSnapshot().phase).toBe('running');

    controller.select('cpu');
    expect(controller.getSnapshot()).toMatchObject({
      choice: 'cpu',
      phase: 'idle',
      result: null,
    });
    await flush();
    expect((await repository.load()).backend).toBe('cpu');

    fake.gates.shift()?.();
    await run;
  });

  test('selecting the same backend is a no-op (no write, no stale-run bump)', async () => {
    const {controller, repository} = makeController();
    await controller.init();
    const save = jest.spyOn(repository, 'setBackend');
    controller.select(controller.getSnapshot().choice);
    expect(save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().choice).toBe('auto');
  });

  test('rejects an unknown id by falling back to auto (never persists garbage)', async () => {
    const {controller, repository} = makeController();
    controller.select('server' as BackendChoice);
    // `server` parses to auto, which equals the current choice → no write.
    expect(controller.getSnapshot().choice).toBe('auto');
    expect((await repository.load()).backend).toBe('auto');
  });
});

describe('SettingsController.runIfNeeded', () => {
  test('measures each (choice, runToken) once — a remount reuses the measurement', async () => {
    const {controller, fake} = makeController();
    await controller.init();

    const first = controller.runIfNeeded();
    await flush();
    fake.gates.shift()?.();
    await first;
    expect(fake.calls).toEqual(['auto']);

    // What a screen remount does: same controller, ready snapshot, same choice + runToken.
    await controller.runIfNeeded();
    await flush();
    expect(fake.calls).toEqual(['auto']);

    // "Test again" changes the key and measures a fresh run.
    controller.rerun();
    const again = controller.runIfNeeded();
    await flush();
    fake.gates.shift()?.();
    await again;
    expect(fake.calls).toEqual(['auto', 'auto']);

    // A backend switch changes it too ("auto:1" → "cpu:1").
    controller.select('cpu');
    const switched = controller.runIfNeeded();
    await flush();
    fake.gates.shift()?.();
    await switched;
    expect(fake.calls).toEqual(['auto', 'auto', 'cpu']);
  });

  test('does nothing before the stored settings are loaded', async () => {
    const {controller, fake} = makeController();
    await controller.runIfNeeded();
    expect(fake.calls).toEqual([]);
    expect(controller.getSnapshot().phase).toBe('idle');
  });
});

describe('SettingsController.run', () => {
  test('runs, reports the measured backend and re-probes the model afterwards', async () => {
    const {controller, fake, probeModel} = makeController();
    await controller.init();
    probeModel.mockClear();

    const run = controller.run();
    await flush();
    expect(controller.getSnapshot().phase).toBe('running');
    expect(fake.calls).toEqual(['auto']);

    fake.gates.shift()?.();
    await run;

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('done');
    expect(snapshot.result).toMatchObject({ok: true, choice: 'auto'});
    expect(controller.activeBackend()).toBe('gpu');
    expect(probeModel).toHaveBeenCalledTimes(1);
  });

  test('serialises runs: a second run waits, then re-embeds with the CURRENT choice', async () => {
    const {controller, fake} = makeController();
    await controller.init();

    const first = controller.run();
    await flush();
    expect(fake.calls).toEqual(['auto']);

    // A mid-run switch + a second run (the screen's effect on the new choice).
    controller.select('cpu');
    const second = controller.run();
    await flush();
    // The in-flight run is still the only engine open: the second has NOT started.
    expect(fake.calls).toEqual(['auto']);
    expect(fake.maxActive()).toBe(1);

    fake.gates.shift()?.(); // finish the stale auto run
    await first;
    await flush();
    // The stale run's result is dropped and the queued run measures the new choice.
    expect(fake.calls).toEqual(['auto', 'cpu']);

    fake.gates.shift()?.();
    await second;

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('done');
    expect(snapshot.result).toMatchObject({
      ok: true,
      choice: 'cpu',
      report: {backend: 'cpu'},
    });
    expect(fake.maxActive()).toBe(1);
  });

  test('a stale run never strands the RUNNING phase when nothing queued a rerun', async () => {
    const {controller, fake} = makeController();
    await controller.init();

    const first = controller.run();
    await flush();
    expect(controller.getSnapshot().phase).toBe('running');

    controller.select('gpu');
    fake.gates.shift()?.();
    await first;
    await flush();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      result: null,
      choice: 'gpu',
    });
  });

  test('a throwing runner is rendered as E_EMBEDDER, not an unhandled rejection', async () => {
    const {controller} = makeController({}, {
      runner: {
        selfTest: async () => {
          throw new Error('defect');
        },
      } as unknown as SelfTestRunner,
    });

    await controller.run();

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'done',
      result: {ok: false, code: 'E_EMBEDDER', message: 'defect'},
    });
  });
});

describe('SettingsController.rerun / setHaptics / notifications', () => {
  test('rerun clears the numbers and bumps the token (the screen re-embeds)', async () => {
    const {controller} = makeController();
    const before = controller.getSnapshot().runToken;
    controller.rerun();
    expect(controller.getSnapshot().runToken).toBe(before + 1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      result: null,
    });
  });

  test('setHaptics applies immediately and persists', async () => {
    const {controller, repository, applyHaptics} = makeController();
    await controller.init();
    controller.setHaptics(false);
    expect(controller.getSnapshot().haptics).toBe(false);
    expect(applyHaptics).toHaveBeenLastCalledWith(false);
    await flush();
    expect((await repository.load()).haptics).toBe(false);
  });

  test('subscribers see one notification per real change and can unsubscribe', () => {
    const {controller} = makeController();
    const listener = jest.fn();
    const unsubscribe = controller.subscribe(listener);

    controller.setHaptics(false);
    expect(listener).toHaveBeenCalledTimes(1);
    controller.setHaptics(false); // no change
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    controller.setHaptics(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
