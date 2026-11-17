/**
 * List detail (card A2): the imported nested list rendered exactly as written — section order,
 * item order, sub-sections to any depth (LIST.md §2) — with tick/untick, progress and export.
 *
 * This is the unranked view RANK.md §7 asks for when no scan is running; A4/A5 will layer the
 * "magic scan" highlight on top of it. Every row's id comes from `@scanlist/ts-core`'s flatten (see
 * `../view`), so ticking a row cannot hit the wrong item when names repeat.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {BackHandler, ScrollView, StyleSheet, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Button, Text, useTheme} from 'react-native-paper';
import {CapsLabel, ExpressiveCard, HeroNumeral, MachineText, SpringIn} from '../../ui';
import {HEAVY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {buildListTree, isEmptyList} from '../view';
import type {ItemNode} from '../view';
import type {ListRepository, StoredList} from '../store';
import {ExportCard} from './ExportCard';
import {NoteCard, type Note} from './NoteCard';
import {ProgressBar} from './ProgressBar';
import {SectionBlock} from './SectionBlock';
import {TRACK_ALPHA, withAlpha} from './color';

type Props = {
  repository: ListRepository;
  stored: StoredList;
  onBack: () => void;
  onChanged: (stored: StoredList) => void;
};

export function ListDetailScreen({repository, stored, onBack, onChanged}: Props) {
  const theme = useTheme<ScanListTheme>();
  const tree = useMemo(() => buildListTree(stored.list), [stored.list]);
  const [note, setNote] = useState<Note | null>(null);

  // Android hardware back returns to Lists (A2 review nit): without this, back from the
  // detail screen exits the app — the on-screen '‹ Lists' button was the only way back.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const left = tree.total - tree.done;
  const progress = tree.total === 0 ? 0 : tree.done / tree.total;
  const allDone = tree.total > 0 && left === 0;

  const toggle = (node: ItemNode) => {
    // The row already fired the Confirm/ToggleOff haptic; the repository only persists.
    repository
      .toggle(stored.id, node.flat.id)
      .then(updated => {
        if (updated !== null) {
          onChanged(updated);
        }
      })
      .catch(error =>
        setNote({
          kind: 'error',
          title: 'Could not save the tick',
          lines: [error instanceof Error ? error.message : String(error)],
        }),
      );
  };

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={[styles.safe, {backgroundColor: theme.colors.surface}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <SpringIn index={0}>
          <Button
            onPress={onBack}
            compact
            style={styles.back}
            labelStyle={styles.backLabel}
            textColor={theme.colors.onSurfaceVariant}>
            ‹ Lists
          </Button>
        </SpringIn>

        <SpringIn index={0} style={styles.header}>
          <Text
            variant="displaySmall"
            style={[styles.title, {color: theme.colors.onSurface}]}>
            {tree.title}
          </Text>
          <Text
            variant="bodyMedium"
            style={{color: theme.colors.onSurfaceVariant}}>
            {tree.total === 0
              ? 'Empty list'
              : `${left} left · ${tree.total} items · JSON v${tree.version}`}
          </Text>
        </SpringIn>

        <SpringIn index={1}>
          <ExpressiveCard
            variant="hero"
            containerColor={
              allDone ? theme.colors.tertiaryContainer : theme.colors.primaryContainer
            }
            style={styles.hero}>
            <CapsLabel
              color={
                allDone
                  ? theme.colors.onTertiaryContainer
                  : theme.colors.onPrimaryContainer
              }>
              {allDone ? 'Done' : 'To go'}
            </CapsLabel>
            <View style={styles.heroRow}>
              <HeroNumeral
                size={72}
                color={
                  allDone
                    ? theme.colors.onTertiaryContainer
                    : theme.colors.onPrimaryContainer
                }>
                {String(left)}
              </HeroNumeral>
              <Text
                variant="titleMedium"
                style={[styles.heroUnit, {
                  color: allDone
                    ? theme.colors.onTertiaryContainer
                    : theme.colors.onPrimaryContainer,
                }]}>
                items left
              </Text>
            </View>
            <ProgressBar
              progress={progress}
              color={allDone ? theme.colors.tertiary : theme.colors.primary}
              trackColor={withAlpha(
                allDone
                  ? theme.colors.onTertiaryContainer
                  : theme.colors.onPrimaryContainer,
                TRACK_ALPHA,
              )}
            />
          </ExpressiveCard>
        </SpringIn>

        {isEmptyList(tree) ? (
          <SpringIn index={2}>
            <ExpressiveCard
              variant="leaf"
              containerColor={theme.scanlist.surfaces.high}
              style={styles.emptyCard}>
              <Text
                variant="headlineSmall"
                style={[styles.title, {color: theme.colors.onSurface}]}>
                Nothing to buy
              </Text>
              <Text
                variant="bodyMedium"
                style={{color: theme.colors.onSurfaceVariant}}>
                {`"sections": [] is a valid list — import another file to fill it.`}
              </Text>
            </ExpressiveCard>
          </SpringIn>
        ) : null}

        {tree.sections.map((section, index) => (
          // Sibling sections may share a name (LIST.md:38) — include the index in the key.
          <SpringIn key={`${section.path.join('\u0000')}#${index}`} index={2 + index}>
            <SectionBlock section={section} depth={0} onToggle={toggle} />
          </SpringIn>
        ))}

        <SpringIn index={3 + tree.sections.length}>
          <ExportCard
            list={stored.list}
            listId={stored.id}
            onNote={message => setNote({kind: 'info', title: 'Exported', message})}
          />
        </SpringIn>

        {note !== null ? (
          <SpringIn index={4 + tree.sections.length}>
            <NoteCard note={note} onDismiss={() => setNote(null)} />
          </SpringIn>
        ) : null}

        <SpringIn index={5 + tree.sections.length}>
          <MachineText
            style={[styles.footer, {color: theme.colors.onSurfaceVariant}]}>
            {tree.total} items · ids from the shared ts-core flatten
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
  back: {
    alignSelf: 'flex-start',
    marginStart: -8,
  },
  backLabel: {
    fontWeight: HEAVY,
    letterSpacing: Spacing.labelTracking,
  },
  header: {
    paddingStart: 8,
    gap: 4,
  },
  title: {
    fontWeight: HEAVY,
  },
  hero: {
    padding: Spacing.heroPadding,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  heroUnit: {
    fontWeight: HEAVY,
    marginBottom: 14,
  },
  emptyCard: {
    padding: Spacing.leafPadding,
    gap: 8,
  },
  footer: {
    paddingStart: 8,
    paddingBottom: 24,
  },
});
