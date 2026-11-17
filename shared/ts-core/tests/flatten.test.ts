import { describe, expect, it } from "vitest";

import { docText, flatten } from "../src/flatten";
import type { FlattenedItem, ScanList, ScanListSection } from "../src/types";

function listOf(...sections: ScanListSection[]): ScanList {
  return { title: "t", sections };
}

function oneItem(item: Record<string, unknown>, sectionName = "S"): FlattenedItem {
  return flatten(
    listOf({ name: sectionName, items: [item as never] }),
  )[0] as FlattenedItem;
}

describe("flatten — ids (FLATTEN.md §3)", () => {
  it("matches the worked derived-id values", () => {
    const items = flatten(
      listOf(
        { name: "Pantry", items: [{ name: "Pasta" }] },
        {
          name: "Fresh",
          sections: [
            { name: "Fruit & veg", items: [{ name: "Bananas" }, { name: "Tomatoes" }] },
          ],
        },
      ),
    );

    expect(items.map((item) => item.id)).toEqual([
      "sha1:19d895a3b978a4e00caccc2f20ce35044c83cd28",
      "sha1:998e2c1acb80597f39892b85f9dfa8726ead298e",
      "sha1:801b3e63df7a42974bc5f11b4a342251f8c04ba3",
    ]);
    expect(items.map((item) => item.path)).toEqual([
      ["Pantry"],
      ["Fresh", "Fruit & veg"],
      ["Fresh", "Fruit & veg"],
    ]);
    expect(items.map((item) => item.pathText)).toEqual([
      "Pantry",
      "Fresh > Fruit & veg",
      "Fresh > Fruit & veg",
    ]);
    expect(items.map((item) => item.order)).toEqual([0, 1, 2]);
  });

  it("matches the four-level nesting worked id", () => {
    const items = flatten(
      listOf({
        name: "A",
        sections: [
          {
            name: "B",
            sections: [
              {
                name: "C",
                sections: [
                  { name: "D", items: [{ name: "Salt" }, { name: "Pepper" }, { name: "Nutmeg" }] },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(items[2]?.id).toBe("sha1:cfc789c216b0dd286fa1f6f40592e8db7aeb7197");
    expect(items[2]?.path).toEqual(["A", "B", "C", "D"]);
    expect(items[2]?.index).toBe(2);
    expect(items[2]?.order).toBe(2);
  });

  it("keeps the id key verbatim but trims the display name", () => {
    const item = oneItem({ name: "Pasta " }, "S");
    // key is "S/Pasta #0" (verbatim name), while name/docText are trimmed.
    expect(item.id).toBe("sha1:ccd84664f27fd993d2b15b5fbd07d8c2b7504bd5");
    expect(item.name).toBe("Pasta");
    expect(docText({ ...item, aliases: [], path: ["S"] })).toBe("Pasta; S");
  });

  it("trims and uses explicit ids verbatim, including blank -> derived", () => {
    const items = flatten(
      listOf({
        name: "S",
        items: [
          { id: "  Milk#42  ", name: "Milk" },
          { id: "   ", name: "Bread" },
          { id: "", name: "Jam" },
        ],
      }),
    );
    expect(items[0]?.id).toBe("Milk#42");
    expect(items[1]?.id).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(items[2]?.id).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(items[1]?.id).not.toBe(items[2]?.id);
  });

  it("renames duplicate ids deterministically, explicit ids too", () => {
    const items = flatten(
      listOf({
        name: "S",
        items: [
          { id: "milk", name: "Milk" },
          { id: "milk", name: "Milk again" },
          { id: "milk", name: "Milk once more" },
          { name: "Bread" },
          { name: "Bread" },
        ],
      }),
    );
    expect(items.map((item) => item.id).slice(0, 3)).toEqual(["milk", "milk~2", "milk~3"]);
    // Same-name siblings are distinct because of #index, not collision renaming.
    expect(items[3]?.id).toMatch(/^sha1:/);
    expect(items[4]?.id).toMatch(/^sha1:/);
    expect(items[4]?.id).not.toBe(items[3]?.id);
  });
});

describe("flatten — traversal order (FLATTEN.md §2)", () => {
  it("visits own items before sub-sections, both in JSON order", () => {
    const items = flatten(
      listOf({
        name: "Root",
        items: [{ name: "Root item" }],
        sections: [
          { name: "First child", items: [{ name: "Child item" }] },
          { name: "Second child", items: [{ name: "Other child" }] },
        ],
      }),
    );
    expect(items.map((item) => item.name)).toEqual(["Root item", "Child item", "Other child"]);
    expect(items.map((item) => item.order)).toEqual([0, 1, 2]);
    expect(items.map((item) => item.pathText)).toEqual([
      "Root",
      "Root > First child",
      "Root > Second child",
    ]);
  });

  it("contributes nothing for empty sections and empty item arrays", () => {
    expect(flatten(listOf({ name: "Empty", items: [], sections: [] }))).toEqual([]);
    expect(flatten({ title: "t", sections: [] })).toEqual([]);
  });

  it("does not recurse deeper than the input (64 levels)", () => {
    let section: ScanListSection = { name: "L64", items: [{ name: "Nutmeg" }] };
    for (let level = 63; level >= 1; level -= 1) {
      section = { name: `L${level}`, sections: [section] };
    }
    const items = flatten(listOf(section));
    expect(items).toHaveLength(1);
    expect(items[0]?.path).toHaveLength(64);
    expect(items[0]?.path[0]).toBe("L1");
    expect(items[0]?.path[63]).toBe("L64");
    expect(items[0]?.pathText).toBe(
      Array.from({ length: 64 }, (_, index) => `L${index + 1}`).join(" > "),
    );
  });
});

describe("flatten — aliases, amount, unit, note (FLATTEN.md §1/§5)", () => {
  it("trims aliases, drops empties and dedupes case-insensitively after NFC", () => {
    const item = oneItem({
      name: "Milk",
      aliases: ["Leche", "leche", "Leche ", "  ", "MLÉKO", "Mle\u0301ko"],
    });
    expect(item.aliases).toEqual(["Leche", "MLÉKO"]);
  });

  it("dedupes with Unicode full case folding, not just lowercasing (ß ≡ ss, ﬁ ≡ fi)", () => {
    const item = oneItem({
      name: "Milk",
      aliases: ["Straße", "STRASSE", "strasse", "ﬁle", "FILE", "ﬁle"],
    });
    expect(item.aliases).toEqual(["Straße", "ﬁle"]);
  });

  it("keeps the first spelling in order (decomposed é)", () => {
    const item = oneItem({ name: "Milk", aliases: ["Mle\u0301ko", "ml\u00e9ko", "mléko"] });
    expect(item.aliases).toEqual(["Mle\u0301ko"]);
  });

  it("keeps amount JSON type, normalises blanks and trims unit/note", () => {
    const items = flatten(
      listOf({
        name: "S",
        items: [
          { name: "Pasta ", amount: 2, unit: " kg ", note: " big bag ", done: true },
          { name: "Honey", amount: "   ", unit: "" },
          { name: "Olives", amount: "250 g tub" },
          { name: "Rice", amount: "3" },
        ],
      }),
    );
    const [pasta, honey, olives, rice] = items;
    expect(pasta).toMatchObject({
      name: "Pasta",
      amount: 2,
      unit: "kg",
      note: "big bag",
      done: true,
    });
    expect(honey?.amount).toBeNull();
    expect(honey?.unit).toBeNull();
    expect(honey?.note).toBeNull();
    expect(olives?.amount).toBe("250 g tub");
    expect(olives?.done).toBe(false);
    expect(rice?.amount).toBe("3");
  });
});

describe("docText (FLATTEN.md §4)", () => {
  it("matches the worked examples", () => {
    expect(docText({ name: "Bananas", aliases: [], path: ["Fresh", "Fruit & veg"] })).toBe(
      "Bananas; Fresh > Fruit & veg",
    );
    expect(
      docText({ name: "Tomatoes", aliases: ["tomates"], path: ["Fresh", "Fruit & veg"] }),
    ).toBe("Tomatoes; tomates; Fresh > Fruit & veg");
    expect(
      docText({ name: "Oat milk", aliases: ["bebida de avena"], path: ["Fresh", "Dairy"] }),
    ).toBe("Oat milk; bebida de avena; Fresh > Dairy");
    expect(docText({ name: "Milk", aliases: [], path: [] })).toBe("Milk");
  });

  it("never contains the note and always starts with the name", () => {
    const item = oneItem({
      name: "Cheese",
      note: "ask for the aged one",
      aliases: ["queso"],
    });
    const text = docText(item);
    expect(text).toBe("Cheese; queso; S");
    expect(text).not.toContain("aged");
  });

  it("joins multiple aliases with ', ' and trims once at the end", () => {
    const text = docText({
      name: "Milk",
      aliases: ["leche", "mléko", "mléko polotučné"],
      path: ["Mercado"],
    });
    expect(text).toBe("Milk; leche, mléko, mléko polotučné; Mercado");
  });
});
