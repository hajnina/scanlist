/**
 * Single-select chip row (card A6) — the M3 Expressive `FilterChip` row from B6's settings screen.
 *
 * Paper's `Chip` already renders the tonal, rounded, pressable M3 surface; this wrapper only adds
 * the app's rule for the experimental option ("NPU · experimental") and keeps the accessible name
 * stable (`"NPU"`, not the suffix) so screen readers and tests address the same option.
 */
import React from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {Chip} from 'react-native-paper';
import {HEAVY, Spacing} from '../../theme/tokens';

export interface ChoiceOption {
  id: string;
  label: string;
  /** Appends "· experimental" to the visible label (and never to the accessible name). */
  experimental?: boolean;
}

export interface ChoiceChipsProps {
  options: readonly ChoiceOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  style?: StyleProp<ViewStyle>;
}

export function ChoiceChips({
  options,
  selectedId,
  onSelect,
  style,
}: ChoiceChipsProps) {
  return (
    <View style={[styles.row, style]}>
      {options.map(option => {
        const selected = option.id === selectedId;
        return (
          <Chip
            key={option.id}
            selected={selected}
            // The design uses the tonal fill alone; the check glyph needs a vector icon font this
            // app does not ship (and its entrance animation leaks a timer into tests).
            showSelectedCheck={false}
            mode={selected ? 'flat' : 'outlined'}
            accessibilityLabel={option.label}
            onPress={() => onSelect(option.id)}
            style={styles.chip}
            textStyle={styles.chipText}>
            {option.experimental
              ? `${option.label} · experimental`
              : option.label}
          </Chip>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  chip: {borderRadius: 12},
  chipText: {
    fontWeight: HEAVY,
    letterSpacing: Spacing.tileLabelTracking,
  },
});
