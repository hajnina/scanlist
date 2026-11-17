/// <reference types="vite/client" />

/**
 * `?raw` imports (the shared golden fixture and the demo sample) resolve to a string.
 * Same declaration as shared/ts-core/tests/raw.d.ts, repeated because this package has its own
 * TypeScript program.
 */
declare module "*?raw" {
  const text: string;
  export default text;
}
