/**
 * Colour helper for the progress tracks (card A2).
 *
 * MD3 colour roles from react-native-paper are `#RRGGBB`, so a translucent track is the same role
 * with a 2-digit alpha suffix (style guide: the track is the content colour at ~15%). Anything that
 * is already translucent (rgba, 8-digit hex) is returned untouched instead of producing an invalid
 * colour string.
 */
export function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : color;
}

/** 15% — the progress-bar track alpha from the Bonsai/ZenMeter screens. */
export const TRACK_ALPHA = '26';
