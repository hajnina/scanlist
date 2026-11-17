/**
 * Unicode **full** case folding — RANK.md §3.1 and FLATTEN.md §5.
 *
 * The contract is Python's `str.casefold()` (Unicode `CaseFolding.txt`, mappings C + S + F; the Turkic T
 * mappings are deliberately excluded). `String#toLowerCase()` is *not* enough: it leaves `ß` as `ß`
 * where case folding gives `ss` (and `ẞ` folds to `ss` too), keeps the ligature `ﬁ`, the long s `ſ` and
 * the final sigma `ς`, and it lowercases Cherokee to the small letters where case folding maps to the
 * uppercase syllabary. Locale-sensitive or Turkish-irrational casing would make the three tracks
 * disagree on `BARCODE_MATCH`.
 *
 * Implementation: per-code-point `toLowerCase()` (the locale-independent default conversion, which
 * already expands `İ` to `i` + U+0307 and `ẞ` to `ß`) followed by the exception table below. The
 * table holds every code point whose full fold differs from its lowercase mapping; it was derived by
 * exhaustive comparison against Python's `str.casefold()` and is fuzz-checked against it (all of
 * Unicode plus random strings). Cherokee is the one script that folds "upward", so its two ranges are
 * handled arithmetically instead of as 116 entries. `IDENTITY_OVERRIDES` pins code points where the
 * engine's ICU lowercase data is newer than the oracle's Unicode version (Python 3.14 / Unicode 16):
 * folding them to themselves is what the oracle does, and it keeps the result independent of the
 * Node/ICU build.
 *
 * This module is pure and dependency-free; it is used by `normBarcodeText`/`barcodeMatch` and by
 * `flatten`'s alias dedupe, i.e. exactly where the oracle calls `casefold()`.
 */

