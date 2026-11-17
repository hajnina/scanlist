/**
 * Card A6 (A4 review nit) — the camera wiring without a device: VisionCamera is mocked, the
 * capture loop and feed are the real code. Pins the effect-driven start/stop (`active &&
 * hasPermission`, no `onStarted`/`onStopped`), the permission request, and the temp-JPEG release on
 * unmount.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {createFrameFeed} from '../frames';
import {ScanCamera} from '../camera';

type Permission = {
  hasPermission: boolean;
  canRequestPermission: boolean;
  status: string;
  requestPermission: jest.Mock;
};

let mockPermission: Permission;
let mockPhotoOutput: {
  capturePhoto: jest.Mock;
  currentResolution?: unknown;
};

jest.mock('react-native-vision-camera', () => {
  const ReactModule = require('react');
  return {
    Camera: (props: Record<string, unknown>) =>
      ReactModule.createElement('Camera', props),
    CommonResolutions: {HD_16_9: {width: 1280, height: 720}},
    useCameraPermission: () => mockPermission,
    usePhotoOutput: () => mockPhotoOutput,
  };
});

jest.mock('../../../../modules/embed', () => ({
  deleteTempFile: jest.fn(async () => ({deleted: true})),
}));

import {deleteTempFile} from '../../../../modules/embed';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]).buffer;

/** Let the capture loop's promise chain (capture → frame) settle. */
const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

function cameraOf(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  const nodes = tree.root.findAll(
    node => node.type === ('Camera' as never),
  );
  expect(nodes.length).toBe(1);
  return nodes[0];
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPermission = {
    hasPermission: true,
    canRequestPermission: false,
    status: 'granted',
    requestPermission: jest.fn(async () => true),
  };
  let photo = 0;
  mockPhotoOutput = {
    capturePhoto: jest.fn(async () => {
      photo += 1;
      return {
        width: 1280,
        height: 720,
        timestamp: 10 + photo,
        getFileDataAsync: async () => JPEG,
        saveToTemporaryFileAsync: async () => `/cache/photo-${photo}.jpg`,
        dispose: jest.fn(),
      };
    }),
  };
  (deleteTempFile as jest.Mock).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ScanCamera', () => {
  test('granted + active: isActive, the photo output, and a frame every interval', async () => {
    const feed = createFrameFeed();
    const seen = jest.fn();
    feed.subscribe(seen);

    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ScanCamera feed={feed} active intervalMs={400} />,
      );
    });

    const camera = cameraOf(tree!);
    expect(camera.props.isActive).toBe(true);
    expect(camera.props.device).toBe('back');
    expect(camera.props.outputs).toEqual([mockPhotoOutput]);
    // Card A6 nit (g): the loop follows `isActive`, not VisionCamera's start/stop callbacks.
    expect(camera.props.onStarted).toBeUndefined();
    expect(camera.props.onStopped).toBeUndefined();

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(0);
      await flush();
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toMatchObject({
      filePath: '/cache/photo-1.jpg',
      width: 1280,
      height: 720,
    });
    expect(typeof seen.mock.calls[0][0].release).toBe('function');
    expect(feed.pendingReleases()).toBe(1);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(400);
      await flush();
    });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(feed.pendingReleases()).toBe(2);

    await ReactTestRenderer.act(async () => {
      tree?.unmount();
    });
  });

  test('inactive: Camera is not active and the loop does not sample', async () => {
    const feed = createFrameFeed();
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ScanCamera feed={feed} active={false} intervalMs={400} />,
      );
    });

    expect(cameraOf(tree!).props.isActive).toBe(false);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(5000);
      await flush();
    });
    expect(mockPhotoOutput.capturePhoto).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      tree?.unmount();
    });
  });

  test('permission denied: renders no preview, and asks only while the OS allows it', async () => {
    mockPermission = {
      ...mockPermission,
      hasPermission: false,
      canRequestPermission: true,
      status: 'denied',
    };
    const feed = createFrameFeed();
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<ScanCamera feed={feed} />);
    });

    expect(tree!.toJSON()).toBeNull();
    expect(mockPermission.requestPermission).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => {
      tree?.unmount();
    });

    mockPermission = {
      ...mockPermission,
      canRequestPermission: false,
      requestPermission: jest.fn(async () => false),
    };
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<ScanCamera feed={feed} />);
    });
    // Denied for good: show the Settings copy, do not silently re-prompt.
    expect(mockPermission.requestPermission).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      tree?.unmount();
    });
  });

  test('unmount releases every temp JPEG the loop left behind', async () => {
    const feed = createFrameFeed();
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ScanCamera feed={feed} active intervalMs={400} />,
      );
    });

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(0);
      await flush();
    });
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(400);
      await flush();
    });
    expect(feed.pendingReleases()).toBe(2);

    await ReactTestRenderer.act(async () => {
      tree?.unmount();
    });

    expect(feed.pendingReleases()).toBe(0);
    expect(deleteTempFile).toHaveBeenCalledWith('/cache/photo-1.jpg');
    expect(deleteTempFile).toHaveBeenCalledWith('/cache/photo-2.jpg');
  });
});
