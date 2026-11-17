/**
 * Depth-first flattening, item ids and embedding text — FLATTEN.md §2–§5.
 *
 * The output is the normative `FlattenedItem[]` (no `vec` key); the S3 golden fixture compares it
 * byte for byte with the Python oracle (`shared/ref/scanlist_ref.py`). Traversal is iterative so a
 * deeply nested list cannot overflow the call stack.
 */

import { casefold } from "./casefold";
import { sha1Hex } from "./sha1";
import type { FlattenedItem, ScanList, ScanListSection } from "./types";

interface Frame {
  section: ScanListSection;
  path: string[];
}

/**
 * Flatten a validated list: own items first, then sub-sections, both in JSON order.
 * The caller normally validates with `parseList` first; the assumptions here are FLATTEN.md §6's.
 */
export function flatten(list: ScanList): FlattenedItem[] {
  const out: FlattenedItem[] = [];
  const usedIds = new Set<string>();

  // LIFO stack; children are pushed in reverse so they pop in JSON order.
  const stack: Frame[] = [];
  for (let i = list.sections.length - 1; i >= 0; i -= 1) {
    const section = list.sections[i] as ScanListSection;
    stack.push({ section, path: [section.name] });
  }

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const { section, path } = frame;
    const items = section.items ?? [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) continue;

      // FLATTEN.md §3.1: explicit ids are trimmed and used verbatim; blank means absent.
      const rawId = item.id;
      const explicitId =
        typeof rawId === "string" && rawId.trim() !== "" ? rawId.trim() : null;

      let base: string;
      if (explicitId !== null) {
        base = explicitId;
      } else {
        // FLATTEN.md §3.2: verbatim section names and item name (no trim/fold), local index.
        const key =
          (path.length > 0 ? `${path.join("/")}/` : "") + item.name + `#${index}`;
        base = `sha1:${sha1Hex(key)}`;
      }

      // FLATTEN.md §3.3: deterministic ~2, ~3, ... renaming in flatten order.
      let id = base;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${base}~${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);

      // FLATTEN.md §5: trim, drop empties, dedupe after NFC + Unicode full case folding — exactly
      // the oracle's `unicodedata.normalize("NFC", alias).casefold()` (`casefold.ts`).
      const aliases: string[] = [];
      const seenAliases = new Set<string>();
      for (const rawAlias of item.aliases ?? []) {
        const alias = typeof rawAlias === "string" ? rawAlias.trim() : "";
        const norm = casefold(alias.normalize("NFC"));
        if (alias !== "" && !seenAliases.has(norm)) {
          seenAliases.add(norm);
          aliases.push(alias);
        }
      }

      let amount = item.amount ?? null;
      if (typeof amount === "string" && amount.trim() === "") amount = null;

      out.push({
        id,
        name: item.name.trim(),
        amount,
        unit: item.unit?.trim() || null,
        note: item.note?.trim() || null,
        aliases,
        done: item.done ?? false,
        path: [...path],
        pathText: path.join(" > "),
        index,
        order: out.length,
      });
    }

    const children = section.sections ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i] as ScanListSection;
      stack.push({ section: child, path: [...path, child.name] });
    }
  }

  return out;
}

/**
 * Embedding text (FLATTEN.md §4): `name; aliases; section > path`, separators exactly `"; "`,
 * `", "` and `" > "`, trimmed once at the end. `note` is deliberately absent.
 *
 * Matches `shared/ref/scanlist_ref.py::doc_text` exactly (the golden fixture's docTexts). The
 * Python oracle does not additionally trim each path segment, so neither does this port; sample
 * section names are already clean and FLATTEN.md §4's `path' = trim(s)` is a no-op for them.
 */
export function docText(
  item: Pick<FlattenedItem, "name" | "aliases" | "path">,
): string {
  const parts: string[] = [item.name];
  if (item.aliases.length > 0) parts.push(item.aliases.join(", "));
  if (item.path.length > 0) parts.push(item.path.join(" > "));
  return parts.join("; ").trim();
}

/** Convenience: `docText` for every flattened item. */
export function docTexts(items: readonly FlattenedItem[]): string[] {
  return items.map((item) => docText(item));
}
