/**
 * Haptics helper — style guide §4: Confirm / ToggleOn / ToggleOff / Reject / LongPress.
 *
 * react-native-paper has no haptics API and RN core only exposes `Vibration`. M3 Expressive in
 * Bonsai Serve uses `LocalHapticFeedback` (Compose) — the platform HapticFeedbackConstants.
 * A tiny native module can expose those constants later (see BUILD.md "Not done here"); until
 * then `Vibration` gives the same "every action has a feel" behaviour with no native code, so
 * this card stays dependency-free.
 */
import {Platform, Vibration} from 'react-native';

export type HapticIntent =
  | 'confirm'
  | 'toggleOn'
  | 'toggleOff'
  | 'reject'
  | 'longPress';

/**
 * Android waveforms are [off, on, off, on, ...] — every pattern MUST lead with an off beat
 * (Vibration.vibrate feeds the array straight into VibrationEffect.createWaveform). A pattern
 * starting with an on beat is silent, i.e. the single-element forms this file used before the
 * PR #8 review never vibrated. On iOS Vibration is just AudioServicesPlaySystemSound: a fixed
 * ~400 ms buzz whose timing the pattern only schedules, so the five intents are only really
 * distinguishable on Android — which is the platform this card targets.
 */
const PATTERNS: Record<HapticIntent, number[]> = {
  confirm: [0, 12], // one crisp 12 ms tick
  toggleOn: [0, 8], // lighter 8 ms tick
  toggleOff: [0, 8, 40, 8], // double tick — "off" reads as two beats (checked-item recolour)
  reject: [6, 40, 12], // heavier buzz with a short tail (error event)
  longPress: [0, 18], // longer buzz (busy started)
};

const supported = Platform.OS === 'android' || Platform.OS === 'ios';

export function haptic(intent: HapticIntent): void {
  if (!supported) {
    return;
  }
  Vibration.vibrate(PATTERNS[intent]);
}
