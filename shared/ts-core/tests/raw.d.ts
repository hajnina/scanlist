/** Vite/Vitest `?raw` imports let the tests read the shared fixtures from the repo root. */
declare module "*?raw" {
  const content: string;
  export default content;
}
