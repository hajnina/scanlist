/**
 * Shopping-list domain (Track A / React Native).
 *
 * Card A1 laid down the types and the static home skeleton. Card A2 adds the real thing:
 *
 * - `@scanlist/ts-core` (card S8) is the contract — `parseList` (LIST.md validation with RFC 6901
 *   pointers), `flatten`/`docText` (FLATTEN.md ids, order, embedding text). Nothing is re-implemented
 *   in this app; `core.ts` is the single import point.
 * - `store.ts` — persistence (`ListRepository` over a `KeyValueStore`), whose stored value IS the
 *   export document (LIST.md §7, B2 precedent).
 * - `encode.ts` — that export document (share/copy, persisted bytes).
 * - `view.ts` / `edit.ts` — the render tree with ts-core ids, and tick/untick by id.
 * - `ui/` — the screens: `ListsScreen` (import file/paste, stored lists, progress) and
 *   `ListDetailScreen` (nested collapsible sections, tick with haptics, export).
 *
 * Begin typing with the shared contract; there is nothing to parse here.
 */
export type {
  FlattenedItem,
  ParseListResult,
  ScanList,
  ScanListAmount,
  ScanListItem,
  ScanListSection,
} from './core';

export {docText, docTexts, errorsOf, flatten, parseList} from './core';

export {
  amountText,
  buildListTree,
  displayText,
  findItem,
  formatJsonNumber,
  isEmptyList,
} from './view';
export type {ItemNode, ListTree, SectionNode} from './view';

export {toggleItem, withItemDone} from './edit';

export {encodeList, fileNameFor, toDocument} from './encode';

export {
  INDEX_STORAGE_KEY,
  ListRepository,
  MemoryKeyValueStore,
  isValidId,
  storageKeyFor,
} from './store';
export type {ImportResult, KeyValueStore, StoredList} from './store';

export {HomeSkeleton} from './ui/HomeSkeleton';
export {ListsScreen} from './ui/ListsScreen';
export {ListDetailScreen} from './ui/ListDetailScreen';
