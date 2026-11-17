/**
 * LIST.md §5/§6/§8 validation, through the shared core (`@scanlist/ts-core`'s `parseList`).
 *
 * These tests deliberately assert on the SHARED implementation, not on a local copy: card A2's
 * contract is "the RN app validates exactly like the Kotlin track (B2) and the spec samples", and
 * `parseList` was written for that (S8). If a test here fails, the app and the validator have
 * diverged — which is the thing the card forbids.
 */
import {parseList} from '../core';

const ok = (json: unknown) => parseList(JSON.stringify(json));

describe('LIST.md §8 examples — valid', () => {
  it('accepts the minimal list', () => {
    const result = ok({
      title: 'Corner shop',
      sections: [{name: 'Tonight', items: [{name: 'Bread'}]}],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.list.title).toBe('Corner shop');
    expect(result.list.version).toBe(1);
    expect(result.list.sections[0]?.items).toEqual([
      {name: 'Bread', aliases: [], done: false},
    ]);
  });

  it('accepts the nested every-field example', () => {
    const result = ok({
      title: 'Van weekly shop',
      version: 1,
      sections: [
        {
          name: 'Fresh',
          sections: [
            {
              name: 'Fruit & veg',
              items: [
                {id: 'bananas', name: 'Bananas', amount: 6},
                {
                  name: 'Tomatoes',
                  amount: 1,
                  unit: 'kg',
                  aliases: ['tomates'],
                  done: true,
                },
              ],
            },
            {
              name: 'Dairy',
              items: [
                {
                  name: 'Oat milk',
                  amount: '2 cartons',
                  unit: 'l',
                  note: 'the barista one',
                  aliases: ['bebida de avena'],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const fresh = result.list.sections[0];
    expect(fresh?.items).toEqual([]);
    expect(fresh?.sections).toHaveLength(2);
    expect(fresh?.sections?.[1]?.items?.[0]).toMatchObject({
      name: 'Oat milk',
      amount: '2 cartons',
      unit: 'l',
      note: 'the barista one',
    });
  });

  it('accepts "sections": [] (a valid empty list)', () => {
    const result = ok({title: 'Empty', sections: []});
    expect(result).toEqual({ok: true, list: {title: 'Empty', version: 1, sections: []}});
  });

  it('accepts 8+ levels of nesting and does not crash on deeper input', () => {
    let section: Record<string, unknown> = {
      name: 'L0',
      items: [{name: 'Deep thing'}],
    };
    for (let depth = 1; depth < 24; depth += 1) {
      section = {name: `L${depth}`, sections: [section]};
    }
    const result = ok({title: 'Deep', sections: [section]});
    expect(result.ok).toBe(true);
  });
});

describe('LIST.md §8 examples — invalid (pointered, no partial import)', () => {
  const cases: Array<[string, unknown, string]> = [
    ['missing title', {sections: []}, '/title: required'],
    [
      '"sections": {}',
      {title: 'T', sections: {}},
      '/sections: expected an array of sections',
    ],
    [
      '{"name": 3} in a section',
      {title: 'T', sections: [{name: 3}]},
      '/sections/0/name: expected a string',
    ],
    [
      'item without name',
      {title: 'T', sections: [{name: 'S', items: [{amount: 1}]}]},
      '/sections/0/items/0/name: required',
    ],
    [
      '"amount": null',
      {title: 'T', sections: [{name: 'S', items: [{name: 'A', amount: null}]}]},
      '/sections/0/items/0/amount: expected a number or a string, not null',
    ],
    [
      '"aliases": "milk"',
      {title: 'T', sections: [{name: 'S', items: [{name: 'A', aliases: 'milk'}]}]},
      '/sections/0/items/0/aliases: expected an array of strings',
    ],
    [
      '"done": "yes"',
      {title: 'T', sections: [{name: 'S', items: [{name: 'A', done: 'yes'}]}]},
      '/sections/0/items/0/done: expected a boolean',
    ],
  ];

  it.each(cases)('%s -> %s', (_label, json, expected) => {
    const result = parseList(JSON.stringify(json));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain(expected);
    // LIST.md §5/§6: no partial import — an error result carries no list at all.
    expect(result).not.toHaveProperty('list');
  });

  it('rejects malformed JSON and non-object roots with a pointer', () => {
    expect(parseList('{"title": ').ok).toBe(false);
    expect(parseList('[]').ok).toBe(false);
    expect(parseList('null').ok).toBe(false);
    const malformed = parseList('{"title": ');
    expect(malformed.ok === false && malformed.errors[0]).toMatch(/^\/: not valid JSON/);
  });

  it('rejects null for items/sections and blank titles', () => {
    expect(ok({title: '  ', sections: []}).ok).toBe(false);
    expect(
      ok({title: 'T', sections: [{name: 'S', items: null}]}).ok,
    ).toBe(false);
    expect(
      ok({title: 'T', sections: [{name: 'S', sections: null}]}).ok,
    ).toBe(false);
  });
});

describe('amount union — never coerced (LIST.md §3/§4)', () => {
  it('a quoted "3" stays text, a bare 3 stays a number', () => {
    const result = ok({
      title: 'T',
      sections: [
        {
          name: 'S',
          items: [
            {name: 'Quoted', amount: '3'},
            {name: 'Number', amount: 3},
            {name: 'Free text', amount: '2 packs'},
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const items = result.list.sections[0]?.items ?? [];
    expect(items[0]?.amount).toBe('3');
    expect(typeof items[0]?.amount).toBe('string');
    expect(items[1]?.amount).toBe(3);
    expect(typeof items[1]?.amount).toBe('number');
    expect(items[2]?.amount).toBe('2 packs');
  });

  it('rejects a non-finite number (1e999 parses to Infinity in JS)', () => {
    const result = parseList(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"A","amount":1e999}]}]}',
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual([
      '/sections/0/items/0/amount: expected a finite number or a string',
    ]);
  });

  it('treats a blank amount/unit string as absent', () => {
    const result = ok({
      title: 'T',
      sections: [{name: 'S', items: [{name: 'A', amount: '   ', unit: ' '}]}],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const item = result.list.sections[0]?.items?.[0];
    expect(item?.amount).toBeUndefined();
    expect(item?.unit).toBeUndefined();
  });
});

describe('unknown fields (LIST.md §1: readers ignore them)', () => {
  it('ignores unknown fields at every level', () => {
    const result = ok({
      title: 'T',
      colour: 'teal',
      sections: [
        {
          name: 'S',
          emoji: '🥬',
          items: [{name: 'A', price: 1.5, wasDone: false, aliases: ['a1', '  ']}],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const list = result.list as unknown as Record<string, unknown>;
    expect(list).not.toHaveProperty('colour');
    expect(result.list.sections[0]).not.toHaveProperty('emoji');
    expect(result.list.sections[0]?.items?.[0]).not.toHaveProperty('price');
    // Blank alias entries are ignored, non-blank kept verbatim (LIST.md §3).
    expect(result.list.sections[0]?.items?.[0]?.aliases).toEqual(['a1']);
  });
});
