/**
 * JSON parsing + validation for the normative list format (LIST.md §1–§6,
 * `shared/spec/list.schema.json`).
 *
 * This mirrors the Kotlin reference validator (`apps/kotlin/.../list/ListJson.kt`, card B2)
 * message for message: RFC 6901 JSON-pointer-prefixed errors, unknown fields ignored, the
 * number-or-string `amount` union preserved by JSON type (a quoted "3" is text), and non-finite
 * numbers (`1e999` parses to Infinity in JS) rejected with a pointer instead of leaking into the
 * model. Validation never repairs: a document is either `Ok(list)` or `Error(errors)`, no partial
 * import (LIST.md §5/§6).
 */

import type {
  ScanList,
  ScanListAmount,
  ScanListItem,
  ScanListSection,
} from "./types";

/** LIST.md §5: `Ok(list)` or `Error(errors)`; each error starts with a JSON pointer. */
export type ParseListResult =
  | { ok: true; list: ScanList }
  | { ok: false; errors: string[] };

/** Kotlin's `ListJson.errorsOf`: the errors of a failed parse, empty when it succeeded. */
export function errorsOf(result: ParseListResult): string[] {
  return result.ok ? [] : result.errors;
}

function pointerText(pointer: string): string {
  return pointer === "" ? "/" : pointer;
}

