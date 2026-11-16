/**
 * Nested shopping-list JSON model (see docs/ARCHITECTURE.md and docs/list.schema.json).
 *
 * Card A1 only needs the shape so the directory exists and later cards (A2 list import,
 * A4 ranking) have a home; parsing/flattening is NOT implemented here.
 */

/** Amount may be absent, a number ("2") or a number + unit ("500 g"). */
export type ScanListAmount =
  | number
  | {
      value: number;
      unit?: string;
    }
  | null;

export interface ScanListItem {
  id: string;
  name: string;
  amount?: ScanListAmount;
  /** Alternate names used for embedding ("coke" -> "Coca-Cola"). */
  aliases?: string[];
  /** `done: true` items sink into the collapsed "Done" group. */
  done?: boolean;
}

export interface ScanListSection {
  id: string;
  name: string;
  sections?: ScanListSection[];
  items?: ScanListItem[];
}

export interface ScanList {
  id: string;
  name: string;
  sections: ScanListSection[];
}

/** One item flattened out of the tree, with its section path for the embedding document. */
export interface FlatItem {
  itemId: string;
  /** Section names from the root to the item's parent. */
  path: string[];
  name: string;
  done: boolean;
}
