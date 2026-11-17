/**
 * Export card (card A2): the SAME JSON shape that was imported (LIST.md §7), ticked items included.
 *
 * - SHARE hands the document text to the system share sheet (`Share.share` from React Native core).
 * - COPY puts it on the clipboard (`@react-native-clipboard/clipboard`).
 * - The document shown/stored is `encodeList(list)` — the very string AsyncStorage holds, so what
 *   you export is byte-identical to what is persisted (B2's "one file per list that IS the export").
 *
 * "Save to a file" is deliberately absent: the document picker's `saveDocuments()` needs a source
 * URI on disk, and adding a filesystem module for it is out of this card's scope (see Notes).
 */
import React from 'react';
import {Share, StyleSheet, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {Button, Text, useTheme} from 'react-native-paper';
import {Shapes, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {CapsLabel, haptic} from '../../ui';
import {encodeList, fileNameFor} from '../encode';
import {storageKeyFor} from '../store';
import type {ScanList} from '../core';

type Props = {
  list: ScanList;
  listId: string;
  onNote: (message: string) => void;
};

export function ExportCard({list, listId, onNote}: Props) {
  const theme = useTheme<ScanListTheme>();
  const json = encodeList(list);
  const fileName = fileNameFor(list.title);

  const copy = () => {
    Clipboard.setString(json);
    haptic('confirm');
    onNote('Copied the JSON to the clipboard');
  };

  const share = () => {
    haptic('toggleOn');
    Share.share({message: json, title: fileName}).catch(() =>
      onNote('Sharing was cancelled'),
    );
  };

  return (
    <View style={[styles.card, {backgroundColor: theme.colors.secondaryContainer}]}>
      <CapsLabel color={theme.colors.onSecondaryContainer}>Export</CapsLabel>
      <Text
        variant="bodyMedium"
        style={{color: theme.colors.onSecondaryContainer}}>
        Same nested JSON with "done": true on ticked items — importable anywhere.
      </Text>
      <View style={styles.actions}>
        <Button
          mode="contained"
          onPress={share}
          style={styles.action}>
          Share
        </Button>
        <Button mode="outlined" onPress={copy} style={styles.action}>
          Copy
        </Button>
      </View>
      <Text
        variant="bodySmall"
        style={[styles.path, {color: theme.colors.onSecondaryContainer}]}>
        stored at {storageKeyFor(listId)} · {fileName}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    ...Shapes.leafMirror,
    paddingHorizontal: Spacing.leafPadding,
    paddingVertical: Spacing.leafPadding,
    gap: 8,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.gap,
    marginTop: 4,
  },
  action: {
    flex: 1,
  },
  path: {
    opacity: 0.7,
  },
});
