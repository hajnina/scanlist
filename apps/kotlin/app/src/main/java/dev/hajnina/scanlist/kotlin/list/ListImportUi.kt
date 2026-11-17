package dev.hajnina.scanlist.kotlin.list

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hajnina.scanlist.kotlin.Heavy
import dev.hajnina.scanlist.kotlin.Shapes

// Import/export affordances shared by the lists screen and the list screen. SAF needs no manifest
// permission (per-file grant); the share sheet carries the JSON as text (no FileProvider).

/** Two big acts: pick a .json file, or paste JSON. Also renders the paste + error dialogs. */
@Composable
fun ImportActions(state: ListState, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    var pasteOpen by remember { mutableStateOf(false) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            ListTransfer.read(context, uri)
                .onSuccess { text ->
                    if (state.import(text)) {
                        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    }
                }
                .onFailure { state.say("Could not read that file: ${it.message}") }
        }
    }

    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                picker.launch(ListTransfer.IMPORT_MIME_TYPES)
            },
            modifier = Modifier.weight(1f),
        ) {
            Text("IMPORT FILE", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp))
        }
        Button(
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.ToggleOn)
                pasteOpen = true
            },
            modifier = Modifier.weight(1f),
        ) {
            Text("PASTE JSON", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy, letterSpacing = 1.sp))
        }
    }

    if (pasteOpen) {
        PasteJsonDialog(
            onDismiss = { pasteOpen = false },
            onImport = { text ->
                pasteOpen = false
                if (state.import(text)) haptic.performHapticFeedback(HapticFeedbackType.Confirm)
            },
        )
    }

    if (state.errors.isNotEmpty()) {
        ErrorDialog(errors = state.errors, onDismiss = { state.clearErrors() })
    }
}

/** Paste box for a whole list document (LIST.md §6: paste import accepts exactly the JSON shape). */
@Composable
fun PasteJsonDialog(onDismiss: () -> Unit, onImport: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val cs = MaterialTheme.colorScheme
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Paste a list", style = MaterialTheme.typography.headlineSmall.copy(fontWeight = Heavy)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    """{"title": "Corner shop", "sections": [...]}""",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = cs.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp),
                    minLines = 6,
                    maxLines = 12,
                    label = { Text("JSON") },
                    textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onImport(text) }, enabled = text.isNotBlank()) {
                Text("IMPORT", style = MaterialTheme.typography.labelLarge.copy(fontWeight = Heavy))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("CANCEL") }
        },
    )
}

/** Import failures are named by JSON pointer (LIST.md §5); show them verbatim, never swallow them. */
@Composable
fun ErrorDialog(errors: List<String>, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                "Not a valid list",
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = Heavy),
            )
        },
        text = {
            Column(
                Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                errors.forEach { error ->
                    Text(
                        error,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("OK") }
        },
    )
}

/** One-line feedback (import/export result) as a tonal leaf card, dismissable. */
@Composable
fun NoteCard(text: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val haptic = LocalHapticFeedback.current
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = Shapes.leafMirror,
        colors = CardDefaults.cardColors(
            containerColor = cs.tertiaryContainer,
            contentColor = cs.onTertiaryContainer,
        ),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            // Card B7: every action gets a haptic (style guide §4) — dismissing a note included.
            TextButton(
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.ToggleOff)
                    onDismiss()
                },
            ) { Text("OK") }
        }
    }
}

/** 14 dp round-capped progress bar from STYLE_GUIDE.md §3 (no stop dot, no gap). */
@Composable
fun ListProgress(
    progress: Float,
    containerColor: androidx.compose.ui.graphics.Color,
    trackColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    androidx.compose.material3.LinearProgressIndicator(
        progress = { progress },
        modifier = modifier.fillMaxWidth().height(14.dp),
        color = containerColor,
        trackColor = trackColor,
        strokeCap = androidx.compose.ui.graphics.StrokeCap.Round,
        gapSize = 0.dp,
        drawStopIndicator = {},
    )
}
