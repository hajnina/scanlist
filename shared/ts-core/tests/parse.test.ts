import { describe, expect, it } from "vitest";

import { parseList } from "../src/parse";
import { flatten } from "../src/flatten";
import { must } from "./helpers";
import { samples } from "./fixtures";

function expectInvalid(json: string, pointerPrefix: string): void {
  const result = parseList(json);
  expect(result.ok, `expected <${json}> to be rejected`).toBe(false);
  if (result.ok) return;
  expect(
    result.errors.some((error) => error.startsWith(pointerPrefix)),
    `expected an error starting with <${pointerPrefix}>, got ${JSON.stringify(result.errors)} for ${json}`,
  ).toBe(true);
}

function requireList(json: string) {
  const result = parseList(json);
  if (!result.ok) throw new Error(`parse failed: ${result.errors.join("; ")}`);
  return result.list;
}

describe("parseList — valid documents", () => {
  it("parses every shared sample and counts 44 items", () => {
    let total = 0;
    for (const sample of samples) {
      const list = requireList(sample.text);
      expect(list.title.trim().length, `${sample.name} title`).toBeGreaterThan(0);
      expect(list.version, `${sample.name} version`).toBe(1);
      const items = flatten(list);
      expect(items.length, `${sample.name} item count`).toBe(sample.itemCount);
      total += items.length;
    }
    expect(total, "44 items across the 4 samples").toBe(44);
  });

  it("accepts a minimal list and an empty list", () => {
    const minimal = requireList(
      '{"title":"Corner shop","sections":[{"name":"Tonight","items":[{"name":"Bread"}]}]}',
    );
    expect(minimal.version).toBe(1);
    expect(flatten(minimal).map((item) => item.name)).toEqual(["Bread"]);

    const empty = requireList('{"title":"Nothing to buy","sections":[]}');
    expect(flatten(empty)).toEqual([]);
  });

  it("ignores unknown fields, never fatal (LIST.md §1/§6)", () => {
    const list = requireList(
      '{"title":"T","colour":"red","version":1,"sections":[{"name":"S","order":3,"items":' +
        '[{"name":"Milk","brand":"x","meta":{"a":1},"amount":2}]}]}',
    );
    const item = must(must(must(list.sections[0]).items)[0]);
    expect(item.name).toBe("Milk");
    expect(item.amount).toBe(2);
  });

  it("keeps the amount union by JSON type, never by value", () => {
    const list = requireList(
      '{"title":"T","sections":[{"name":"S","items":[' +
        '{"name":"Milk","amount":"3"},{"name":"Eggs","amount":" 12 "},{"name":"Jam","amount":"1e3"},' +
        '{"name":"Rice","amount":3},{"name":"Ice","amount":0.5}]}]}',
    );
    const items = must(must(list.sections[0]).items);
    expect(items[0]?.amount).toBe("3");
    expect(items[1]?.amount).toBe("12");
    expect(items[2]?.amount).toBe("1e3");
    expect(items[3]?.amount).toBe(3);
    expect(items[4]?.amount).toBe(0.5);
  });

  it("treats an empty amount string and a blank unit as absent", () => {
    const list = requireList(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"Milk","amount":"   ","unit":"  "}]}]}',
    );
    const item = must(must(must(list.sections[0]).items)[0]);
    expect(item.amount).toBeUndefined();
    expect(item.unit).toBeUndefined();
    const flat = flatten(list)[0];
    expect(flat?.amount).toBeNull();
    expect(flat?.unit).toBeNull();
  });

  it("trims explicit ids/units but keeps notes verbatim", () => {
    const list = requireList(
      '{"title":"T","sections":[{"name":"S","items":[{"id":"  milk  ","name":"Milk  ","unit":" kg ","note":"  keep me  "}]}]}',
    );
    const item = must(must(must(list.sections[0]).items)[0]);
    expect(item.id).toBe("milk");
    expect(item.name).toBe("Milk  ");
    expect(item.unit).toBe("kg");
    expect(item.note).toBe("  keep me  ");
  });

  it("accepts an unknown future version best-effort (LIST.md §1)", () => {
    expect(requireList('{"title":"T","version":7,"sections":[]}').version).toBe(7);
  });
});

