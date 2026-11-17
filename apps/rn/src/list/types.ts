/**
 * The list JSON contract — card A1 wrote these types by hand from `docs/list.schema.json`; card A2
 * (this card) replaces them with a re-export of the MERGED shared core (`@scanlist/ts-core`, card
 * S8), whose `ScanList` / `ScanListSection` / `ScanListItem` / `ScanListAmount` are the same shape
 * and the ones `parseList` / `flatten` actually return.
 *
 * Keeping one declaration (the shared package's) means the app can never drift from the validator:
 * `parseList` hands back `ScanList`, `flatten` hands back `FlattenedItem[]`, and every screen uses
 * exactly those types. Adding fields here would silently disagree with the validator — don't.
 *
 * A1's `FlatItem` helper (`itemId`/`path`/`name`/`done`) is superseded by ts-core's `FlattenedItem`
 * (FLATTEN.md §1), which additionally carries `amount`/`unit`/`note`/`aliases`/`index`/`order`.
 */
export type {
  FlattenedItem,
  ScanList,
  ScanListAmount,
  ScanListItem,
  ScanListSection,
} from '@scanlist/ts-core';
