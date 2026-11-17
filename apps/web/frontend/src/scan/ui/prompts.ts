/**
 * Retrieval prefixes, read from the normative `shared/spec/prompts.json` at build time.
 *
 * RANK.md §2.1/§2.2 and `prompts.json` rules: the embedded string is
 * `prefix + trim(text)`, and consumers MUST NOT hard-code the prefixes — they are read from the
 * spec file and re-read whenever the active set changes. `?raw` keeps the file itself as the single
 * source of truth (no copied constant, no drift) while still bundling it for the browser.
 *
 * The set is `prompts.json[active]` (`mnemothera` since S3's A/B). `imagePrefix` is always empty
 * (RANK.md §2.2: images are embedded raw), so only the two text prefixes are exposed here.
 */

import promptsRaw from "../../../../../../shared/spec/prompts.json?raw";

export interface RetrievalPrefixes {
  /** Set name from `prompts.json.active` (e.g. `mnemothera`), for status lines only. */
  active: string;
  /** `prompts.json[active].doc` — item documents (FLATTEN.md `docText`). */
  doc: string;
  /** `prompts.json[active].query` — OFF product name and one OCR line each. */
  query: string;
  /** `prompts.json.model`, used in cache keys/diagnostics only. */
  model: string;
}

interface PromptsFile {
  active?: unknown;
  model?: unknown;
  imagePrefix?: unknown;
  [set: string]: unknown;
}

interface PromptSet {
  doc?: unknown;
  query?: unknown;
}

/**
 * Parse the bundled spec into the two prefixes. Throws on a malformed file: a silently empty prefix
 * would poison every later comparison (RANK.md §2.1 cache key includes the prefix).
 */
export function readPrefixes(raw: string = promptsRaw): RetrievalPrefixes {
  const requireString = (value: unknown, key: string): string => {
    if (typeof value !== "string") {
      throw new TypeError(`prompts.json: ${key} is not a string`);
    }
    return value;
  };

  let parsed: PromptsFile;
  try {
    parsed = JSON.parse(raw) as PromptsFile;
  } catch (error) {
    throw new TypeError(`prompts.json is not valid JSON: ${String(error)}`);
  }

  const active = requireString(parsed.active, "active");
  const set = parsed[active] as PromptSet | undefined;
  if (typeof set !== "object" || set === null) {
    throw new TypeError(`prompts.json: active set ${JSON.stringify(active)} is missing`);
  }
  if (parsed.imagePrefix !== "") {
    // The image branch is raw by spec; a non-empty value would silently change every image query.
    throw new TypeError("prompts.json: imagePrefix must be empty (RANK.md §2.2)");
  }

  return {
    active,
    doc: requireString(set.doc, `${active}.doc`),
    query: requireString(set.query, `${active}.query`),
    model: requireString(parsed.model, "model"),
  };
}

/** The prefixes the app embeds with (module-level: the spec file cannot change at runtime). */
export const PROMPT_PREFIXES: RetrievalPrefixes = readPrefixes();

/** `prefix + trim(text)` (prompts.json `rules.apply`); whitespace-only text stays empty. */
export function applyPrefix(prefix: string, text: string): string {
  return prefix + text.trim();
}
