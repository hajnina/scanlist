/**
 * Card A6 — the single haptics flag every call site obeys. The settings tests cover persistence and
 * the switch; this pins the actual gate: off means silence, on passes a waveform, and every Android
 * pattern still leads with an off beat (Vibration treats a leading on beat as silence).
 */
import {Vibration} from 'react-native';
import {
  haptic,
  hapticsEnabled,
  setHapticsEnabled,
  type HapticIntent,
} from '../haptics';

const INTENTS: HapticIntent[] = [
  'confirm',
  'toggleOn',
  'toggleOff',
  'reject',
  'longPress',
];

afterEach(() => {
  setHapticsEnabled(true);
  jest.restoreAllMocks();
});

describe('haptics', () => {
  test('off means silence, on calls Vibration with an off-beat-led pattern', () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});

    setHapticsEnabled(false);
    expect(hapticsEnabled()).toBe(false);
    for (const intent of INTENTS) {
      haptic(intent);
    }
    expect(vibrate).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    expect(hapticsEnabled()).toBe(true);
    for (const intent of INTENTS) {
      haptic(intent);
    }
    expect(vibrate).toHaveBeenCalledTimes(INTENTS.length);
    for (const call of vibrate.mock.calls) {
      const pattern = call[0] as number[];
      // Android reads timings as [off, on, off, on, …]; the first entry is the off beat and the
      // second (the first vibration) must be positive, or the pattern is silent.
      expect(pattern[0]).toBeGreaterThanOrEqual(0);
      expect(pattern.length).toBeGreaterThan(1);
      expect(pattern[1]).toBeGreaterThan(0);
    }
  });
});
