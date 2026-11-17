/**
 * A transient message card (card A2): import errors (LIST.md §5 pointered lines) and action feedback.
 *
 * Errors are shown verbatim in monospace — a rejected import names the RFC 6901 pointer, e.g.
 * `/sections/0/items/1/name: required`, and that is the most useful thing the screen can say.
 */
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {Button, Text, useTheme} from 'react-native-paper';
import {HEAVY, MONO_FONT_FAMILY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';

export interface Note {
  kind: 'info' | 'error';
  title: string;
  message?: string;
  /** Error lines, rendered one per row in monospace. */
  lines?: string[];
}

type Props = {
  note: Note;
  onDismiss: () => void;
};

export function NoteCard({note, onDismiss}: Props) {
  const theme = useTheme<ScanListTheme>();
  const error = note.kind === 'error';
  const container = error
    ? theme.colors.errorContainer
    : theme.colors.secondaryContainer;
  const content = error ? theme.colors.onErrorContainer : theme.colors.onSecondaryContainer;

  return (
    <View style={[styles.card, {backgroundColor: container}]}>
      <Text variant="titleMedium" style={[styles.title, {color: content}]}>
        {note.title}
      </Text>
      {note.message !== undefined ? (
        <Text variant="bodyMedium" style={{color: content}}>
          {note.message}
        </Text>
      ) : null}
      {(note.lines ?? []).map((line, index) => (
        <Text
          key={`${index}-${line}`}
          variant="bodySmall"
          style={[styles.line, {color: content}]}>
          {line}
        </Text>
      ))}
      <Button onPress={onDismiss} textColor={content} compact>
        Dismiss
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 28,
    paddingHorizontal: Spacing.leafPadding,
    paddingVertical: Spacing.tilePaddingVertical,
    gap: 4,
  },
  title: {
    fontWeight: HEAVY,
  },
  line: {
    fontFamily: MONO_FONT_FAMILY,
  },
});
