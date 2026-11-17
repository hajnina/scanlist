/**
 * Settings (card A6) — the RN twin of B6's `SettingsScreen.kt`.
 *
 * Five cards in the Kotlin screen's order: backend picker, live embed latency, the model bundle,
 * the prefix set, and the Haptics switch (RN's own preference; the Kotlin track keeps haptics
 * always-on). Style: M3 Expressive by hand — leaf/hero shapes, Black caps labels, a hero numeral for
 * the measured mean, tonal containers that recolour on state (STYLE_GUIDE.md §3/§4).
 *
 * Thin by design (A4/A5 precedent): every decision lives in `backend.ts`, `latency.ts`,
 * `modelStatus.ts`, `prefix.ts`, `store.ts` and `state.ts` and is unit-tested. This file only lays
 * the snapshot out and routes taps to the controller.
 *
 * Mounting (`App.tsx` is outside this card's `owns`): pass one controller and a back handler —
 *
 *   const settings = useMemo(() => createNativeSettingsController(), []);
 *   <SettingsScreen controller={settings} onBack={() => setScreen('list')} />
 *
 * or omit `controller` and the screen builds the device one itself.
 */
import React, {useMemo} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Button,
  Switch,
  Text,
  useTheme,
} from 'react-native-paper';
import {
  BACKEND_OPTIONS,
  backendSummary,
  parseBackendChoice,
  type BackendChoice,
} from './backend';
import {
  formatMean,
  formatMillis,
  latencyHeadline,
  meanMillis,
  supportsLine,
  type LatencyReport,
} from './latency';
import {
  EXPECTED_MODEL_BYTES,
  modelStatusLine,
  pushHint,
  sha256Label,
  sizeNote,
} from './modelStatus';
import {
  docPrefixLine,
  imagePrefixLine,
  prefixSummary,
  queryPrefixLine,
} from './prefix';
import {createNativeSettingsController} from './device';
import type {SettingsController, SettingsSnapshot} from './state';
import {useSettings} from './useSettings';
import {
  CapsLabel,
  ChoiceChips,
  ExpressiveCard,
  FactRow,
  HeroNumeral,
  MachineText,
  SpringIn,
} from '../ui';
import {HEAVY, Spacing} from '../theme/tokens';
import type {ScanListTheme} from '../theme';

export interface SettingsScreenProps {
  onBack?: () => void;
  /** Omit to build the device controller (`device.ts`) — the app's usual path. */
  controller?: SettingsController;
}

