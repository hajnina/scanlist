/**
 * The shared core's SHA-1 (`shared/ts-core/src/sha1.ts`) hashes UTF-8 bytes with `TextEncoder`, which
 * is a WHATWG Encoding API, not a JavaScript built-in: React Native's TypeScript lib does not declare
 * it (the RN config has no `dom` lib), but the Hermes runtime that RN 0.88 ships does provide it —
 * the same call is what the web track uses in a browser.
 *
 * Declaring exactly the one API the shared core needs keeps this app type-clean WITHOUT pulling the
 * whole DOM lib into a native app (which would pretend `document`/`window` exist). Do not extend
 * this file with browser globals; add the polyfill instead if one is ever needed.
 */
declare class TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}
