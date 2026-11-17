/**
 * Label + machine value row (card A6) — the "DOC / QUERY / IMAGE" lines of the prefix card and the
 * per-path lines of the model card (B6's `PrefixLine` + `MonospaceLine` pair).
 *
 * The value is monospace and selectable: paths and prefixes are things a developer copies into
 * `adb push` or a bug report. Long unbroken strings shrink to one line rather than wrapping mid-name.
 */
import React from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {HEAVY, MONO_FONT_FAMILY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {CapsLabel} from './Typography';
import {Text, useTheme} from 'react-native-paper';

export interface FactRowProps {
  label: string;
  value: string;
  /** Machine values default to monospace; set false for prose. */
  mono?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function FactRow({
  label,
  value,
  mono = true,
  color,
  style,
}: FactRowProps) {
  const theme = useTheme<ScanListTheme>();
  return (
    <View style={[styles.row, style]}>
      <CapsLabel style={styles.label}>{label}</CapsLabel>
      <Text
        selectable
        numberOfLines={1}
        variant="bodySmall"
        style={[
          mono ? styles.mono : undefined,
          {color: color ?? theme.colors.onSurface},
        ]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {gap: 2},
  label: {
    fontWeight: HEAVY,
    letterSpacing: Spacing.tileLabelTracking,
  },
  mono: {
    fontFamily: MONO_FONT_FAMILY,
  },
});