export function SettingsScreen({onBack, controller}: SettingsScreenProps) {
  // `useMemo` keeps the device controller stable across re-renders (and StrictMode double renders).
  const fallback = useMemo(
    () => (controller === undefined ? createNativeSettingsController() : null),
    [controller],
  );
  const ctl = controller ?? fallback!;
  const {snapshot, select, rerun, setHaptics, activeBackend} = useSettings(ctl);
  const theme = useTheme<ScanListTheme>();

  const model = snapshot.model;
  const ready = model !== null && model.kind === 'present';
  const modelColor =
    model === null
      ? theme.colors.onSurfaceVariant
      : ready && model.bytes === EXPECTED_MODEL_BYTES
        ? theme.colors.primary
        : model.kind === 'present'
          ? theme.colors.tertiary
          : theme.colors.error;

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={[styles.safe, {backgroundColor: theme.colors.surface}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <SpringIn index={0} style={styles.header}>
          {onBack !== undefined ? (
            <Button
              onPress={onBack}
              compact
              style={styles.back}
              labelStyle={styles.backLabel}
              accessibilityLabel="Back"
              textColor={theme.colors.onSurfaceVariant}>
              ‹ Back
            </Button>
          ) : null}
          <Text
            variant="displaySmall"
            style={{color: theme.colors.onSurface}}>
            Settings
          </Text>
          <Text
            variant="bodyMedium"
            style={{color: theme.colors.onSurfaceVariant}}>
            Backends, model, scanner.
          </Text>
        </SpringIn>

        {/* ---- backend picker ------------------------------------------------ */}
        <SpringIn index={1}>
          <ExpressiveCard variant="leaf" style={styles.card}>
            <CapsLabel>Embedding backend</CapsLabel>
            <ChoiceChips
              options={BACKEND_OPTIONS.map(option => ({
                id: option.id,
                label: option.label,
                experimental: option.experimental,
              }))}
              selectedId={snapshot.choice}
              onSelect={id => select(parseBackendChoice(id))}
            />
            <Text
              variant="bodyMedium"
              style={{color: theme.colors.onSurfaceVariant}}>
              {backendSummary(snapshot.choice, activeBackend())}
            </Text>
            {snapshot.choice === 'npu' ? (
              <Text
                variant="bodySmall"
                style={{color: theme.colors.onSurfaceVariant}}>
                NPU is experimental: the SM8750 bundle fails on LiteRT-LM
                0.18.1/0.19.1 and an uncompiled one JIT-compiles for 140–236 s
                on open (RECIPE.md §7). Auto never tries it.
              </Text>
            ) : null}
          </ExpressiveCard>
        </SpringIn>

        {/* ---- live embed latency ------------------------------------------- */}
        <SpringIn index={2}>
          <LatencyCard
            phase={snapshot.phase}
            result={snapshot.result}
            choice={snapshot.choice}
            onRerun={rerun}
          />
        </SpringIn>

        {/* ---- model bundle -------------------------------------------------- */}
        <SpringIn index={3}>
          <ExpressiveCard variant="leafMirror" style={styles.card}>
            <CapsLabel>Model</CapsLabel>
            <Text
              variant="titleLarge"
              style={[styles.heavy, {color: theme.colors.onSurface}]}>
              EmbeddingGemma 2 · 740M
            </Text>
            <Text
              variant="bodyMedium"
              style={{color: theme.colors.onSurfaceVariant}}>
              Text + image in one 768-d space, Matryoshka to 256.
            </Text>
            <FactRow
              label="File"
              value={model?.path ?? 'probing…'}
              color={theme.colors.onSurfaceVariant}
            />
            <Text variant="bodyMedium" style={{color: modelColor}}>
              {model === null ? 'Probing the bundle…' : modelStatusLine(model)}
            </Text>
            {model !== null && model.kind === 'present' ? (
              <Text
                variant="bodySmall"
                style={{color: theme.colors.onSurfaceVariant}}>
                {sizeNote(model.bytes)}
              </Text>
            ) : null}
            <FactRow
              label="sha256 (expected)"
              value={sha256Label()}
              color={theme.colors.onSurfaceVariant}
            />
            {ready ? null : (
              <Text
                variant="bodySmall"
                style={{color: theme.colors.onSurfaceVariant}}>
                {pushHint(snapshot.modelHint)}
              </Text>
            )}
            {snapshot.error !== null ? (
              <Text variant="bodySmall" style={{color: theme.colors.error}}>
                {snapshot.error}
              </Text>
            ) : null}
          </ExpressiveCard>
        </SpringIn>

        {/* ---- prefix set ---------------------------------------------------- */}
        <SpringIn index={4}>
          <ExpressiveCard variant="leaf" style={styles.card}>
            <CapsLabel>Prefix set</CapsLabel>
            {snapshot.prefixes === null ? (
              <>
                <Text
                  variant="bodyMedium"
                  style={{color: theme.colors.onSurfaceVariant}}>
                  prefix set unavailable — this build (or the native module)
                  did not report the bundled prompts.json, so the engine’s own
                  set is in use.
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.monoTitle, {color: theme.colors.onSurface}]}>
                  {prefixSummary(snapshot.prefixes)}
                </Text>
                <FactRow
                  label="Doc"
                  value={docPrefixLine(snapshot.prefixes)}
                />
                <FactRow
                  label="Query"
                  value={queryPrefixLine(snapshot.prefixes)}
                />
                <FactRow
                  label="Image"
                  value={imagePrefixLine(snapshot.prefixes)}
                />
                <Text
                  variant="bodySmall"
                  style={{color: theme.colors.onSurfaceVariant}}>
                  Read from the bundled prompts.json at runtime — never
                  hard-coded.
                </Text>
              </>
            )}
          </ExpressiveCard>
        </SpringIn>

        {/* ---- haptics ------------------------------------------------------- */}
        <SpringIn index={5}>
          <ExpressiveCard variant="leafMirror" style={styles.card}>
            <View style={styles.toggleRow}>
              <View style={styles.toggleText}>
                <Text
                  variant="headlineSmall"
                  style={[styles.heavy, {color: theme.colors.onSurface}]}>
                  Haptics
                </Text>
                <Text
                  variant="bodyMedium"
                  style={{color: theme.colors.onSurfaceVariant}}>
                  {snapshot.haptics
                    ? 'Confirm / toggle / reject ticks on every action'
                    : 'Silent: no vibration on scan, tick or settings'}
                </Text>
              </View>
              <Switch
                accessibilityLabel="Haptics"
                value={snapshot.haptics}
                onValueChange={setHaptics}
              />
            </View>
          </ExpressiveCard>
        </SpringIn>

        <SpringIn index={6}>
          <View style={styles.about}>
            <CapsLabel>About</CapsLabel>
            <MachineText>
              dev.hajnina.scanlist.rn · RN track · settings (card A6)
            </MachineText>
            <MachineText>
              Checklist: apps/rn/docs/POLISH.md · embedded engine: shared/android-embed
            </MachineText>
          </View>
        </SpringIn>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- latency card

interface LatencyCardProps {
  phase: SettingsSnapshot['phase'];
  result: SettingsSnapshot['result'];
  choice: BackendChoice;
  onRerun: () => void;
}

function LatencyCard({phase, result, choice, onRerun}: LatencyCardProps) {
  const theme = useTheme<ScanListTheme>();
  const failed = result !== null && !result.ok;
  const container = failed
    ? theme.colors.errorContainer
    : theme.colors.primaryContainer;
  const content = failed
    ? theme.colors.onErrorContainer
    : theme.colors.onPrimaryContainer;

  return (
    <ExpressiveCard
      variant="hero"
      containerColor={container}
      style={styles.hero}>
      <CapsLabel color={content}>Embed latency</CapsLabel>

      {phase === 'running' ? (
        <View style={styles.running}>
          <ActivityIndicator size="small" color={content} />
          <Text variant="bodyLarge" style={{color: content}}>
            {`Opening ${choice} and embedding samples…`}
          </Text>
        </View>
      ) : result !== null && result.ok ? (
        <ReportBody report={result.report} content={content} />
      ) : result !== null ? (
        <>
          <Text style={[styles.monoTitle, {color: content}]}>
            {result.code}
          </Text>
          <Text variant="bodyMedium" style={{color: content}}>
            {result.message}
          </Text>
          {(result.reasons ?? []).map(reason => (
            <Text
              key={reason}
              variant="bodySmall"
              style={[styles.mono, {color: content}]}>
              {reason}
            </Text>
          ))}
        </>
      ) : (
        <Text variant="bodyLarge" style={{color: content}}>
          No measurement yet — pick a backend above.
        </Text>
      )}

      {phase === 'running' ? null : (
        <Button
          compact
          textColor={content}
          style={styles.again}
          onPress={onRerun}>
          TEST AGAIN
        </Button>
      )}
    </ExpressiveCard>
  );
}

function ReportBody({
  report,
  content,
}: {
  report: LatencyReport;
  content: string;
}) {
  return (
    <>
      <HeroNumeral style={[styles.mono, {color: content}]}>
        {formatMean(meanMillis(report))}
      </HeroNumeral>
      <Text variant="bodyMedium" style={{color: content}}>
        {latencyHeadline(report)}
      </Text>
      {report.samples.map(sample => (
        <View key={sample.text} style={styles.sampleRow}>
          <Text
            variant="bodyMedium"
            numberOfLines={1}
            style={[styles.sampleText, {color: content}]}>
            {sample.text}
          </Text>
          <Text
            variant="titleMedium"
            style={[styles.heavy, styles.mono, {color: content}]}>
            {formatMillis(sample.millis)}
          </Text>
        </View>
      ))}
      <FactRow
        label="Engine"
        value={`load ${formatMillis(report.loadMillis)} · warm-up call excluded from the mean`}
        mono={false}
        color={content}
      />
      <FactRow label="Bundle" value={supportsLine(report)} color={content} />
      <FactRow label="Dims" value={String(report.dims)} color={content} />
    </>
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
  card: {
    padding: Spacing.leafPadding,
    gap: 8,
  },
  hero: {
    padding: Spacing.heroPadding,
    gap: 8,
  },
  heavy: {fontWeight: HEAVY},
  mono: {fontFamily: 'monospace'},
  monoTitle: {
    fontFamily: 'monospace',
    fontWeight: HEAVY,
    fontSize: 20,
  },
  running: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  again: {
    alignSelf: 'flex-start',
    marginStart: -8,
  },
  sampleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sampleText: {flex: 1},
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  toggleText: {flex: 1, gap: 4},
  about: {
    paddingStart: 8,
    paddingBottom: 24,
    gap: 2,
  },
});
