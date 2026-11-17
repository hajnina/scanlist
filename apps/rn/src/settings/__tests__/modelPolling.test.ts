/**
 * MODELDL fix 4 + fix 6 (JS half): `useModelStatus` is the only thing that asks the bridge about the
 * in-app download, and it re-polls **only** while the snapshot says downloading/verifying.
 *
 * That is why the cold-start race was real: the native `start()` published nothing synchronously, so
 * the first (and only) probe answered `idle` and the 484 MB download ran invisibly — the adb-push
 * hint stuck for the whole session (reviewer scratch: "probe calls after 10 s: 1"). The Kotlin side
 * now publishes DOWNLOADING before its worker spawns (see `ModelDownloadTest`); these tests pin the
 * JS half of the contract: a `downloading` snapshot keeps polling, and `idle`/`ready`/`failed` do
 * not busy-poll (they are terminal snapshots, not "nothing happened yet").
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  useModelStatus,
  type ModelProbeState,
  type ModelProbeOptions,
} from '../useScanGuidance';

type Probe = NonNullable<ModelProbeOptions['probe']>;

describe('useModelStatus (in-app download polling)', () => {
  let latest: ModelProbeState | null = null;

  function StatusProbe({probe}: {probe: Probe}) {
    latest = useModelStatus({probe});
    return null;
  }

  async function mount(probe: Probe): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(React.createElement(StatusProbe, {probe}));
    });
    return tree!;
  }

  /** Advance one poll period and let the probe's promise (and its setState) settle. */
  async function advance(ms = 1_000): Promise<void> {
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    latest = null;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('a downloading snapshot keeps re-polling (the fix for the stuck adb hint)', async () => {
    const probe = jest.fn<ReturnType<Probe>, Parameters<Probe>>(async () => ({
      modelPresent: false,
      download: {state: 'downloading', pct: 7},
    }));
    const tree = await mount(probe);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(latest?.download?.state).toBe('downloading');

    await advance();
    expect(probe).toHaveBeenCalledTimes(2);

    await advance();
    expect(probe).toHaveBeenCalledTimes(3);

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a verifying snapshot also keeps re-polling', async () => {
    const probe = jest.fn<ReturnType<Probe>, Parameters<Probe>>(async () => ({
      modelPresent: false,
      download: {state: 'verifying', pct: 100},
    }));
    const tree = await mount(probe);
    await advance();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(latest?.download?.state).toBe('verifying');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('an idle snapshot is not re-polled (reviewer scratch behaviour, now pinned)', async () => {
    // The native side answers `downloading` synchronously once a download starts, so `idle` means
    // there is genuinely nothing in flight — polling it every second would be pure busywork.
    const probe = jest.fn<ReturnType<Probe>, Parameters<Probe>>(async () => ({
      modelPresent: false,
      download: {state: 'idle'},
    }));
    const tree = await mount(probe);
    await advance(10_000);
    expect(probe).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a ready bundle stops polling (no timer left running)', async () => {
    const probe = jest.fn<ReturnType<Probe>, Parameters<Probe>>(async () => ({
      modelPresent: true,
      download: {state: 'ready', pct: 100},
    }));
    const tree = await mount(probe);
    await advance(10_000);
    expect(probe).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a failed download stops polling and keeps its reason', async () => {
    const probe = jest.fn<ReturnType<Probe>, Parameters<Probe>>(async () => ({
      modelPresent: false,
      download: {state: 'failed', pct: 3, error: 'not enough free space'},
    }));
    const tree = await mount(probe);
    await advance(10_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(latest?.download?.error).toBe('not enough free space');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('unmount cancels the pending download poll (no leaked timer)', async () => {
    const probe = jest.fn<ReturnType<Probe>, Parameters<Probe>>(async () => ({
      modelPresent: false,
      download: {state: 'downloading', pct: 1},
    }));
    const tree = await mount(probe);
    expect(probe).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
    await advance(10_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
