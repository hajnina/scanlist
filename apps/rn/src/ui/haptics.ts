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

const PATTERNS: Record<HapticIntent, number[]> = {
  confirm: [12],
  toggleOn: [8],
  toggleOff: [8],
  reject: [6, 40, 12],
  longPress: [18],
};

const supported = Platform.OS === 'android' || Platform.OS === 'ios';

export function haptic(intent: HapticIntent): void {
  if (!supported) {
    return;
  }
  Vibration.vibrate(PATTERNS[intent]);
}
