/**
 * View model for the nested list screen (card A2).
 *
 * The tree is the imported JSON exactly as written (LIST.md §2: section order, item order, any
 * depth) — the unranked view. Item ids and counts come from `@scanlist/ts-core`'s `flatten`
 * (FLATTEN.md §2/§3), never from a local re-derivation: `buildListTree` walks the sections in the
 * normative depth-first order and joins the flattened items onto the tree by position. `flatten`
 * is pinned to the golden fixture by the parity test, so a join is safe and an id can never drift.
 */
import {flatten} from './core';
import type {
  FlattenedItem,
  ScanList,
  ScanListItem,
  ScanListSection,
} from './core';

/** One item of the tree with the flat item ts-core derived for it (id, trimmed fields, order). */
export interface ItemNode {
  item: ScanListItem;
  flat: FlattenedItem;
}

/** A section with its own items and sub-sections, plus the ticked/total counts of its subtree. */
export interface SectionNode {
  name: string;
  /** Section names from the root to and including this one. */
  path: string[];
  items: ItemNode[];
  sections: SectionNode[];
  /** Items in this section's subtree (own items plus every sub-section's). */
  total: number;
  /** Ticked items in this section's subtree. */
  done: number;
}

/** The whole list ready to render, plus the app-level progress numbers. */
export interface ListTree {
  title: string;
  version: number;
  sections: SectionNode[];
  total: number;
  done: number;
}

/**
 * Join ts-core's flattened output onto the imported tree.
 *
 * FLATTEN.md §2 is the same walk: a section's own items first, then its sub-sections, both in JSON
 * order. `flatten` therefore returns exactly one item per tree item, in the order this function
 * visits them — hence the running cursor. The tree keeps the ORIGINAL item objects (untouched), so
 * re-encoding it reproduces the imported document (LIST.md §7).
 */
export function buildListTree(list: ScanList): ListTree {
  const flat = flatten(list);
  let cursor = 0;

  const walk = (section: ScanListSection, path: string[]): SectionNode => {
    const items: ItemNode[] = (section.items ?? []).map(item => {
      // `flat[cursor]` exists for every tree item by FLATTEN.md §2 (pinned by the parity test).
      const flatItem = flat[cursor] as FlattenedItem;
      cursor += 1;
      return {item, flat: flatItem};
    });

    const sections = (section.sections ?? []).map(child =>
      walk(child, [...path, child.name]),
    );

    const total =
      items.length + sections.reduce((sum, child) => sum + child.total, 0);
    const done =
      items.filter(node => node.flat.done).length +
      sections.reduce((sum, child) => sum + child.done, 0);

    return {name: section.name, path, items, sections, total, done};
  };

  const sections = (list.sections ?? []).map(section =>
    walk(section, [section.name]),
  );

  return {
    title: list.title,
    version: list.version ?? 1,
    sections,
    total: sections.reduce((sum, section) => sum + section.total, 0),
    done: sections.reduce((sum, section) => sum + section.done, 0),
  };
}

/** `amountText` from LIST.md §4: "" when absent, free text as stored, shortest decimal for numbers. */
export function amountText(amount: FlattenedItem['amount']): string {
  if (amount === null || amount === undefined) {
    return '';
  }
  if (typeof amount === 'string') {
    return amount.trim();
  }
  return formatJsonNumber(amount);
}

/**
 * `displayText` from LIST.md §4: amount plus unit, the unit only when there is an amount.
 * Notes are rendered in their own row, never here.
 */
export function displayText(item: Pick<FlattenedItem, 'amount' | 'unit'>): string {
  const amount = amountText(item.amount);
  const unit = item.unit?.trim() ?? '';
  return amount !== '' && unit !== '' ? `${amount} ${unit}` : amount;
}

/**
 * Shortest round-trip decimal, JSON style (LIST.md §4), used for display so it can never disagree
 * with the export. `String(x)` already is exactly that in the spec's range: `6`, `0.5`, `-2` and
 * plain decimals for |x| in [1e-6, 1e15) (JS only switches to exponent notation outside it).
 */
export function formatJsonNumber(value: number): string {
  return String(value);
}

/** True when the imported document has no items at all (LIST.md §1: `"sections": []` is valid). */
export function isEmptyList(tree: ListTree): boolean {
  return tree.total === 0;
}

/** Depth-first search for an item id in the tree, `null` when the id is not in this list. */
export function findItem(tree: ListTree, itemId: string): ItemNode | null {
  const stack: SectionNode[] = [...tree.sections].reverse();
  while (stack.length > 0) {
    const section = stack.pop() as SectionNode;
    const hit = section.items.find(node => node.flat.id === itemId);
    if (hit) {
      return hit;
    }
    stack.push(...[...section.sections].reverse());
  }
  return null;
}
