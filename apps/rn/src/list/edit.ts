/**
 * Item edits on the nested tree (card A2), the RN counterpart of B2's `ListEdit.kt`.
 *
 * `done` is the only mutable per-item state (LIST.md §3): ticking sets `true`, unticking sets
 * `false`, and a ticked item is never removed from storage. Ids are assigned by `@scanlist/ts-core`'s
 * `flatten` in FLATTEN.md §2 traversal order — this module rebuilds the tree with the same cursor,
 * so ticking by id can never hit the wrong row when two sections share a name or two items share
 * a name in one section.
 */
import {flatten} from './core';
import type {ScanList, ScanListItem, ScanListSection} from './core';

/**
 * Returns a copy of `list` with the item whose flattened id is `itemId` marked `done`, or `null`
 * when the id is not in this list (the UI can hold an id across a reload).
 */
export function withItemDone(
  list: ScanList,
  itemId: string,
  done: boolean,
): ScanList | null {
  const ids = flatten(list).map(item => item.id);
  if (!ids.includes(itemId)) {
    return null;
  }

  let cursor = 0;
  const walk = (section: ScanListSection): ScanListSection => {
    const items = (section.items ?? []).map(item => {
      const id = ids[cursor] as string;
      cursor += 1;
      return id === itemId ? ({...item, done} as ScanListItem) : item;
    });
    return {
      ...section,
      items,
      sections: (section.sections ?? []).map(walk),
    };
  };

  return {...list, sections: (list.sections ?? []).map(walk)};
}

/** Toggle one item by its flattened id; `null` when the id is not in this list. */
export function toggleItem(list: ScanList, itemId: string): ScanList | null {
  const current = flatten(list).find(item => item.id === itemId);
  if (!current) {
    return null;
  }
  return withItemDone(list, itemId, !current.done);
}
