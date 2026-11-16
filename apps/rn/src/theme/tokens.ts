/**
 * ScanList design tokens — "Material 3 Expressive by hand".
 *
 * Copied from references/bonsai-ui/STYLE_GUIDE.md §3 (Bonsai Serve / ZenMeter), which is the
 * project-wide UI rule. Keep the numbers identical to the Compose originals: springs, corner
 * radii, spacing and the Black (900) weights are what make the look.
 */
import {Platform} from 'react-native';

/** Style guide §3: everything prominent is FontWeight.Black (900). */
export const HEAVY = '900' as const;

export const FONT_FAMILY = Platform.select({
  android: 'sans-serif',
  default: 'System',
}) as string;

/** Machine values (URLs, keys, ids) are monospace — style guide §3 typography. */
export const MONO_FONT_FAMILY = Platform.select({
  android: 'monospace',
  default: 'Menlo',
}) as string;

/**
 * Compose `spring(dampingRatio, stiffness)` expressed as React Native `Animated.spring`
 * parameters (mass = 1): damping = dampingRatio * 2 * sqrt(stiffness).
 * Springs are physics animations in both frameworks, so the constants carry over verbatim.
 */
const spring = (stiffness: number, dampingRatio: number) => ({
  stiffness,
  damping: dampingRatio * 2 * Math.sqrt(stiffness),
  mass: 1,
  overshootClamping: dampingRatio >= 1,
  useNativeDriver: true,
});

export const Motion = {
  /** default spatial: position/size/shape, overshoots */
  spatial: spring(380, 0.8),
  /** press feedback */
  fastSpatial: spring(800, 0.6),
  slowSpatial: spring(200, 0.8),
  /** default effects: colour/alpha/numbers, no overshoot (JS driver — colours are not native-animatable) */
  effects: {...spring(1600, 1), useNativeDriver: false},
  fastEffects: {...spring(3800, 1), useNativeDriver: false},
  slowEffects: {...spring(800, 1), useNativeDriver: false},
} as const;

/** Style guide §3 "Shapes": very large and asymmetric radii, same dp values as Bonsai Serve. */
export const Shapes = {
  hero: {borderRadius: 44},
  /** asymmetric "leaf" (16 / 52 / 16 / 52) */
  leaf: {
    borderTopStartRadius: 16,
    borderTopEndRadius: 52,
    borderBottomEndRadius: 16,
    borderBottomStartRadius: 52,
  },
  leafMirror: {
    borderTopStartRadius: 52,
    borderTopEndRadius: 16,
    borderBottomEndRadius: 52,
    borderBottomStartRadius: 16,
  },
  /** stat tiles: diagonal pair, checkerboard across rows */
  tileLeft: {
    borderTopStartRadius: 36,
    borderTopEndRadius: 12,
    borderBottomEndRadius: 36,
    borderBottomStartRadius: 12,
  },
  tileRight: {
    borderTopStartRadius: 12,
    borderTopEndRadius: 36,
    borderBottomEndRadius: 12,
    borderBottomStartRadius: 36,
  },
  /** big tappable surface: corner morphs 28.dp (off) <-> 64.dp (on) */
  scanIdle: {borderRadius: 28},
  scanActive: {borderRadius: 64},
} as const;

export type CardVariant = 'hero' | 'leaf' | 'leafMirror' | 'tileLeft' | 'tileRight';

/** Style guide §3 "Spacing" (dp). */
export const Spacing = {
  screenHorizontal: 16,
  screenVertical: 12,
  gap: 12,
  heroPadding: 28,
  leafPadding: 24,
  tilePaddingHorizontal: 18,
  tilePaddingVertical: 16,
  labelTracking: 1.5,
  tileLabelTracking: 1,
} as const;

/** Staggered entrance (style guide §4 `springIn`): 80 ms per index, scale 0.8 → 1, y 90 → 0. */
export const SPRING_IN = {
  staggerMs: 80,
  fromScale: 0.8,
  fromTranslationY: 90,
} as const;