/**
 * `lowercase(code point) -> casefold(code point)` for every code point where the two differ.
 * Keys/values are written as code-point escapes so the table stays readable and encoding-safe.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  "\u{b5}": "\u{3bc}", "\u{df}": "\u{73}\u{73}", "\u{149}": "\u{2bc}\u{6e}", "\u{17f}": "\u{73}",
  "\u{1f0}": "\u{6a}\u{30c}", "\u{345}": "\u{3b9}", "\u{390}": "\u{3b9}\u{308}\u{301}", "\u{3b0}": "\u{3c5}\u{308}\u{301}",
  "\u{3c2}": "\u{3c3}", "\u{3d0}": "\u{3b2}", "\u{3d1}": "\u{3b8}", "\u{3d5}": "\u{3c6}",
  "\u{3d6}": "\u{3c0}", "\u{3f0}": "\u{3ba}", "\u{3f1}": "\u{3c1}", "\u{3f5}": "\u{3b5}",
  "\u{587}": "\u{565}\u{582}", "\u{1c80}": "\u{432}", "\u{1c81}": "\u{434}", "\u{1c82}": "\u{43e}",
  "\u{1c83}": "\u{441}", "\u{1c84}": "\u{442}", "\u{1c85}": "\u{442}", "\u{1c86}": "\u{44a}",
  "\u{1c87}": "\u{463}", "\u{1c88}": "\u{a64b}", "\u{1e96}": "\u{68}\u{331}", "\u{1e97}": "\u{74}\u{308}",
  "\u{1e98}": "\u{77}\u{30a}", "\u{1e99}": "\u{79}\u{30a}", "\u{1e9a}": "\u{61}\u{2be}", "\u{1e9b}": "\u{1e61}",
  "\u{1f50}": "\u{3c5}\u{313}", "\u{1f52}": "\u{3c5}\u{313}\u{300}", "\u{1f54}": "\u{3c5}\u{313}\u{301}", "\u{1f56}": "\u{3c5}\u{313}\u{342}",
  "\u{1f80}": "\u{1f00}\u{3b9}", "\u{1f81}": "\u{1f01}\u{3b9}", "\u{1f82}": "\u{1f02}\u{3b9}", "\u{1f83}": "\u{1f03}\u{3b9}",
  "\u{1f84}": "\u{1f04}\u{3b9}", "\u{1f85}": "\u{1f05}\u{3b9}", "\u{1f86}": "\u{1f06}\u{3b9}", "\u{1f87}": "\u{1f07}\u{3b9}",
  "\u{1f90}": "\u{1f20}\u{3b9}", "\u{1f91}": "\u{1f21}\u{3b9}", "\u{1f92}": "\u{1f22}\u{3b9}", "\u{1f93}": "\u{1f23}\u{3b9}",
  "\u{1f94}": "\u{1f24}\u{3b9}", "\u{1f95}": "\u{1f25}\u{3b9}", "\u{1f96}": "\u{1f26}\u{3b9}", "\u{1f97}": "\u{1f27}\u{3b9}",
  "\u{1fa0}": "\u{1f60}\u{3b9}", "\u{1fa1}": "\u{1f61}\u{3b9}", "\u{1fa2}": "\u{1f62}\u{3b9}", "\u{1fa3}": "\u{1f63}\u{3b9}",
  "\u{1fa4}": "\u{1f64}\u{3b9}", "\u{1fa5}": "\u{1f65}\u{3b9}", "\u{1fa6}": "\u{1f66}\u{3b9}", "\u{1fa7}": "\u{1f67}\u{3b9}",
  "\u{1fb2}": "\u{1f70}\u{3b9}", "\u{1fb3}": "\u{3b1}\u{3b9}", "\u{1fb4}": "\u{3ac}\u{3b9}", "\u{1fb6}": "\u{3b1}\u{342}",
  "\u{1fb7}": "\u{3b1}\u{342}\u{3b9}", "\u{1fbe}": "\u{3b9}", "\u{1fc2}": "\u{1f74}\u{3b9}", "\u{1fc3}": "\u{3b7}\u{3b9}",
  "\u{1fc4}": "\u{3ae}\u{3b9}", "\u{1fc6}": "\u{3b7}\u{342}", "\u{1fc7}": "\u{3b7}\u{342}\u{3b9}", "\u{1fd2}": "\u{3b9}\u{308}\u{300}",
  "\u{1fd3}": "\u{3b9}\u{308}\u{301}", "\u{1fd6}": "\u{3b9}\u{342}", "\u{1fd7}": "\u{3b9}\u{308}\u{342}", "\u{1fe2}": "\u{3c5}\u{308}\u{300}",
  "\u{1fe3}": "\u{3c5}\u{308}\u{301}", "\u{1fe4}": "\u{3c1}\u{313}", "\u{1fe6}": "\u{3c5}\u{342}", "\u{1fe7}": "\u{3c5}\u{308}\u{342}",
  "\u{1ff2}": "\u{1f7c}\u{3b9}", "\u{1ff3}": "\u{3c9}\u{3b9}", "\u{1ff4}": "\u{3ce}\u{3b9}", "\u{1ff6}": "\u{3c9}\u{342}",
  "\u{1ff7}": "\u{3c9}\u{342}\u{3b9}", "\u{fb00}": "\u{66}\u{66}", "\u{fb01}": "\u{66}\u{69}", "\u{fb02}": "\u{66}\u{6c}",
  "\u{fb03}": "\u{66}\u{66}\u{69}", "\u{fb04}": "\u{66}\u{66}\u{6c}", "\u{fb05}": "\u{73}\u{74}", "\u{fb06}": "\u{73}\u{74}",
  "\u{fb13}": "\u{574}\u{576}", "\u{fb14}": "\u{574}\u{565}", "\u{fb15}": "\u{574}\u{56b}", "\u{fb16}": "\u{57e}\u{576}",
  "\u{fb17}": "\u{574}\u{56d}",
};

/** Code points the engine lowercases but Python 3.14's Unicode 16 data folds to themselves. */
const IDENTITY_OVERRIDES: ReadonlySet<number> = new Set([
  0xa7ce,
  0xa7d2,
  0xa7d4,
  ...Array.from({ length: 0x16eb8 - 0x16ea0 + 1 }, (_, index) => 0x16ea0 + index),
]);

/** Fold one code point: engine lowercase, then the case-folding exceptions (Cherokee folds up). */
function foldCodePoint(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (IDENTITY_OVERRIDES.has(cp)) return ch;
  const lower = ch.toLowerCase();
  const lowerCp = lower.codePointAt(0) ?? 0;
  if (lowerCp >= 0xab70 && lowerCp <= 0xabbf) {
    return String.fromCodePoint(0x13a0 + (lowerCp - 0xab70));
  }
  if (lowerCp >= 0x13f8 && lowerCp <= 0x13fd) {
    return String.fromCodePoint(0x13f0 + (lowerCp - 0x13f8));
  }
  return EXCEPTIONS[lower] ?? lower;
}

/** Unicode full case folding, equivalent to Python's `str.casefold()` (RANK.md §3.1). */
export function casefold(s: string): string {
  return Array.from(s, foldCodePoint).join("");
}
