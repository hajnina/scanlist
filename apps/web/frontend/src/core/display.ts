/**
 * LIST.md §4 rendering: `amountText` / `displayText` / note.
 *
 * The amount union is never coerced (LIST.md §3): numbers keep JSON number formatting,
 * strings are free text. ts-core flattens/validates and exports `amount` as `number | string | null`,
 * but it deliberately does not own display strings, so they live here and are unit-tested against
 * the LIST.md §4 examples.
 *
 * Source for the number rule: apps/kotlin/.../list/ListModel.kt::formatJsonNumber (card B2).
 */

import type { ScanListAmount } from "@scanlist/ts-core";

/** Shortest round-trip decimal in JSON style: "6" not "6.0", "0.5", no exponent in [1e-6, 1e15). */
export function formatJsonNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0"; // also normalises -0
  const abs = Math.abs(value);
  // Outside the plain range JS's own toString already is the shortest form (exponent included).
  if (abs < 1e-6 || abs >= 1e15) return String(value);
  if (Number.isInteger(value)) return value.toFixed(0);
  // JS's shortest round-trip string never carries trailing zeros ("1.50" -> "1.5").
  return String(value);
}

/** Minimal shape both `ScanListItem` and `FlattenedItem` satisfy. */
export interface AmountFields {
  amount?: ScanListAmount | null;
}

/** `amountText`: "" when absent, number formatted, string trimmed (parseList already trims imports). */
export function amountText(item: AmountFields): string {
  const amount = item.amount;
  if (amount === undefined || amount === null) return "";
  if (typeof amount === "number") return formatJsonNumber(amount);
  return amount.trim();
}

/** `displayText`: amount + unit, the unit only when there is an amount (LIST.md §4). */
export function displayText(item: AmountFields & { unit?: string | null }): string {
  const amount = amountText(item);
  const unit = (item.unit ?? "").trim();
  if (amount !== "" && unit !== "") return `${amount} ${unit}`;
  return amount;
}

/** Item name as shown (trimmed); ids still derive from the verbatim name (FLATTEN.md §3.2). */
export function displayName(item: { name: string }): string {
  return item.name.trim();
}

/** Notes render in their own row and are never part of `displayText` (LIST.md §4). */
export function displayNote(item: { note?: string | null }): string | null {
  const note = (item.note ?? "").trim();
  return note === "" ? null : note;
}