function message(pointer: string, text: string): string {
  return `${pointerText(pointer)}: ${text}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A present field, including a present `undefined`? JSON never yields undefined, so `in`/key checks. */
function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

class Validator {
  readonly errors: string[] = [];

  private fail(pointer: string, text: string): void {
    this.errors.push(message(pointer, text));
  }

  list(root: unknown): ScanList | null {
    if (!isPlainObject(root)) {
      this.fail("", "expected a JSON object");
      return null;
    }

    const title = this.stringField(root, "title", "/title", true);

    let version = 1;
    if (has(root, "version")) {
      const value = root["version"];
      if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
        version = value;
      } else {
        this.fail("/version", "expected an integer");
      }
    }

    let sections: ScanListSection[] = [];
    if (!has(root, "sections")) {
      this.fail("/sections", "required");
    } else {
      sections = this.sectionArray(root["sections"], "/sections");
    }

    if (title === null) return null;
    return { title, version, sections };
  }

  private sectionArray(element: unknown, pointer: string): ScanListSection[] {
    if (!Array.isArray(element)) {
      this.fail(pointer, "expected an array of sections");
      return [];
    }
    const out: ScanListSection[] = [];
    element.forEach((child, index) => {
      const section = this.section(child, `${pointer}/${index}`);
      if (section !== null) out.push(section);
    });
    return out;
  }

  private section(element: unknown, pointer: string): ScanListSection | null {
    if (!isPlainObject(element)) {
      this.fail(pointer, "expected a section object");
      return null;
    }

    const name = this.stringField(element, "name", `${pointer}/name`, true);

    let items: ScanListItem[] = [];
    if (has(element, "items")) {
      const value = element["items"];
      if (Array.isArray(value)) {
        value.forEach((child, index) => {
          const item = this.item(child, `${pointer}/items/${index}`);
          if (item !== null) items.push(item);
        });
      } else {
        this.fail(`${pointer}/items`, "expected an array of items");
      }
    }

    let sections: ScanListSection[] = [];
    if (has(element, "sections")) {
      const value = element["sections"];
      if (Array.isArray(value)) {
        sections = this.sectionArray(value, `${pointer}/sections`);
      } else {
        this.fail(`${pointer}/sections`, "expected an array of sections");
      }
    }

    if (name === null) return null;
    return { name, items, sections };
  }

  private item(element: unknown, pointer: string): ScanListItem | null {
    if (!isPlainObject(element)) {
      this.fail(pointer, "expected an item object");
      return null;
    }

    const name = this.stringField(element, "name", `${pointer}/name`, true);
    const id = this.stringField(element, "id", `${pointer}/id`, false);
    const unit = this.stringField(element, "unit", `${pointer}/unit`, false);
    // LIST.md §3 does not ask for notes to be normalised: keep them verbatim (display trims).
    const note = this.stringField(element, "note", `${pointer}/note`, false, false);

    const amount = this.amount(element, `${pointer}/amount`);
    const aliases = this.aliases(element, `${pointer}/aliases`);
    const done = this.done(element, `${pointer}/done`);

    if (name === null) return null;
    const item: ScanListItem = { name, aliases, done };
    if (id !== null) item.id = id;
    if (amount !== null) item.amount = amount;
    if (unit !== null) item.unit = unit;
    if (note !== null) item.note = note;
    return item;
  }

  /**
   * `amount` is a union by JSON type, never by value (LIST.md §3): strings keep their text
   * (trimmed, blank -> absent), numbers stay numbers, non-finite numbers are an error.
   */
  private amount(obj: Record<string, unknown>, pointer: string): ScanListAmount | null {
    if (!has(obj, "amount")) return null;
    const value = obj["amount"];

    if (typeof value === "string") {
      const text = value.trim();
      return text === "" ? null : text;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      this.fail(pointer, "expected a finite number or a string");
      return null;
    }
    if (value === null) {
      this.fail(pointer, "expected a number or a string, not null");
      return null;
    }
    if (typeof value === "boolean") {
      // Kotlin's JsonPrimitive branch: "true".toDoubleOrNull() is null.
      this.fail(pointer, "expected a finite number or a string");
      return null;
    }
    this.fail(pointer, "expected a number or a string");
    return null;
  }

  private aliases(obj: Record<string, unknown>, pointer: string): string[] {
    if (!has(obj, "aliases")) return [];
    const value = obj["aliases"];
    if (!Array.isArray(value)) {
      this.fail(pointer, "expected an array of strings");
      return [];
    }
    const out: string[] = [];
    value.forEach((entry, index) => {
      if (typeof entry !== "string") {
        this.fail(`${pointer}/${index}`, "expected a string");
      } else if (entry.trim() !== "") {
        // Kept verbatim: aliases are case-sensitive data; trimming/deduping is FLATTEN.md §5.
        out.push(entry);
      }
    });
    return out;
  }

  private done(obj: Record<string, unknown>, pointer: string): boolean {
    if (!has(obj, "done")) return false;
    const value = obj["done"];
    if (typeof value === "boolean") return value;
    this.fail(pointer, "expected a boolean");
    return false;
  }

  /**
   * Optional/required string field. Absent optional fields return `null` (default per LIST.md);
   * a blank id/unit is treated as absent (§3), while a blank title/section name is an error
   * (both are "non-empty after trim"). Required values are returned verbatim, like B2's Kotlin.
   */
  private stringField(
    obj: Record<string, unknown>,
    key: string,
    pointer: string,
    required: boolean,
    trim = true,
  ): string | null {
    if (!has(obj, key)) {
      if (required) this.fail(pointer, "required");
      return null;
    }
    const value = obj[key];
    if (typeof value !== "string") {
      this.fail(pointer, "expected a string");
      return null;
    }
    if (required) {
      if (value.trim() === "") {
        this.fail(pointer, "must not be empty");
        return null;
      }
      return value;
    }
    if (!trim) return value;
    const text = value.trim();
    return text === "" ? null : text;
  }
}

/**
 * Parse and validate one list document. Never throws for invalid input: malformed JSON, non-object
 * roots and every LIST.md §8 invalid example come back as `{ ok: false, errors }`.
 */
export function parseList(text: string): ParseListResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`/: not valid JSON (${reason})`] };
  }

  const validator = new Validator();
  const list = validator.list(root);
  if (validator.errors.length === 0 && list !== null) {
    return { ok: true, list };
  }
  return {
    ok: false,
    errors: validator.errors.length > 0 ? validator.errors : ["/: not a list object"],
  };
}
