/**
 * Hero card for the magic scan (card A5) — the one decision RANK.md §6 puts in ts-core.
 *
 * The card renders **exactly** `ScanTick.heroId` (`rank()`'s `topId`), never `entries[0]`: when the
 * evidence gate (§6.2) or the image accept-list guard (§6.3) closes, this component renders the
 * honest null state instead of inventing a winner. No margin or score threshold is computed here.
 *
 * Styling follows references/bonsai-ui/STYLE_GUIDE.md §3/§4: 44 dp hero container,
 * `primaryContainer`, Black display type, caps tracked label, and a full-width tick surface whose
 * corner morphs 28 → 64 dp with the spatial spring while the press dips to 0.96 with the fast
 * spatial spring (Bonsai Serve's kill-switch surface).
 */
import React, {useRef} from 'react';
import {Animated, Pressable, StyleSheet, View} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {CapsLabel, ExpressiveCard, HeroNumeral, MachineText} from '../../ui';
import {haptic} from '../../ui';
import {HEAVY, Motion, Shapes, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import type {FlattenedItem, RankEntry} from '@scanlist/ts-core';
import type {ScanTickReason} from './tick';

/** `2 kg` / `1 pack` / `—` for the hero subtitle (LIST.md §4 amount is number or text). */
export function itemAmountLabel(item: FlattenedItem): string {
  if (item.amount === null) {
    return item.unit ?? '';
  }
  const amount =
    typeof item.amount === 'number' ? String(item.amount) : item.amount;
  return item.unit === null ? amount : `${amount} ${item.unit}`;
}

/** Display-only rounding: RANK.md §5 allows 2 dp in the UI, never in comparisons. */
export function displayScore(entry: RankEntry): string {
  return entry.smoothed === null ? '—' : entry.smoothed.toFixed(2);
}

interface HeroProps {
  entry: RankEntry;
  item: FlattenedItem | undefined;
  barcodeText: string | null;
  alternatives: number;
  onTick: () => void;
}

export function HeroCard({
  entry,
  item,
  barcodeText,
  alternatives,
  onTick,
}: HeroProps) {
  const theme = useTheme<ScanListTheme>();
  const name = item?.name ?? entry.id;

  return (
    <ExpressiveCard
      variant="hero"
      containerColor={theme.colors.primaryContainer}
      accessibilityLabel={`Best match: ${name}`}
      style={styles.hero}>
      <View style={styles.heroHeader}>
        <CapsLabel color={theme.colors.onPrimaryContainer}>Best match</CapsLabel>
        <Text
          style={[styles.score, {color: theme.colors.onPrimaryContainer}]}>
          {displayScore(entry)}
        </Text>
      </View>

      <Text
        variant="displaySmall"
        numberOfLines={2}
        style={[styles.name, {color: theme.colors.onPrimaryContainer}]}>
        {name}
      </Text>

      <View style={styles.heroMeta}>
        {item !== undefined && item.pathText !== '' ? (
          <Text
            numberOfLines={1}
            style={[styles.path, {color: theme.colors.onPrimaryContainer}]}>
            {item.pathText}
          </Text>
        ) : null}
        {item !== undefined && itemAmountLabel(item) !== '' ? (
          <HeroNumeral size={28} color={theme.colors.onPrimaryContainer}>
            {itemAmountLabel(item)}
          </HeroNumeral>
        ) : null}
      </View>

      {barcodeText !== null ? (
        <MachineText color={theme.colors.onPrimaryContainer}>
          {`OFF: ${barcodeText}`}
        </MachineText>
      ) : null}

      <TickSurface onTick={onTick} label={name} />

      <Text
        style={[styles.alternatives, {color: theme.colors.onPrimaryContainer}]}>
        {alternatives === 0
          ? 'only match on the list'
          : `${alternatives} other item${alternatives === 1 ? '' : 's'} ranked below`}
      </Text>
    </ExpressiveCard>
  );
}

interface TickSurfaceProps {
  onTick: () => void;
  label: string;
}

/** Full-width tick surface: 28 ↔ 64 dp corner morph, scale 1 → 0.96, Confirm haptic. */
function TickSurface({onTick, label}: TickSurfaceProps) {
  const theme = useTheme<ScanListTheme>();
  const scale = useRef(new Animated.Value(1)).current;
  const radius = useRef(
    new Animated.Value(Shapes.scanIdle.borderRadius),
  ).current;

  const press = (down: boolean) => {
    Animated.spring(scale, {
      ...(down ? Motion.fastSpatial : Motion.spatial),
      toValue: down ? 0.96 : 1,
    }).start();
    Animated.spring(radius, {
      ...(down ? Motion.fastEffects : Motion.slowEffects),
      toValue: down ? Shapes.scanActive.borderRadius : Shapes.scanIdle.borderRadius,
    }).start();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Tick ${label}`}
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      onPress={() => {
        haptic('confirm');
        onTick();
      }}>
      <Animated.View
        style={[
          styles.tickSurface,
          {
            transform: [{scale}],
            borderRadius: radius,
            backgroundColor: theme.colors.primary,
          },
        ]}>
        <Text style={[styles.tickText, {color: theme.colors.onPrimary}]}>
          ✓ TICK IT
        </Text>
      </Animated.View>
    </Pressable>
  );
}

interface NullHeroProps {
  reason: ScanTickReason;
  /** Error text when `reason === 'embed-unavailable'`. */
  error: string | null;
  /** OFF text for the current barcode, when one was scanned but produced no query. */
  barcodeText: string | null;
}

/** The honest "no hero" states — the gate/guard said no, so no card invents a winner. */
export function NullHeroCard({reason, error, barcodeText}: NullHeroProps) {
  const theme = useTheme<ScanListTheme>();
  const copy = (() => {
    switch (reason) {
      case 'no-items':
        return {
          label: 'All done',
          state: 'Nothing left',
          body: 'Every item on this list is ticked. Untick one on the list screen to scan for it again.',
        };
      case 'no-signal':
        return {
          label: 'No signal',
          state: 'Point at a product',
          body:
            barcodeText !== null
              ? `This barcode has no Open Food Facts name, and no OCR line or frame query is pending.`
              : 'The camera has not produced a barcode, an OCR line or a frame query yet.',
        };
      case 'embed-unavailable':
        return {
          label: 'Model unavailable',
          state: 'Ranking paused',
          body:
            error ??
            'The embedder is not ready. The last ranked order is kept; scanning continues.',
        };
      case 'hero':
      default:
        return {
          label: 'No hero',
          state: 'Nothing confident yet',
          body:
            'The list is ranked, but the top match is not decisive enough to highlight ' +
            '(score floor, margin to the runner-up, or an image match without a barcode-confirmed name).',
        };
    }
  })();

  return (
    <ExpressiveCard
      variant="leaf"
      containerColor={theme.scanlist.surfaces.high}
      accessibilityLabel={copy.state}
      style={styles.nullHero}>
      <CapsLabel>{copy.label}</CapsLabel>
      <Text
        variant="headlineMedium"
        style={[styles.nullState, {color: theme.colors.onSurface}]}>
        {copy.state}
      </Text>
      <Text
        variant="bodyMedium"
        style={{color: theme.colors.onSurfaceVariant}}>
        {copy.body}
      </Text>
    </ExpressiveCard>
  );
}

const styles = StyleSheet.create({
  hero: {
    padding: Spacing.heroPadding,
    gap: 6,
  },
  heroHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  score: {
    fontFamily: 'monospace',
    fontSize: 13,
  },
  name: {
    lineHeight: 40,
  },
  heroMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.gap,
  },
  path: {
    fontWeight: HEAVY,
    fontSize: 13,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    flexShrink: 1,
  },
  tickSurface: {
    marginTop: Spacing.gap,
    paddingVertical: 22,
    alignItems: 'center',
    overflow: 'hidden',
  },
  tickText: {
    fontWeight: HEAVY,
    fontSize: 22,
    letterSpacing: 1.5,
  },
  alternatives: {
    fontSize: 12,
    opacity: 0.8,
    marginTop: 2,
  },
  nullHero: {
    padding: Spacing.leafPadding,
    gap: 6,
  },
  nullState: {
    lineHeight: 32,
  },
});
