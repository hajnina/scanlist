/**
 * Import card (card A2): a JSON file through the document picker, or JSON pasted into a dialog.
 *
 * Both paths end in the same place — `ListRepository.importText`, i.e. `@scanlist/ts-core`'s
 * `parseList` — so an import is either exactly the LIST.md shape (Ok) or pointered errors with no
 * partial import (LIST.md §5/§6). Nothing here parses JSON itself.
 *
 * The document picker returns a `content://` / `file://` URI; React Native's `fetch` + Blob can read
 * those directly (the documented pattern of the predecessor `react-native-document-picker`), which
 * keeps the card free of a filesystem dependency.
 */
import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {Button, Dialog, Portal, Text, TextInput, useTheme} from 'react-native-paper';
import {errorCodes, isErrorWithCode, pick} from '@react-native-documents/picker';
import {CapsLabel, haptic} from '../../ui';
import {HEAVY, MONO_FONT_FAMILY, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import type {Note} from './NoteCard';

type Props = {
  onText: (text: string) => Promise<boolean>;
  onNote: (note: Note | null) => void;
  disabled?: boolean;
};

/** Read a picked document as UTF-8 text (RN fetch handles `content://` and `file://` URIs). */
async function readDocumentText(uri: string): Promise<string> {
  const response = await fetch(uri);
  return response.text();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ImportCard({onText, onNote, disabled}: Props) {
  const theme = useTheme<ScanListTheme>();
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const submitPaste = async () => {
    setBusy(true);
    const ok = await onText(draft);
    setBusy(false);
    if (ok) {
      setDraft('');
      setPasting(false);
    }
  };

  const pickFile = async () => {
    try {
      const [file] = await pick({
        mode: 'import',
        // Some file managers label .json as octet-stream, so accept anything (B2 does the same).
        type: ['application/json', 'text/plain', 'application/octet-stream', '*/*'],
      });
      if (!file) {
        return;
      }
      if (file.error) {
        haptic('reject');
        onNote({
          kind: 'error',
          title: 'Could not read the file',
          lines: [file.error],
        });
        return;
      }
      const text = await readDocumentText(file.uri);
      await onText(text);
    } catch (error) {
      if (isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED) {
        return;
      }
      haptic('reject');
      onNote({
        kind: 'error',
        title: 'Import failed',
        lines: [errorText(error)],
      });
    }
  };

  return (
    <View
      style={[
        styles.card,
        {backgroundColor: theme.scanlist.surfaces.container},
      ]}>
      <CapsLabel>Import</CapsLabel>
      <Text variant="bodyMedium" style={{color: theme.colors.onSurfaceVariant}}>
        The nested JSON list format: title + sections, any depth.
      </Text>
      <View style={styles.actions}>
        <Button
          mode="contained"
          disabled={disabled || busy}
          onPress={() => {
            haptic('toggleOn');
            pickFile().catch(() => undefined);
          }}
          style={styles.action}>
          Pick a file
        </Button>
        <Button
          mode="outlined"
          disabled={disabled || busy}
          onPress={() => {
            haptic('toggleOn');
            onNote(null);
            setPasting(true);
          }}
          style={styles.action}>
          Paste JSON
        </Button>
      </View>

      <Portal>
        <Dialog onDismiss={() => setPasting(false)} visible={pasting}>
          <Dialog.Title style={styles.dialogTitle}>Paste a list</Dialog.Title>
          <Dialog.Content>
            <TextInput
              mode="outlined"
              multiline
              numberOfLines={8}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={'{"title": "Corner shop", "sections": [...]}'}
              value={draft}
              onChangeText={setDraft}
              style={styles.input}
              textAlignVertical="top"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPasting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onPress={submitPaste} disabled={busy || draft.trim() === ''}>
              Import
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 36,
    paddingHorizontal: Spacing.leafPadding,
    paddingVertical: Spacing.tilePaddingVertical,
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
  input: {
    minHeight: 140,
    fontFamily: MONO_FONT_FAMILY,
  },
  dialogTitle: {
    fontWeight: HEAVY,
  },
});
