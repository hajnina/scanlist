/**
 * Ranked list rows (card A5) — RANK.md §6.4 order, flat, hero excluded (the hero card shows it).
 *
 * Rows are informational + a manual tick target: ranking never commits anything by itself (the
 * research digest's "auto-rank + manual-tick, never auto-commit"). Reordering is animated from the
 * screen with RN's `LayoutAnimation` spring preset, the closest core equivalent of the style
 * guide's spatial spring without another animation dependency.
 */
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {CapsLabel, ExpressiveCard, MachineText} from '../../ui';
import {Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import type {FlattenedItem, RankEntry} from '@scanlist/ts-core';
import {displayScore, itemAmountLabel} from './HeroCard';

interface Props {
  /** Unchecked entries in rank order, hero already removed. */
  entries: RankEntry[];
  itemsById: ReadonlyMap<string, FlattenedItem>;
  doneCount: number;
  onTick: (itemId: string) => void;
}

export function RankedRows({entries, itemsById, doneCount, onTick}: Props) {
  const theme = useTheme<ScanListTheme>();

  if (entries.length === 0 && doneCount === 0) {
    return null;
  }

  return (
    <View style={styles.block}>
      <CapsLabel style={styles.label}>
        {entries.length === 0
          ? 'Ranked'
          : `Ranked · ${entries.length} item${entries.length === 1 ? '' : 's'}`}
      </CapsLabel>

      {entries.map((entry, index) => {
        const item = itemsById.get(entry.id);
        const amount = item === undefined ? '' : itemAmountLabel(item);
        return (
          <ExpressiveCard
            key={entry.id}
            variant={index % 2 === 0 ? 'tileLeft' : 'tileRight'}
            containerColor={
              index % 2 === 0
                ? theme.colors.secondaryContainer
                : theme.scanlist.surfaces.container
            }
            accessibilityLabel={`Tick ${item?.name ?? entry.id}`}
            onPress={() => onTick(entry.id)}
            style={styles.row}>
            <View style={styles.rowCopy}>
              <Text
                numberOfLines={1}
                style={[styles.name, {color: theme.colors.onSurface}]}>
                {item?.name ?? entry.id}
              </Text>
              <MachineText color={theme.colors.onSurfaceVariant}>
                {[item?.pathText, amount].filter(Boolean).join(' · ') || 'top level'}
              </MachineText>
            </View>
            <Text
              style={[styles.score, {color: theme.colors.onSurfaceVariant}]}>
              {displayScore(entry)}
            </Text>
          </ExpressiveCard>
        );
      })}

      {doneCount > 0 ? (
        <MachineText style={styles.done}>
          {`${doneCount} ticked · collapsed into the done group`}
        </MachineText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: Spacing.gap / 2,
  },
  label: {
    paddingStart: 8,
    paddingTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.tilePaddingHorizontal,
    paddingVertical: Spacing.tilePaddingVertical,
    gap: Spacing.gap,
  },
  rowCopy: {
    flexShrink: 1,
    gap: 2,
  },
  name: {
    fontSize: 18,
    fontWeight: '900',
  },
  score: {
    fontFamily: 'monospace',
    fontSize: 13,
  },
  done: {
    paddingStart: 8,
    paddingTop: 4,
  },
});
