/**
 * The magic Scan screen (card A5) — camera on top (~45 %), live ranked list below, hero card for
 * `rank()`'s `topId` with a big tick button, source chips, OFF lookup.
 *
 * Same UX as the Kotlin track's B5: auto-rank + **manual** tick (never auto-commit), Reanimated-class
 * springs from the project's token set (RN `Animated` physics — see `useScanSession`/`HeroCard`),
 * haptics from `src/ui/haptics`, and the hero/none decision entirely in `@scanlist/ts-core`.
 *
 * This file is deliberately thin (A4 precedent): camera + ML Kit + embedder glue only. Every
 * decision (pool order, OFF derivation/cache, EMA/hysteresis/gates, null hero) lives in the tested
 * modules `pool.ts`, `off.ts` and `tick.ts`.
 *
 * Wiring (outside this card's `owns`): mount it from the list detail screen with
 * `<ScanScreen repository={repository} stored={stored} onBack={…} onChanged={…} />` — same props as
 * `ListDetailScreen`. See the card Notes / README for the two-line recipe.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  BackHandler,
  LayoutAnimation,
  ScrollView,
  StyleSheet,
  UIManager,
  useWindowDimensions,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Button, Text, useTheme} from 'react-native-paper';
import {Camera} from 'react-native-vision-camera';
import {flatten, type FlattenedItem} from '@scanlist/ts-core';
import {
  CapsLabel,
  ExpressiveCard,
  GuidanceNote,
  MachineText,
  SpringIn,
  haptic,
} from '../../ui';
import {HEAVY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import type {ListRepository, StoredList} from '../../list/store';
import {quietFor, scanGuidance} from '../../settings/polish';
import {embedder} from '../../../modules/embed';
import {createFrameFeed} from '../sources';
import {useScanCamera} from '../sources/camera';
import {HeroCard, NullHeroCard} from './HeroCard';
import {RankedRows} from './RankedRows';
import {SourceChips, CHIP_LIT_MS, type ChipState} from './SourceChips';
import {createOffClient} from './offAsyncStorage';
import {ScanTickEngine} from './tick';
import {useScanSession} from './useScanSession';

interface Props {
  repository: ListRepository;
  stored: StoredList;
  onBack: () => void;
  onChanged: (stored: StoredList) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fraction of the window the camera preview takes (ARCHITECTURE.md: "top ~45 %"). */
export const CAMERA_HEIGHT_RATIO = 0.45;

