/**
 * Lists screen (card A2) — the app's home: import (file or paste), stored lists, progress.
 *
 * Visual language copied from A1's `HomeSkeleton` (hero 44 dp card, alternating leaf cards, Black
 * display type, 14 dp round-capped progress bar, staggered spring entrance, haptics on every
 * action) so the replacement is invisible as a "new screen" — only the content changed from demo
 * numbers to the real imported lists.
 *
 * All parsing/validation/export lives in the tested logic layer (`../store`, `../encode`,
 * `@scanlist/ts-core`); this file owns layout + input only.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Button, Text, useTheme} from 'react-native-paper';
import {CapsLabel, ExpressiveCard, HeroNumeral, MachineText, SpringIn} from '../../ui';
import {haptic} from '../../ui';
import {HEAVY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {flatten} from '../core';
import {createListRepository} from '../asyncStorage';
import type {StoredList} from '../store';
import {ImportCard} from './ImportCard';
import {ListDetailScreen} from './ListDetailScreen';
import {NoteCard, type Note} from './NoteCard';
import {ProgressBar} from './ProgressBar';
import {TRACK_ALPHA, withAlpha} from './color';

export interface ListsScreenProps {
  /**
   * Opens the settings screen (card A6-followup). Optional: `App` owns the screen flag, and a bare
   * `<ListsScreen />` (tests, a future embed) simply shows no entry point.
   */
  onOpenSettings?: () => void;
}

