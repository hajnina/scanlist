/**
 * Card A6 — the polish copy decisions (POLISH.md items that are pure logic): camera permission,
 * "nothing in frame yet" / low-light guidance, and the quiet-time calculation behind it.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  QUIET_GUIDANCE_MS,
  quietFor,
  scanGuidance,
  type ScanProgress,
  type SourceActivity,
} from '../polish';
import {useScanGuidance} from '../useScanGuidance';

describe('quietFor', () => {
  const progress = (
    overrides: Partial<ScanProgress> = {},
  ): ScanProgress => ({
    barcode: 0,
    ocr: 0,
    image: 0,
    firstFrameAt: 0,
    heroAt: 0,
    ...overrides,
  });

  test('null until the camera has delivered a frame (a starting camera is not "nothing found")', () => {
    expect(quietFor(progress(), 10_000)).toBeNull();
    // A useful signal without any frame is impossible in the app; still not a quiet scene.
    expect(quietFor(progress({barcode: 9_000}), 10_000)).toBeNull();
  });

  test('frames alone do not reset the clock (the review blocker)', () => {
    // 20 s of 2.5 fps frame markers, not one barcode/OCR line/hero: the scene was quiet all along.
    expect(
      quietFor(progress({image: 20_000, firstFrameAt: 1_000}), 21_000),
    ).toBe(20_000);
  });

  test('a barcode, an OCR line or a hero resets the clock', () => {
    const live = progress({image: 20_000, firstFrameAt: 1_000});
    expect(quietFor({...live, barcode: 18_500}, 20_000)).toBe(1_500);
    expect(quietFor({...live, ocr: 18_000}, 20_000)).toBe(2_000);
    expect(quietFor({...live, heroAt: 19_000}, 20_000)).toBe(1_000);
  });

  test('the clock starts at the first frame when nothing useful has arrived yet', () => {
    expect(
      quietFor(progress({image: 5_000, firstFrameAt: 5_000}), 11_000),
    ).toBe(6_000);
  });

  test('never negative when the clock disagrees with an activity stamp', () => {
    expect(
      quietFor(
        progress({image: 12_000, firstFrameAt: 12_000}),
        10_000,
      ),
    ).toBeNull();
  });
});

describe('scanGuidance', () => {
  test('no permission and the OS can still ask: the allow copy', () => {
    expect(
      scanGuidance({hasPermission: false, canRequestPermission: true}),
    ).toMatchObject({
      kind: 'camera',
      title: 'The magic scan needs the camera',
    });
  });

  test('denied for good: the open-Settings copy', () => {
    expect(
      scanGuidance({hasPermission: false, canRequestPermission: false}),
    ).toMatchObject({
      kind: 'camera',
      title: 'Camera permission is blocked',
    });
  });

  test('permission is the highest priority hint', () => {
    expect(
      scanGuidance({
        hasPermission: false,
        canRequestPermission: true,
        quietMs: QUIET_GUIDANCE_MS,
      })?.kind,
    ).toBe('camera');
  });

  test('quiet long enough: the point-steady/low-light copy', () => {
    const guidance = scanGuidance({
      hasPermission: true,
      quietMs: QUIET_GUIDANCE_MS,
    });
    expect(guidance).toMatchObject({kind: 'light'});
    expect(guidance?.detail).toContain('low light');
    expect(guidance?.detail).toContain('torch');
  });

  test('still scanning: no hint (do not nag)', () => {
    expect(
      scanGuidance({hasPermission: true, quietMs: QUIET_GUIDANCE_MS - 1}),
    ).toBeNull();
    expect(scanGuidance({hasPermission: true, quietMs: null})).toBeNull();
  });
});


describe('useScanGuidance (card A6 review fixes: the quiet clock)', () => {
  interface ProbeProps {
    hasPermission: boolean;
    canRequestPermission?: boolean;
    activity: SourceActivity;
    tick?: {heroId: string | null; at: number} | null;
    modelMissing?: boolean;
    modelDownload?: {state: string; pct?: number; error?: string | null} | null;
  }

  function GuidanceProbe(props: ProbeProps) {
    const guidance = useScanGuidance(props);
    return React.createElement(
      'Guidance',
      null,
      guidance === null ? 'none' : `${guidance.kind}:${guidance.title}`,
    );
  }

  async function mount(
    props: ProbeProps,
  ): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(React.createElement(GuidanceProbe, props));
    });
    return tree!;
  }

  const textOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
    JSON.stringify(tree.toJSON());

  /** A render with fresh props, then one fake second (the hook's own ticker). */
  async function tick(
    tree: ReactTestRenderer.ReactTestRenderer,
    props: ProbeProps,
  ): Promise<void> {
    await ReactTestRenderer.act(async () => {
      tree.update(React.createElement(GuidanceProbe, props));
    });
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1_000);
    });
  }

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('a scene that went quiet shows the advice after 6 s without a useful result', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: 5_000},
    });

    // 5 s since the first frame: still below the 6 s threshold.
    expect(textOf(tree)).toContain('none');

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(textOf(tree)).toContain('light:Nothing in frame yet');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('frames flowing for 8 s with no useful result still go quiet (the review blocker)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    // The image source emits a marker every frame; that must not reset the clock.
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: Date.now()},
    });

    for (let second = 0; second < 5; second += 1) {
      await tick(tree, {
        hasPermission: true,
        activity: {barcode: 0, ocr: 0, image: Date.now()},
      });
      expect(textOf(tree)).toContain('none');
    }

    // 6 s of frames only: the advice must finally appear, not stay pinned at ~0 s quiet.
    await tick(tree, {
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: Date.now()},
    });
    expect(textOf(tree)).toContain('light:Nothing in frame yet');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a barcode/OCR signal keeps the scene useful while frames keep flowing', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: Date.now()},
    });

    for (let second = 0; second < 8; second += 1) {
      const at = Date.now();
      await tick(tree, {
        hasPermission: true,
        activity: {barcode: 0, ocr: at, image: at},
      });
      expect(textOf(tree)).toContain('none');
    }

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a ranked hero keeps the scene useful while frames keep flowing', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: Date.now()},
      tick: {heroId: null, at: Date.now()},
    });

    for (let second = 0; second < 8; second += 1) {
      const at = Date.now();
      await tick(tree, {
        hasPermission: true,
        activity: {barcode: 0, ocr: 0, image: at},
        tick: {heroId: 'milk', at},
      });
      expect(textOf(tree)).toContain('none');
    }

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('one hero resets the whole stretch, then the clock runs again', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: Date.now()},
    });

    await tick(tree, {
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: Date.now()},
      tick: {heroId: 'milk', at: Date.now()},
    });

    // 5 s after the hero: still quiet, but below the threshold.
    for (let second = 0; second < 4; second += 1) {
      await tick(tree, {
        hasPermission: true,
        activity: {barcode: 0, ocr: 0, image: Date.now()},
        tick: {heroId: null, at: Date.now()},
      });
      expect(textOf(tree)).toContain('none');
    }

    await tick(tree, {
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: Date.now()},
      tick: {heroId: null, at: Date.now()},
    });
    // 6 s after the last hero with frames still flowing: advice.
    expect(textOf(tree)).toContain('light:Nothing in frame yet');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a download in progress replaces the adb push copy with live progress', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: 100},
      modelMissing: true,
      modelDownload: {state: 'downloading', pct: 42},
    });

    expect(textOf(tree)).toContain('Downloading model… 42%');
    expect(textOf(tree)).not.toContain('scripts/model.sh');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a failed download explains itself in the missing-model note', () => {
    const guidance = scanGuidance({
      hasPermission: true,
      modelMissing: true,
      modelDownload: {state: 'failed', pct: 3, error: 'HTTP 404'},
    });

    expect(guidance?.detail).toContain('Download failed: HTTP 404');
  });

  test('a missing bundle renders the model note (and wins over quiet time)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: 100},
      modelMissing: true,
    });

    expect(textOf(tree)).toContain('model:No embedding model on this phone');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('the model note loses to a missing camera permission (priority order)', async () => {
    jest.useFakeTimers();
    const tree = await mount({
      hasPermission: false,
      canRequestPermission: true,
      activity: {barcode: 0, ocr: 0, image: 0},
      modelMissing: true,
    });

    expect(textOf(tree)).toContain('camera:The magic scan needs the camera');
    expect(textOf(tree)).not.toContain('No embedding model');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('the 1 s ticker is torn down on unmount (no leaked interval)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: 5_000},
    });
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