export function ScanScreen({repository, stored, onBack, onChanged}: Props) {
  const theme = useTheme<ScanListTheme>();
  const {height: windowHeight} = useWindowDimensions();
  const [commitError, setCommitError] = useState<string | null>(null);

  const items = useMemo(() => flatten(stored.list), [stored.list]);
  const itemsById = useMemo(() => {
    const map = new Map<string, FlattenedItem>();
    items.forEach(item => map.set(item.id, item));
    return map;
  }, [items]);

  const off = useMemo(() => createOffClient(), []);
  const engine = useMemo(
    () => new ScanTickEngine({embedder, off}),
    [off],
  );
  useEffect(() => {
    engine.setItems(items);
  }, [engine, items]);

  const feed = useMemo(() => createFrameFeed(), []);
  const session = useScanSession(engine, feed);
  const [listAnimationReady, setListAnimationReady] = useState(false);

  const camera = useScanCamera({
    feed,
    active: true,
    onError: failure => setCommitError(messageOf(failure)),
  });

  // Springy reorder: RN's LayoutAnimation spring preset is the core equivalent of the style
  // guide's spatial spring (no animation dependency in this app).
  useEffect(() => {
    if (listAnimationReady) {
      return;
    }
    try {
      UIManager.setLayoutAnimationEnabledExperimental?.(true);
      setListAnimationReady(true);
    } catch {
      setListAnimationReady(true);
    }
  }, [listAnimationReady]);

  const {tick, activity} = session;
  useEffect(() => {
    if (tick !== null) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
    }
  }, [tick]);

  // Android hardware back returns to the list (A2 review nit / LIST.md navigation rule).
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        onBack();
        return true;
      },
    );
    return () => subscription.remove();
  }, [onBack]);

  const commit = useCallback(
    (itemId: string) => {
      setCommitError(null);
      repository
        .toggle(stored.id, itemId)
        .then(updated => {
          if (updated === null) {
            return;
          }
          // One tick ends sticky barcode mode (pool.ts); the next rank promotes whoever is next.
          engine.markCommitted();
          onChanged(updated);
          session.scheduleTick();
        })
        .catch(failure => setCommitError(messageOf(failure)));
    },
    [engine, onChanged, repository, session, stored.id],
  );

  const left = items.filter(item => !item.done).length;
  const heroEntry =
    tick === null
      ? undefined
      : tick.heroId === null
        ? undefined
        : tick.output.entries.find(entry => entry.id === tick.heroId);
  const rankedEntries =
    tick === null
      ? []
      : tick.output.entries.filter(
          entry =>
            !entry.done && (tick.heroId === null || entry.id !== tick.heroId),
        );
  const doneCount = items.filter(item => item.done).length;

  const now = tick?.at ?? Date.now();
  const chips: ChipState[] = [
    {
      source: 'barcode',
      label: 'Barcode',
      value: tick?.barcode?.digits ?? 'idle',
      detail:
        tick?.barcode === null || tick?.barcode === undefined
          ? 'no code in frame'
          : tick.barcode.text !== null
            ? tick.barcode.text
            : 'OFF has no name',
      lit: now - activity.barcode < CHIP_LIT_MS && activity.barcode > 0,
    },
    {
      source: 'ocr',
      label: 'OCR',
      value:
        tick === null || tick.ocrLines.length === 0
          ? 'idle'
          : `${tick.ocrLines.length} line${tick.ocrLines.length === 1 ? '' : 's'}`,
      detail:
        tick !== null && tick.ocrLines.length > 0
          ? (tick.ocrLines[0] as string)
          : 'one query per line',
      lit: now - activity.ocr < CHIP_LIT_MS && activity.ocr > 0,
    },
    {
      source: 'image',
      label: 'Image',
      value:
        tick === null || tick.imageQueries === 0
          ? 'idle'
          : `${tick.imageQueries} frame${tick.imageQueries === 1 ? '' : 's'}`,
      detail: '4 newest / 2 s',
      lit: now - activity.image < CHIP_LIT_MS && activity.image > 0,
    },
  ];

  const cameraHeight = Math.max(
    200,
    Math.min(360, Math.round(windowHeight * CAMERA_HEIGHT_RATIO)),
  );
  const error = commitError ?? session.error;
  const backend = embedder.backend;

  // Card A6 (POLISH.md): permission → missing model → quiet-for-6-s advice, in that order.
  const guidance = scanGuidance({
    hasPermission: camera.hasPermission,
    canRequestPermission: camera.canRequestPermission,
    quietMs: quietFor(activity, Date.now()),
  });
  const permissionCopy = guidance?.kind === 'camera' ? guidance : null;
  const hint = guidance !== null && guidance.kind !== 'camera' ? guidance : null;
  const counters = __DEV__ ? session.diagnostics() : null;

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={[styles.safe, {backgroundColor: theme.colors.surface}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <SpringIn index={0} style={styles.header}>
          <Button
            onPress={onBack}
            compact
            style={styles.back}
            labelStyle={styles.backLabel}
            textColor={theme.colors.onSurfaceVariant}>
            ‹ Lists
          </Button>
          <Text
            variant="displaySmall"
            style={{color: theme.colors.onSurface}}>
            Scan
          </Text>
          <Text
            variant="bodyMedium"
            style={{color: theme.colors.onSurfaceVariant}}>
            {`${stored.list.title} · ${left} left · point, then tick`}
          </Text>
        </SpringIn>

        <SpringIn index={1}>
          <View
            style={[
              styles.cameraFrame,
              {
                height: cameraHeight,
                backgroundColor: theme.scanlist.surfaces.highest,
              },
            ]}>
            {camera.hasPermission ? (
              <Camera {...camera.cameraProps} style={StyleSheet.absoluteFill} />
            ) : (
              <View style={styles.permission}>
                <CapsLabel color={theme.colors.onSurfaceVariant}>
                  Camera
                </CapsLabel>
                <Text
                  variant="titleMedium"
                  style={{color: theme.colors.onSurface}}>
                  {permissionCopy?.title ??
                    (camera.canRequestPermission
                      ? 'The magic scan needs the camera'
                      : 'Camera permission is blocked')}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{color: theme.colors.onSurfaceVariant}}>
                  {permissionCopy?.detail ??
                    (camera.canRequestPermission
                      ? 'Barcode, OCR and frame embedding all read the same preview.'
                      : 'Allow the camera in Android Settings, then return here.')}
                </Text>
                {camera.canRequestPermission ? (
                  <Button
                    mode="contained"
                    onPress={() => {
                      haptic('confirm');
                      camera.requestPermission().catch(() => undefined);
                    }}>
                    Allow camera
                  </Button>
                ) : null}
              </View>
            )}
            <View style={styles.previewBadge}>
              <CapsLabel color="#FFFFFF">
                {camera.hasPermission ? 'Scanning · 2.5 fps' : 'Camera off'}
              </CapsLabel>
            </View>
          </View>
        </SpringIn>

        <SpringIn index={2}>
          <SourceChips chips={chips} />
        </SpringIn>

        {hint !== null ? (
          <SpringIn index={2}>
            <GuidanceNote
              kind={hint.kind}
              title={hint.title}
              detail={hint.detail}
            />
          </SpringIn>
        ) : null}

        <SpringIn index={3}>
          {heroEntry !== undefined ? (
            <HeroCard
              entry={heroEntry}
              item={itemsById.get(heroEntry.id)}
              barcodeText={tick?.barcode?.text ?? null}
              alternatives={rankedEntries.length}
              onTick={() => commit(heroEntry.id)}
            />
          ) : (
            <NullHeroCard
              reason={tick?.reason ?? 'no-signal'}
              error={tick?.error ?? null}
              barcodeText={tick?.barcode?.text ?? null}
            />
          )}
        </SpringIn>

        {error !== null ? (
          <SpringIn index={4}>
            <ExpressiveCard
              variant="leaf"
              containerColor={theme.colors.errorContainer}
              style={styles.errorCard}>
              <CapsLabel color={theme.colors.onErrorContainer}>
                Scan error
              </CapsLabel>
              <Text
                variant="bodyMedium"
                style={{color: theme.colors.onErrorContainer}}>
                {error}
              </Text>
              <Button
                compact
                textColor={theme.colors.onErrorContainer}
                onPress={() => {
                  setCommitError(null);
                  session.dismissError();
                }}>
                Dismiss
              </Button>
            </ExpressiveCard>
          </SpringIn>
        ) : null}

        <SpringIn index={5}>
          <RankedRows
            entries={rankedEntries}
            itemsById={itemsById}
            doneCount={doneCount}
            onTick={commit}
          />
        </SpringIn>

        {counters !== null ? (
          <MachineText
            style={[styles.footer, {color: theme.colors.onSurfaceVariant}]}>
            {`debug · ${counters.listeners} feed listeners · ${counters.dropped} dropped while busy · ${counters.skipped} gated · ${counters.pendingReleases} temp files`}
          </MachineText>
        ) : null}

        {rankedEntries.length === 0 && doneCount === 0 ? null : (
          <MachineText
            style={[styles.footer, {color: theme.colors.onSurfaceVariant}]}>
            {`${rankedEntries.length} ranked · scores are EMA-smoothed similarity`}
          </MachineText>
        )}

        <SpringIn index={6}>
          <MachineText
            style={[styles.attribution, {color: theme.colors.onSurfaceVariant}]}>
            {`Product data: Open Food Facts (ODbL) · model ${backend} · 256-d`}
          </MachineText>
        </SpringIn>
      </ScrollView>
    </SafeAreaView>
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
    gap: 2,
  },
  back: {
    alignSelf: 'flex-start',
    marginStart: -8,
  },
  backLabel: {
    fontWeight: HEAVY,
    letterSpacing: Spacing.labelTracking,
  },
  cameraFrame: {
    borderRadius: 44,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  previewBadge: {
    position: 'absolute',
    top: 14,
    left: 16,
    backgroundColor: '#00000080',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  permission: {
    padding: Spacing.leafPadding,
    gap: 6,
    alignItems: 'flex-start',
  },
  errorCard: {
    padding: Spacing.leafPadding,
    gap: 6,
    alignItems: 'flex-start',
  },
  footer: {
    paddingStart: 8,
  },
  attribution: {
    paddingStart: 8,
    paddingBottom: 24,
  },
});
