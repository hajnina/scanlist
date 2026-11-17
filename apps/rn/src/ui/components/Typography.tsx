/**
 * Typography helpers from the style guide (§3): all-caps tracked labels, Black display values
 * and monospace machine text. Wrapping them keeps screens free of ad-hoc styling.
 */
import React, {type PropsWithChildren} from 'react';
import {StyleProp, StyleSheet, type TextStyle} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {HEAVY, MONO_FONT_FAMILY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';

type TextProps = PropsWithChildren<{
  style?: StyleProp<TextStyle>;
  color?: string;
}>;

/** Section label inside a card: labelLarge, Black, letterSpacing 1.5, UPPERCASE. */
export function CapsLabel({children, style, color}: TextProps) {
  const theme = useTheme<ScanListTheme>();
  return (
    <Text
      variant="labelLarge"
      style={[
        styles.caps,
        {color: color ?? theme.colors.onSurfaceVariant},
        theme.fonts.labelLarge,
        style,
      ]}>
      {children}
    </Text>
  );
}

/** Hero state word: displaySmall, Black, UPPERCASE. */
export function BigState({children, style, color}: TextProps) {
  const theme = useTheme<ScanListTheme>();
  return (
    <Text
      variant="displaySmall"
      style={[styles.caps, {color: color ?? theme.colors.onSurface}, style]}>
      {children}
    </Text>
  );
}

/** Hero numeral (72.sp / 56.sp in the guide): displayLarge with an explicit fontSize. */
export function HeroNumeral({
  children,
  style,
  color,
  size = 56,
}: TextProps & {size?: number}) {
  const theme = useTheme<ScanListTheme>();
  return (
    <Text
      variant="displayLarge"
      style={[
        {fontSize: size, lineHeight: size * 1.05, color: color ?? theme.colors.onSurface},
        style,
      ]}>
      {children}
    </Text>
  );
}

/** Machine value (URL, key, id): monospace, smaller, onSurfaceVariant. */
export function MachineText({children, style, color}: TextProps) {
  const theme = useTheme<ScanListTheme>();
  return (
    <Text
      variant="bodySmall"
      style={[
        styles.mono,
        {color: color ?? theme.colors.onSurfaceVariant},
        style,
      ]}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  caps: {
    fontWeight: HEAVY,
    letterSpacing: Spacing.labelTracking,
  },
  mono: {
    fontFamily: MONO_FONT_FAMILY,
  },
});
