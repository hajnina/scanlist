/**
 * Embedding self-test (card A3) — the "JS test screen prints backend + latency" of the card's Done-when.
 *
 * Calls `embedDocs` with three list items through the native `Embed` module (shared/android-embed) and
 * prints the backend the GPU → CPU ladder settled on, the vector dims, the latency, how much of it was
 * the model open, and the first components of the first vector.
 *
 * On a phone without the model bundle (the normal state until card B0/S6 pushes it) the native side
 * rejects with `E_MODEL_MISSING`; that is rendered as a card with the exact `scripts/model.sh push`
 * command, not as a crash. Nothing here runs in release builds — `DevEntry` opens it from the dev menu.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Modal, ScrollView, StyleSheet, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {ActivityIndicator, Button, Text, useTheme} from 'react-native-paper';
import {BigState, CapsLabel, ExpressiveCard, MachineText} from '../ui';
import {MONO_FONT_FAMILY, Spacing} from '../theme/tokens';
import type {ScanListTheme} from '../theme';
import {
  EmbedError,
  embedDocs,
  embedStatus,
  type EmbedBatch,
  type EmbedStatus,
} from '../../modules/embed';

/** Three items from a real shopping list: short, branded, and a food noun. */
export const SAMPLE_TEXTS = ['milk', 'Oat Milk 3.5%', 'sourdough bread'];

type RunState =
  | {kind: 'running'}
  | {kind: 'done'; batch: EmbedBatch; status: EmbedStatus | null}
  | {kind: 'error'; code: string; message: string; status: EmbedStatus | null};

interface Props {
  onClose: () => void;
}

