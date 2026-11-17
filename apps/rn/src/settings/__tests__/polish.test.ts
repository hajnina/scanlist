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
  type SourceActivity,
} from '../polish';
import {useScanGuidance} from '../useScanGuidance';

describe('quietFor', () => {
  test('null until a source has fired (a starting camera is not "nothing found")', () => {
    expect(quietFor({barcode: 0, ocr: 0, image: 0}, 10_000)).toBeNull();
  });

  test('measures from the newest of the three sources', () => {
    expect(quietFor({barcode: 0, ocr: 5_000, image: 8_000}, 10_000)).toBe(
      2_000,
    );
    expect(quietFor({barcode: 9_000, ocr: 5_000, image: 8_000}, 10_000)).toBe(
      1_000,
    );
  });

  test('never negative when the clock disagrees with an activity stamp', () => {
    expect(quietFor({barcode: 0, ocr: 0, image: 12_000}, 10_000)).toBeNull();
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


describe('useScanGuidance (card A6 review fix: the quiet clock)', () => {
  interface ProbeProps {
    hasPermission: boolean;
    canRequestPermission?: boolean;
    activity: SourceActivity;
    modelMissing?: boolean;
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

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('a scene that went quiet shows the advice after 6 s without any new signal', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: 5_000},
    });

    // 5 s after the last signal: still below the 6 s threshold.
    expect(textOf(tree)).toContain('none');

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(textOf(tree)).toContain('light:Nothing in frame yet');

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });

  test('a busy scene is not nagged while signals keep arriving', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    const tree = await mount({
      hasPermission: true,
      activity: {barcode: 0, ocr: 0, image: 10_000},
    });

    for (let second = 0; second < 8; second += 1) {
      await ReactTestRenderer.act(async () => {
        tree.update(
          React.createElement(GuidanceProbe, {
            hasPermission: true,
            activity: {barcode: 0, ocr: 0, image: Date.now()},
          }),
        );
      });
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(textOf(tree)).toContain('none');
    }

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
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
