/**
 * Source chips (card A5) — "what is live" for the three A4 sources, styled per
 * references/bonsai-ui/STYLE_GUIDE.md §3: tonal containers, caps tracked labels, effects spring on
 * colour (never spatial — nothing moves).
 *
 * `barcode` | `ocr` | `image` light up while their source keeps firing and dim back on the effects
 * spring when it goes quiet. The barcode chip carries the sticky-mode state: the resolved OFF name
 * stays in the query pool for 60 s or until the hero is committed (see `pool.ts`).
 */
import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {CapsLabel} from '../../ui';
import {HEAVY, MONO_FONT_FAMILY, Motion, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';

/** A chip is "lit" for this long after its source last fired. */
export const CHIP_LIT_MS = 1_500;

export type ChipSource = 'barcode' | 'ocr' | 'image';

export interface ChipState {
  source: ChipSource;
  label: string;
  /** Second line: what fired (digits, line count, frame count). */
  value: string;
  /** Third line: extra (OFF product text, sticky state). */
  detail?: string;
  lit: boolean;
}

interface ChipProps {
  chip: ChipState;
  containerColor: string;
  activeColor: string;
  onColor: string;
  activeOnColor: string;
}

function Chip({
  chip,
  containerColor,
  activeColor,
  onColor,
  activeOnColor,
}: ChipProps) {
  const lit = useRef(new Animated.Value(chip.lit ? 1 : 0)).current;

  useEffect(() => {
    const animation = Animated.spring(lit, {
      ...Motion.fastEffects,
      toValue: chip.lit ? 1 : 0,
    });
    animation.start();
    return () => animation.stop();
  }, [chip.lit, lit]);

  const backgroundColor = lit.interpolate({
    inputRange: [0, 1],
    outputRange: [containerColor, activeColor],
  });

  return (
    <Animated.View style={[styles.chip, {backgroundColor}]}>
      <View style={styles.chipCopy}>
        <CapsLabel
          color={chip.lit ? activeOnColor : onColor}
          style={styles.chipLabel}>
          {chip.label}
        </CapsLabel>
        <Text
          numberOfLines={1}
          style={[styles.chipValue, {color: chip.lit ? activeOnColor : onColor}]}>
          {chip.value}
        </Text>
        {chip.detail !== undefined ? (
          <Text
            numberOfLines={1}
            style={[styles.chipDetail, {color: chip.lit ? activeOnColor : onColor}]}>
            {chip.detail}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

interface Props {
  chips: ChipState[];
}

/** The three chips in `[barcode, ocr, image]` order (the A4 `sources` order). */
export function SourceChips({chips}: Props) {
  const theme = useTheme<ScanListTheme>();
  const colors: Record<
    ChipSource,
    {idle: string; active: string; onIdle: string; onActive: string}
  > = {
    barcode: {
      idle: theme.scanlist.surfaces.high,
      active: theme.colors.primaryContainer,
      onIdle: theme.colors.onSurfaceVariant,
      onActive: theme.colors.onPrimaryContainer,
    },
    ocr: {
      idle: theme.scanlist.surfaces.high,
      active: theme.colors.secondaryContainer,
      onIdle: theme.colors.onSurfaceVariant,
      onActive: theme.colors.onSecondaryContainer,
    },
    image: {
      idle: theme.scanlist.surfaces.high,
      active: theme.colors.tertiaryContainer,
      onIdle: theme.colors.onSurfaceVariant,
      onActive: theme.colors.onTertiaryContainer,
    },
  };

  return (
    <View style={styles.row}>
      {chips.map(chip => {
        const scheme = colors[chip.source];
        return (
          <Chip
            key={chip.source}
            chip={chip}
            containerColor={scheme.idle}
            activeColor={scheme.active}
            onColor={scheme.onIdle}
            activeOnColor={scheme.onActive}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.gap / 2,
  },
  chip: {
    flex: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 64,
    justifyContent: 'center',
  },
  chipCopy: {
    gap: 2,
  },
  chipLabel: {
    fontSize: 10,
  },
  chipValue: {
    fontWeight: HEAVY,
    fontSize: 13,
  },
  chipDetail: {
    fontFamily: MONO_FONT_FAMILY,
    fontSize: 10,
  },
});
