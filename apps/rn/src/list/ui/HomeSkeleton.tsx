/**
 * Skeleton home screen (card A1). This is the *only* screen in the skeleton and it is static on
 * purpose: it proves the RN + Paper MD3 setup matches references/bonsai-ui/STYLE_GUIDE.md
 * (hero card 44 dp, leaf 16/52, diagonal tiles, Black type, spring entrance, haptics) and gives
 * later cards (A2 list import, A4 ranking, A5 scan UI) a screen to replace.
 */
import React from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Text, useTheme} from 'react-native-paper';
import {
  BigState,
  CapsLabel,
  ExpressiveCard,
  HeroNumeral,
  MachineText,
  ScanButton,
  SpringIn,
} from '../../ui';
import {MONO_FONT_FAMILY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';

/** Placeholder numbers until the list/scan cards land. */
const DEMO = {
  lists: 1,
  itemsLeft: 7,
  itemsDone: 3,
  model: 'embeddinggemma-2',
};

export function HomeSkeleton() {
  const theme = useTheme<ScanListTheme>();
  const total = DEMO.itemsLeft + DEMO.itemsDone;
  const progress = total === 0 ? 0 : DEMO.itemsDone / total;

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={[styles.safe, {backgroundColor: theme.colors.surface}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <SpringIn index={0} style={styles.header}>
          <Text variant="displayMedium" style={{color: theme.colors.onSurface}}>
            Shopping list
          </Text>
          <Text variant="titleMedium" style={{color: theme.colors.onSurfaceVariant}}>
            Bare React Native · new architecture · Paper MD3
          </Text>
        </SpringIn>

        <SpringIn index={1}>
          <ExpressiveCard
            variant="hero"
            containerColor={theme.colors.primaryContainer}
            style={{padding: Spacing.heroPadding}}>
            <CapsLabel color={theme.colors.onPrimaryContainer}>Magic scan</CapsLabel>
            <BigState color={theme.colors.onPrimaryContainer} style={styles.heroState}>
              Ready
            </BigState>
            <MachineText color={theme.colors.onPrimaryContainer}>
              camera → embeddinggemma 2 → ranked list
            </MachineText>
          </ExpressiveCard>
        </SpringIn>

        <SpringIn index={2}>
          <ExpressiveCard
            variant="leaf"
            containerColor={theme.colors.tertiaryContainer}
            style={{padding: Spacing.leafPadding}}>
            <CapsLabel color={theme.colors.onTertiaryContainer}>Lists</CapsLabel>
            <View style={styles.row}>
              <HeroNumeral color={theme.colors.onTertiaryContainer} size={56}>
                {String(DEMO.lists)}
              </HeroNumeral>
              <Text
                variant="bodyMedium"
                style={[styles.leafCopy, {color: theme.colors.onTertiaryContainer}]}>
                nested JSON list{DEMO.lists === 1 ? '' : 's'} ready to scan
              </Text>
            </View>
            <ProgressBar progress={progress} color={theme.colors.tertiary} />
            <MachineText color={theme.colors.onTertiaryContainer}>
              {DEMO.itemsDone}/{total} done · 1 section
            </MachineText>
          </ExpressiveCard>
        </SpringIn>

        <SpringIn index={3} style={styles.tileRow}>
          <ExpressiveCard
            variant="tileLeft"
            containerColor={theme.colors.secondaryContainer}
            style={[styles.tile, {padding: Spacing.tilePaddingHorizontal}]}>
            <CapsLabel color={theme.colors.onSecondaryContainer}>Items left</CapsLabel>
            <HeroNumeral color={theme.colors.onSecondaryContainer} size={40}>
              {String(DEMO.itemsLeft)}
            </HeroNumeral>
          </ExpressiveCard>
          <ExpressiveCard
            variant="tileRight"
            containerColor={theme.scanlist.surfaces.high}
            style={[styles.tile, {padding: Spacing.tilePaddingHorizontal}]}>
            <CapsLabel>Model</CapsLabel>
            <Text
              variant="titleMedium"
              numberOfLines={1}
              style={[styles.model, {color: theme.colors.onSurface}]}>
              {DEMO.model}
            </Text>
          </ExpressiveCard>
        </SpringIn>

        <SpringIn index={4}>
          <ScanButton
            title="Magic scan"
            description={'Point the camera at the shelf.\nThe matching item jumps to the top.'}
            onPress={() => {
              // Card A5 wires the camera + ranking; A1 only proves the look and the haptics.
            }}
          />
        </SpringIn>

        <SpringIn index={5}>
          <Text
            variant="bodySmall"
            style={[styles.footer, {color: theme.colors.onSurfaceVariant}]}>
            Card A1 skeleton — no list parsing, camera or embedding yet.
          </Text>
        </SpringIn>
      </ScrollView>
    </SafeAreaView>
  );
}

function ProgressBar({progress, color}: {progress: number; color: string}) {
  return (
    <View style={styles.trackSpaced}>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            {backgroundColor: color, width: `${Math.min(Math.max(progress, 0), 1) * 100}%`},
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1},
  content: {
    paddingHorizontal: Spacing.screenHorizontal,
    paddingVertical: Spacing.screenVertical,
    gap: Spacing.gap,
  },
  header: {
    paddingStart: 8,
    gap: 4,
  },
  heroState: {
    marginVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  leafCopy: {
    flexShrink: 1,
  },
  trackSpaced: {
    marginVertical: 10,
  },
  track: {
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.12)',
    marginVertical: 10,
  },
  fill: {
    height: 14,
    borderRadius: 7,
  },
  tileRow: {
    flexDirection: 'row',
    gap: Spacing.gap,
  },
  tile: {
    flex: 1,
    paddingVertical: Spacing.tilePaddingVertical,
  },
  model: {
    fontFamily: MONO_FONT_FAMILY,
  },
  footer: {
    paddingStart: 8,
    paddingBottom: 24,
  },
});