describe("parseList — LIST.md §8 invalid examples", () => {
  it("rejects every example with an RFC 6901 pointer", () => {
    expectInvalid('{"sections":[]}', "/title: required");
    expectInvalid('{"title":"   ","sections":[]}', "/title: must not be empty");
    expectInvalid('{"title":"T"}', "/sections: required");
    expectInvalid('{"title":"T","sections":{}}', "/sections: expected an array of sections");
    expectInvalid('{"title":"T","sections":[{"name":3}]}', "/sections/0/name: expected a string");
    expectInvalid('{"title":"T","sections":[{"items":[]}]}', "/sections/0/name: required");
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"amount":2}]}]}',
      "/sections/0/items/0/name: required",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","amount":null}]}]}',
      "/sections/0/items/0/amount: expected a number or a string, not null",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","aliases":"milk"}]}]}',
      "/sections/0/items/0/aliases: expected an array of strings",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","done":"yes"}]}]}',
      "/sections/0/items/0/done: expected a boolean",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","amount":true}]}]}',
      "/sections/0/items/0/amount: expected a finite number or a string",
    );
  });

  it("rejects non-finite numbers (1e999 -> Infinity) with the amount pointer", () => {
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","amount":1e999}]}]}',
      "/sections/0/items/0/amount: expected a finite number or a string",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","amount":-1e999}]}]}',
      "/sections/0/items/0/amount: expected a finite number or a string",
    );
  });

  it("rejects wrong field types elsewhere too", () => {
    expectInvalid('{"title":"T","version":"1","sections":[]}', "/version: expected an integer");
    expectInvalid('{"title":"T","version":1.5,"sections":[]}', "/version: expected an integer");
    expectInvalid('{"title":"T","version":true,"sections":[]}', "/version: expected an integer");
    expectInvalid('{"title":3,"sections":[]}', "/title: expected a string");
    expectInvalid('{"title":"T","sections":[3]}', "/sections/0: expected a section object");
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":{}}]}',
      "/sections/0/items: expected an array of items",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","sections":{}}]}',
      "/sections/0/sections: expected an array of sections",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","aliases":["ok",3]}]}]}',
      "/sections/0/items/0/aliases/1: expected a string",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","id":3}]}]}',
      "/sections/0/items/0/id: expected a string",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","unit":3}]}]}',
      "/sections/0/items/0/unit: expected a string",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"M","note":3}]}]}',
      "/sections/0/items/0/note: expected a string",
    );
    expectInvalid(
      '{"title":"T","sections":[{"name":"S","sections":[{"name":"N","items":[{"name":3}]}]}]}',
      "/sections/0/sections/0/items/0/name: expected a string",
    );
  });

  it("reports every error, never a partial import", () => {
    const result = parseList(
      '{"title":"T","sections":[{"name":"A","items":[{"name":"M","done":1}]},{"name":"B","items":[{"name":"N","amount":null}]}]}',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      "/sections/0/items/0/done: expected a boolean",
      "/sections/1/items/0/amount: expected a number or a string, not null",
    ]);
  });
});

describe("parseList — malformed input", () => {
  it("rejects non-object roots and non-JSON text, never crashes", () => {
    for (const text of ["", " ", "[]", '"list"', "{", "not json", "null"]) {
      expect(parseList(text).ok, `<${text}> should be invalid`).toBe(false);
    }
    const empty = parseList("");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors[0]?.startsWith("/: not valid JSON")).toBe(true);

    const array = parseList("[]");
    if (!array.ok) expect(array.errors).toContain("/: expected a JSON object");
  });
});
