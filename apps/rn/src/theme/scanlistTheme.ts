/**
 * ScanList theme — MD3 via react-native-paper, themed to references/bonsai-ui/STYLE_GUIDE.md.
 *
 * The style guide's recipe (§2) is: MaterialTheme + dynamic colour on Android 12+, automatic
 * light/dark, and every colour read from a theme role (never hard-coded in the UI).
 * react-native-paper has no dynamic-colour support yet (that needs a native module — see
 * BUILD.md "Not done here"), so the guide's fallback seed palette is used:
 * teal #006B5F (light) / #5EEAD4 (dark) plus the amber tertiary seen in ZenMeter.
 *
 * Paper's MD3Colors has no `surfaceContainer*` roles (they arrived in M3 1.5), so the tonal
 * surface containers the guide uses for neutral cards are defined here as `theme.scanlist.surfaces`.
 */
import {configureFonts, MD3DarkTheme, MD3LightTheme} from 'react-native-paper';
import {FONT_FAMILY, HEAVY, Motion} from './tokens';

const lightColors = {
  ...MD3LightTheme.colors,
  primary: '#006B5F',
  onPrimary: '#FFFFFF',
  primaryContainer: '#9EF2E4',
  onPrimaryContainer: '#00201C',
  secondary: '#4A635F',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#CCE8E2',
  onSecondaryContainer: '#06201C',
  tertiary: '#8A5100',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#FFDCC0',
  onTertiaryContainer: '#2C1600',
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  background: '#FAFDFB',
  onBackground: '#191C1B',
  surface: '#FAFDFB',
  onSurface: '#191C1B',
  surfaceVariant: '#DAE5E1',
  onSurfaceVariant: '#3F4946',
  outline: '#6F7977',
  outlineVariant: '#BEC9C6',
  inverseSurface: '#2E3230',
  inverseOnSurface: '#EFF1EF',
  inversePrimary: '#82D5C8',
};

const darkColors = {
  ...MD3DarkTheme.colors,
  primary: '#5EEAD4',
  onPrimary: '#003731',
  primaryContainer: '#005046',
  onPrimaryContainer: '#9EF2E4',
  secondary: '#B1CCC6',
  onSecondary: '#1C3531',
  secondaryContainer: '#324B47',
  onSecondaryContainer: '#CCE8E2',
  tertiary: '#FFB86B',
  onTertiary: '#492900',
  tertiaryContainer: '#693C00',
  onTertiaryContainer: '#FFDCC0',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  background: '#0E1513',
  onBackground: '#DDE4E1',
  surface: '#0E1513',
  onSurface: '#DDE4E1',
  surfaceVariant: '#3F4946',
  onSurfaceVariant: '#BEC9C6',
  outline: '#899390',
  outlineVariant: '#3F4946',
  inverseSurface: '#DDE4E1',
  inverseOnSurface: '#2E3230',
  inversePrimary: '#006B5F',
};

/** M3 tonal surface containers (style guide §3: neutral idle/info cards). */
const lightSurfaces = {
  lowest: '#FFFFFF',
  low: '#F2F6F4',
  container: '#ECF1EF',
  high: '#E6ECE9',
  highest: '#DFE6E3',
};

const darkSurfaces = {
  lowest: '#090F0D',
  low: '#161E1B',
  container: '#1A2320',
  high: '#222B28',
  highest: '#2B3532',
};

export type ScanListSurfaces = typeof lightSurfaces;

/** Style guide §3 typography: Black (900) on every display/headline/title variant. */
const baseFonts = configureFonts({config: {fontFamily: FONT_FAMILY}});
const heavy = (font: (typeof baseFonts)['displayLarge']) => ({
  ...font,
  fontWeight: HEAVY,
});

const sharedFonts = {
  ...baseFonts,
  displayLarge: heavy(baseFonts.displayLarge),
  displayMedium: heavy(baseFonts.displayMedium),
  displaySmall: heavy(baseFonts.displaySmall),
  headlineLarge: heavy(baseFonts.headlineLarge),
  headlineMedium: heavy(baseFonts.headlineMedium),
  headlineSmall: heavy(baseFonts.headlineSmall),
  titleLarge: heavy(baseFonts.titleLarge),
};

export type ScanListTheme = typeof MD3LightTheme & {
  colors: typeof lightColors;
  scanlist: {
    surfaces: ScanListSurfaces;
    motion: typeof Motion;
  };
};

const withScanlist = (
  theme: typeof MD3LightTheme,
  colors: typeof lightColors,
  surfaces: ScanListSurfaces,
): ScanListTheme =>
  ({
    ...theme,
    colors,
    fonts: sharedFonts,
    scanlist: {surfaces, motion: Motion},
  }) as ScanListTheme;

export const lightTheme = withScanlist(
  MD3LightTheme,
  lightColors,
  lightSurfaces,
);

export const darkTheme = withScanlist(MD3DarkTheme, darkColors, darkSurfaces);
