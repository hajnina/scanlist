/**
 * One-line "here is what to do next" card (card A6 / POLISH.md): camera permission, missing model,
 * nothing-in-frame / low light.
 *
 * The copy and its priority come from `src/settings/polish.ts` (`scanGuidance`); this component only
 * picks the tonal container the style guide assigns to each meaning (§3 "Colour usage"):
 * tertiary for an instruction, error for something broken. It is deliberately non-interactive — the
 * scan screen keeps the action button next to it, so a hint never swallows a tap.
 */
import React from 'react';
import {StyleSheet, type StyleProp, type ViewStyle} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {ExpressiveCard} from './ExpressiveCard';
import {CapsLabel} from './Typography';

/** Same three kinds as `scanGuidance`; kept structural so the UI kit imports no settings code. */
export type GuidanceTone = 'camera' | 'model' | 'light';

export interface GuidanceNoteProps {
  kind: GuidanceTone;
  title: string;
  detail: string;
  style?: StyleProp<ViewStyle>;
}

const LABELS: Record<GuidanceTone, string> = {
  camera: 'Camera',
  model: 'Model',
  light: 'Tip',
};

const GLYPHS: Record<GuidanceTone, string> = {
  camera: '◉',
  model: '⚠',
  light: '☀',
};

export function GuidanceNote({
  kind,
  title,
  detail,
  style,
}: GuidanceNoteProps) {
  const theme = useTheme<ScanListTheme>();
  const broken = kind === 'model';
  const container = broken
    ? theme.colors.errorContainer
    : theme.colors.tertiaryContainer;
  const content = broken
    ? theme.colors.onErrorContainer
    : theme.colors.onTertiaryContainer;

  return (
    <ExpressiveCard
      variant="leaf"
      containerColor={container}
      style={[styles.card, style]}>
      <CapsLabel color={content}>
        {`${GLYPHS[kind]} ${LABELS[kind]}`}
      </CapsLabel>
      <Text variant="titleMedium" style={{color: content}}>
        {title}
      </Text>
      <Text variant="bodySmall" style={{color: content}}>
        {detail}
      </Text>
    </ExpressiveCard>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.leafPadding,
    gap: 6,
  },
});
