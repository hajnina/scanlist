/**
 * Export round-trip (card A2 Done-when): import -> export -> import is the same list.
 *
 * LIST.md §7: the exported document is the same JSON shape, `done` on ticked items, order and
 * nesting preserved, free-text amounts and aliases untouched, ids only when explicit. The persisted
 * value IS this document (see store.ts), so what is checked here is also what survives an app
 * restart.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {parseList} from '../core';
import type {ScanList} from '../core';
import {encodeList, fileNameFor, toDocument} from '../encode';
import {withItemDone} from '../edit';

const repoRoot = join(__dirname, '../../../../..');
const SAMPLES = [
  'van-weekly.json',
  'string-amounts.json',
  'aliases-es-cz.json',
  'deep-nesting.json',
];

function parseText(text: string): ScanList {
  const parsed = parseList(text);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('; '));
  }
  return parsed.list;
}

function sample(file: string): ScanList {
  return parseText(readFileSync(join(repoRoot, 'shared/spec/samples', file), 'utf8'));
}

describe('LIST.md §7 round trip', () => {
  it.each(SAMPLES)('%s: import -> export -> import is equal', file => {
    const first = sample(file);
    const exported = encodeList(first);
    const second = parseText(exported);
    expect(second).toEqual(first);
    // And the export is stable: exporting the re-imported list is byte-identical.
    expect(encodeList(second)).toBe(exported);
  });

  it('exports the normative top-level shape', () => {
    const doc = toDocument(sample('van-weekly.json')) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['title', 'version', 'sections']);
    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.sections)).toBe(true);
  });

  it('round-trips after ticking: only done flags differ', () => {
    const original = sample('van-weekly.json');

    // Tick two items by their flattened ids (Bananas; Tomatoes was already done).
    const ids = [
      'sha1:998e2c1acb80597f39892b85f9dfa8726ead298e',
      'sha1:801b3e63df7a42974bc5f11b4a342251f8c04ba3',
    ];
    let edited: ScanList = original;
    ids.forEach(id => {
      const next = withItemDone(edited, id, true);
      if (next) {
        edited = next;
      }
    });

    const reparsed = parseText(encodeList(edited));
    // Same tree, same order: only `done` differs from the imported document.
    expect(reparsed.sections.length).toBe(original.sections.length);
    expect(reparsed.title).toBe(original.title);
    expect(encodeList(reparsed)).toBe(encodeList(edited));

    const doneNames: string[] = [];
    const collect = (section: ScanList['sections'][number]) => {
      (section.items ?? []).forEach(item => {
        if (item.done) {
          doneNames.push(item.name);
        }
      });
      (section.sections ?? []).forEach(collect);
    };
    reparsed.sections.forEach(collect);
    expect(doneNames).toContain('Bananas');
    expect(doneNames).toContain('Tomatoes');
    // Everything that was not ticked is untouched: names and amounts in order.
    expect(reparsed.sections[0]?.sections?.[0]?.items?.[0]?.amount).toBe(6);
  });
});

describe('field rules', () => {
  it('a quoted "3" is exported as the string "3" (never coerced)', () => {
    const list = parseText(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"A","amount":"3"},{"name":"B","amount":3}]}]}',
    );
    const doc = JSON.parse(encodeList(list)) as {
      sections: Array<{items: Array<{name: string; amount: unknown}>}>;
    };
    const items = doc.sections[0]?.items ?? [];
    expect(items[0]?.amount).toBe('3');
    expect(typeof items[0]?.amount).toBe('string');
    expect(items[1]?.amount).toBe(3);
    expect(typeof items[1]?.amount).toBe('number');
  });

  it('emits "done": true only on ticked items and drops unknown fields', () => {
    const list = parseText(
      '{"title":"T","colour":"teal","sections":[{"name":"S","items":[{"name":"A","done":true,"price":3},{"name":"B"}]}]}',
    );
    const text = encodeList(list);
    expect(text).not.toContain('colour');
    expect(text).not.toContain('price');
    expect(text.match(/"done"/g)).toHaveLength(1);
    const doc = JSON.parse(text) as {
      sections: Array<{items: Array<Record<string, unknown>>}>;
    };
    expect(doc.sections[0]?.items[0]).toEqual({name: 'A', done: true});
    expect(doc.sections[0]?.items[1]).toEqual({name: 'B'});
  });

  it('keeps declared item ids and drops absent optional fields', () => {
    const list = parseText(
      '{"title":"T","sections":[{"name":"S","items":[{"id":"milk","name":"Milk"}]}]}',
    );
    const doc = JSON.parse(encodeList(list)) as {
      sections: Array<{items: Array<Record<string, unknown>>}>;
    };
    expect(doc.sections[0]?.items[0]).toEqual({id: 'milk', name: 'Milk'});
  });

  it('suggests a slugged file name', () => {
    expect(fileNameFor('Van weekly shop')).toBe('van-weekly-shop.json');
    expect(fileNameFor('  Semana checa — Spanish & Czech aliases ')).toBe(
      'semana-checa-spanish-czech-aliases.json',
    );
    expect(fileNameFor('***')).toBe('scanlist.json');
  });
});