export function ListsScreen({onOpenSettings}: ListsScreenProps = {}) {
  const theme = useTheme<ScanListTheme>();
  const repository = useMemo(() => createListRepository(), []);
  const [lists, setLists] = useState<StoredList[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    let alive = true;
    repository
      .loadAll()
      .then(loaded => {
        if (alive) {
          setLists(loaded);
        }
      })
      .catch(error => {
        if (alive) {
          setLists([]);
          setNote({
            kind: 'error',
            title: 'Could not read stored lists',
            lines: [error instanceof Error ? error.message : String(error)],
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [repository]);

  const stored = lists?.find(entry => entry.id === openId) ?? null;
  if (stored !== null) {
    return (
      <ListDetailScreen
        repository={repository}
        stored={stored}
        onBack={() => setOpenId(null)}
        onChanged={updated =>
          setLists(current =>
            current === null
              ? current
              : current.map(entry => (entry.id === updated.id ? updated : entry)),
          )
        }
      />
    );
  }

  const importText = async (text: string): Promise<boolean> => {
    const result = await repository.importText(text);
    if (!result.ok) {
      haptic('reject');
      setNote({
        kind: 'error',
        title: 'Not a valid list',
        message: 'Nothing was imported (LIST.md: Ok or Error, never a partial import).',
        lines: result.errors,
      });
      return false;
    }
    haptic('confirm');
    setLists(await repository.loadAll());
    setNote({
      kind: 'info',
      title: 'Imported',
      message: result.stored.list.title,
    });
    setOpenId(result.stored.id);
    return true;
  };

  const totals = (lists ?? []).reduce(
    (sum, entry) => {
      const flat = flatten(entry.list);
      return {
        total: sum.total + flat.length,
        done: sum.done + flat.filter(item => item.done).length,
      };
    },
    {total: 0, done: 0},
  );
  const left = totals.total - totals.done;
  const progress = totals.total === 0 ? 0 : totals.done / totals.total;
  const loading = lists === null;

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={[styles.safe, {backgroundColor: theme.colors.surface}]}>
      <ScrollView contentContainerStyle={styles.content}>
        <SpringIn index={0} style={styles.header}>
          <Text
            variant="displayMedium"
            style={{color: theme.colors.onSurface}}>
            Shopping list
          </Text>
          <Text
            variant="titleMedium"
            style={{color: theme.colors.onSurfaceVariant}}>
            Import, tick, export.
          </Text>
          {onOpenSettings !== undefined ? (
            // Card A6-followup: the one entry point to Settings. Text-only (the app has no icon
            // font dependency) and styled like the back button the other screens use.
            <Button
              onPress={onOpenSettings}
              compact
              style={styles.settings}
              labelStyle={styles.settingsLabel}
              accessibilityLabel="Settings"
              textColor={theme.colors.onSurfaceVariant}>
              Settings
            </Button>
          ) : null}
        </SpringIn>

        <SpringIn index={1}>
          <ExpressiveCard
            variant="hero"
            containerColor={
              totals.total > 0 && left === 0
                ? theme.colors.tertiaryContainer
                : theme.colors.primaryContainer
            }
            style={styles.hero}>
            <CapsLabel
              color={
                totals.total > 0 && left === 0
                  ? theme.colors.onTertiaryContainer
                  : theme.colors.onPrimaryContainer
              }>
              {totals.total === 0
                ? 'Nothing imported'
                : left === 0
                  ? 'All done'
                  : 'To go'}
            </CapsLabel>
            <HeroNumeral
              color={
                totals.total > 0 && left === 0
                  ? theme.colors.onTertiaryContainer
                  : theme.colors.onPrimaryContainer
              }>
              {String(left)}
            </HeroNumeral>
            <ProgressBar
              progress={progress}
              color={
                totals.total > 0 && left === 0
                  ? theme.colors.tertiary
                  : theme.colors.primary
              }
              trackColor={withAlpha(
                totals.total > 0 && left === 0
                  ? theme.colors.onTertiaryContainer
                  : theme.colors.onPrimaryContainer,
                TRACK_ALPHA,
              )}
            />
            <MachineText
              color={
                totals.total > 0 && left === 0
                  ? theme.colors.onTertiaryContainer
                  : theme.colors.onPrimaryContainer
              }>
              {totals.total === 0
                ? 'pick a .json file or paste one to start'
                : `${totals.done}/${totals.total} ticked · ${lists?.length ?? 0} list${
                    (lists?.length ?? 0) === 1 ? '' : 's'
                  }`}
            </MachineText>
          </ExpressiveCard>
        </SpringIn>

        <SpringIn index={2}>
          <ImportCard
            onText={importText}
            onNote={setNote}
            disabled={loading}
          />
        </SpringIn>

        {note !== null ? (
          <SpringIn index={3}>
            <NoteCard note={note} onDismiss={() => setNote(null)} />
          </SpringIn>
        ) : null}

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text
              variant="bodyMedium"
              style={{color: theme.colors.onSurfaceVariant}}>
              Reading stored lists…
            </Text>
          </View>
        ) : null}

        {!loading && lists !== null && lists.length === 0 ? (
          <SpringIn index={3}>
            <ExpressiveCard
              variant="leaf"
              containerColor={theme.scanlist.surfaces.high}
              style={styles.emptyCard}>
              <Text
                variant="headlineSmall"
                style={{color: theme.colors.onSurface}}>
                No lists yet
              </Text>
              <Text
                variant="bodyMedium"
                style={{color: theme.colors.onSurfaceVariant}}>
                A list is one nested JSON object: title + sections + items. Import one above
                and it stays here, ticked items included.
              </Text>
              <MachineText color={theme.colors.onSurfaceVariant}>
                {'{ "title": "Corner shop", "sections": [{ "name": "Tonight", "items": [{ "name": "Bread" }] }] }'}
              </MachineText>
            </ExpressiveCard>
          </SpringIn>
        ) : null}

        {lists !== null && lists.length > 0 ? (
          <CapsLabel style={styles.sectionLabel}>Lists</CapsLabel>
        ) : null}

        {(lists ?? []).map((entry, index) => {
          const flat = flatten(entry.list);
          const done = flat.filter(item => item.done).length;
          const entryLeft = flat.length - done;
          const entryProgress = flat.length === 0 ? 0 : done / flat.length;
          return (
            <SpringIn key={entry.id} index={4 + index}>
              <ExpressiveCard
                variant={index % 2 === 0 ? 'leaf' : 'leafMirror'}
                containerColor={
                  index % 2 === 0
                    ? theme.colors.secondaryContainer
                    : theme.scanlist.surfaces.high
                }
                accessibilityLabel={`Open ${entry.list.title}`}
                onPress={() => {
                  haptic('confirm');
                  setOpenId(entry.id);
                }}
                style={styles.listCard}>
                <Text
                  variant="headlineMedium"
                  style={{color: theme.colors.onSecondaryContainer}}>
                  {entry.list.title}
                </Text>
                <Text
                  variant="bodyMedium"
                  style={{
                    color:
                      index % 2 === 0
                        ? theme.colors.onSecondaryContainer
                        : theme.colors.onSurface,
                  }}>
                  {flat.length === 0
                    ? 'empty list'
                    : `${entryLeft} left · ${flat.length} items`}
                </Text>
                {flat.length > 0 ? (
                  <ProgressBar
                    progress={entryProgress}
                    color={
                      index % 2 === 0
                        ? theme.colors.secondary
                        : theme.colors.primary
                    }
                    trackColor={withAlpha(
                      index % 2 === 0
                        ? theme.colors.onSecondaryContainer
                        : theme.colors.onSurface,
                      TRACK_ALPHA,
                    )}
                  />
                ) : null}
                <MachineText
                  color={
                    index % 2 === 0
                      ? theme.colors.onSecondaryContainer
                      : theme.colors.onSurfaceVariant
                  }>
                  {entry.id}.json · JSON v{entry.list.version ?? 1}
                </MachineText>
              </ExpressiveCard>
            </SpringIn>
          );
        })}

        <SpringIn index={4 + (lists?.length ?? 0)}>
          <Text
            variant="bodySmall"
            style={[styles.footer, {color: theme.colors.onSurfaceVariant}]}>
            Lists are stored as the list format itself — export is the stored document.
          </Text>
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
    gap: 4,
  },
  settings: {
    alignSelf: 'flex-start',
    marginStart: -8,
  },
  settingsLabel: {
    fontWeight: HEAVY,
    letterSpacing: Spacing.labelTracking,
  },
  hero: {
    padding: Spacing.heroPadding,
  },
  emptyCard: {
    padding: Spacing.leafPadding,
    gap: 8,
  },
  sectionLabel: {
    paddingStart: 8,
    paddingTop: 4,
  },
  listCard: {
    padding: Spacing.leafPadding,
    gap: 2,
  },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.gap,
    paddingStart: 8,
  },
  footer: {
    paddingStart: 8,
    paddingBottom: 24,
  },
});
