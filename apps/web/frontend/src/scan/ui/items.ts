/**
 * Item identity bridge (card C5).
 *
 * The ranker speaks `FlattenedItem.id`, while C2's commit path (`app.tsx::toggleItem`) mutates the
 * **original nested `ScanListItem`** object (`done` is the only mutable per-item field, LIST.md §3).
 * A `FlattenedItem` is a copy, so ticking the copy would persist nothing.
 *
 * `flatten()` derives ids (explicit or sha1) and flatten order, and exports no back-reference. This
 * module walks the same tree in the same order (own items first, then sub-sections, both in JSON
 * order — FLATTEN.md §2) and zips the *original item objects* with the flattener's ids. The pairing
 * is pinned by a test that compares every key/name against `flatten()` on the repo samples, so a
 * traversal change in ts-core fails loudly instead of ticking the wrong row.
 */

import { flatten } from "@scanlist/ts-core";
import type { ScanList, ScanListItem, ScanListSection } from "@scanlist/ts-core";

interface Frame {
  section: ScanListSection;
}

/** Original item objects in `flatten()` order (same iterative DFS, same item/section order). */
export function originalItems(list: ScanList): ScanListItem[] {
  const out: ScanListItem[] = [];
  const stack: Frame[] = [];
  for (let i = list.sections.length - 1; i >= 0; i -= 1) {
    stack.push({ section: list.sections[i] as ScanListSection });
  }

  while (stack.length > 0) {
    const { section } = stack.pop() as Frame;
    for (const item of section.items ?? []) {
      if (item !== undefined) out.push(item);
    }
    const children = section.sections ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ section: children[i] as ScanListSection });
    }
  }

  return out;
}

/** `id → original ScanListItem` for the current tree. */
export function itemById(list: ScanList): Map<string, ScanListItem> {
  const flat = flatten(list);
  const originals = originalItems(list);
  const byId = new Map<string, ScanListItem>();
  for (let index = 0; index < flat.length && index < originals.length; index += 1) {
    byId.set((flat[index] as (typeof flat)[number]).id, originals[index] as ScanListItem);
  }
  return byId;
}