export function EmbedSelfTestScreen({onClose}: Props) {
  const theme = useTheme<ScanListTheme>();
  const [run, setRun] = useState<RunState>({kind: 'running'});
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    setRun({kind: 'running'});
    // Never rejects: a binary without the module reports `linked: false` instead.
    const status = await embedStatus().catch(() => null);
    try {
      const batch = await embedDocs(SAMPLE_TEXTS);
      if (mounted.current) {
        setRun({kind: 'done', batch, status});
      }
    } catch (error) {
      const code = error instanceof EmbedError ? error.code : 'E_UNKNOWN';
      const message = error instanceof Error ? error.message : String(error);
      if (mounted.current) {
        setRun({kind: 'error', code, message, status});
      }
    }
  }, []);

  useEffect(() => {
    start();
  }, [start]);

  const backend = run.kind === 'done' ? run.batch.backend : 'none';
  const accent =
    run.kind === 'error' ? theme.colors.errorContainer : theme.colors.primaryContainer;
  const onAccent =
    run.kind === 'error' ? theme.colors.onErrorContainer : theme.colors.onPrimaryContainer;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView
        edges={['top', 'bottom']}
        style={[styles.safe, {backgroundColor: theme.colors.surface}]}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <CapsLabel>Embed self-test · card A3</CapsLabel>
            <Text variant="titleMedium" style={{color: theme.colors.onSurfaceVariant}}>
              shared/android-embed via the Embed TurboModule
            </Text>
          </View>

          <ExpressiveCard
            variant="hero"
            containerColor={accent}
            style={{padding: Spacing.heroPadding}}>
            <CapsLabel color={onAccent}>Backend</CapsLabel>
            <BigState color={onAccent}>{backend.toUpperCase()}</BigState>
            {run.kind === 'running' ? (
              <View style={styles.row}>
                <ActivityIndicator color={onAccent} />
                <MachineText color={onAccent}>
                  {`embedding ${SAMPLE_TEXTS.length} texts…`}
                </MachineText>
              </View>
            ) : run.kind === 'done' ? (
              <MachineText color={onAccent}>
                {`dims ${run.batch.dims} · ${Math.round(run.batch.latencyMs)} ms${
                  run.batch.openMs > 0
                    ? ` · model open ${Math.round(run.batch.openMs)} ms`
                    : ''
                }`}
              </MachineText>
            ) : (
              <MachineText color={onAccent}>{run.code}</MachineText>
            )}
          </ExpressiveCard>

          {run.kind === 'done' ? (
            <ExpressiveCard
              variant="leaf"
              containerColor={theme.scanlist.surfaces.container}
              style={{padding: Spacing.leafPadding}}>
              <CapsLabel>{`vector[0] of “${SAMPLE_TEXTS[0]}”`}</CapsLabel>
              <Text style={[styles.mono, {color: theme.colors.onSurface}]}>
                {formatComponents(run.batch.vectors[0])}
              </Text>
              <MachineText>
                {`${run.batch.vectors.length} vectors · ${
                  run.batch.vectors[0]?.length ?? 0
                } floats each`}
              </MachineText>
            </ExpressiveCard>
          ) : null}

          {run.kind === 'error' ? (
            <ExpressiveCard
              variant="leaf"
              containerColor={theme.colors.errorContainer}
              style={{padding: Spacing.leafPadding}}>
              <CapsLabel color={theme.colors.onErrorContainer}>{run.code}</CapsLabel>
              <Text
                variant="bodyMedium"
                style={{color: theme.colors.onErrorContainer, marginTop: Spacing.gap / 2}}>
                {run.message}
              </Text>
              {run.status?.hint ? (
                <Text
                  style={[
                    styles.mono,
                    {color: theme.colors.onErrorContainer, marginTop: Spacing.gap},
                  ]}>
                  {run.status.hint}
                </Text>
              ) : null}
            </ExpressiveCard>
          ) : null}

          {run.kind !== 'running' && run.status ? (
            <ExpressiveCard
              variant="leaf"
              containerColor={theme.scanlist.surfaces.high}
              style={{padding: Spacing.leafPadding}}>
              <CapsLabel>Engine</CapsLabel>
              <View style={styles.facts}>
                <Fact label="linked" value={String(run.status.linked)} />
                <Fact label="model" value={String(run.status.modelPresent)} />
                <Fact label="model id" value={run.status.modelId} />
                <Fact label="images" value={String(run.status.supportsImages)} />
                <Fact label="open" value={String(run.status.open)} />
                <Fact label="path" value={run.status.modelPath || '—'} />
              </View>
              <MachineText>{SAMPLE_TEXTS.join(' · ')}</MachineText>
            </ExpressiveCard>
          ) : null}

          <View style={styles.actions}>
            <Button mode="contained" onPress={start} disabled={run.kind === 'running'}>
              Run again
            </Button>
            <Button mode="text" onPress={onClose}>
              Close
            </Button>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Fact({label, value}: {label: string; value: string}) {
  const theme = useTheme<ScanListTheme>();
  return (
    <View style={styles.fact}>
      <Text variant="labelSmall" style={{color: theme.colors.onSurfaceVariant}}>
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.monoSmall, {color: theme.colors.onSurface}]}>
        {value}
      </Text>
    </View>
  );
}

/** `0.0342, -0.0118, …` — six components is enough to see that real numbers came back. */
export function formatComponents(vector: number[] | undefined, count = 6): string {
  if (!vector || vector.length === 0) {
    return '—';
  }
  return vector
    .slice(0, count)
    .map(value => value.toFixed(4))
    .join(', ');
}

const styles = StyleSheet.create({
  safe: {flex: 1},
  content: {
    paddingHorizontal: Spacing.screenHorizontal,
    paddingTop: Spacing.screenVertical,
    paddingBottom: Spacing.heroPadding,
    gap: Spacing.gap,
  },
  header: {gap: Spacing.gap / 2},
  row: {flexDirection: 'row', alignItems: 'center', gap: Spacing.gap},
  facts: {flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.gap},
  fact: {minWidth: '45%', gap: 2},
  actions: {flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.gap},
  mono: {fontFamily: MONO_FONT_FAMILY, fontSize: 14, marginTop: Spacing.gap / 2},
  monoSmall: {fontFamily: MONO_FONT_FAMILY, fontSize: 12},
});
