/**
 * Single import point for the shared contract — card S8's `@scanlist/ts-core`.
 *
 * The normative JSON shape (LIST.md), the RFC 6901 validator (`parseList`), the FLATTEN.md ids /
 * order / docText all live in `shared/ts-core/` and are reused here verbatim: this app never
 * re-implements parsing, flattening or the types (card A2). Metro maps the bare specifier through
 * `metro.config.js`, `tsc` through `tsconfig.json` `paths`, jest through `moduleNameMapper`.
 *
 * Everything in `src/list/` imports from this module so there is exactly one place to change if
 * the shared package is later consumed as a real workspace dependency.
 */
export {docText, docTexts, errorsOf, flatten, parseList} from '@scanlist/ts-core';

export type {
  FlattenedItem,
  ParseListResult,
  ScanList,
  ScanListAmount,
  ScanListItem,
  ScanListSection,
} from '@scanlist/ts-core';
