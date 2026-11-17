/**
 * Flatten parity with the shared golden fixture (card A2 Done-when: "Jest tests over shared samples").
 *
 * The fixture is model-free: `shared/fixtures/golden.json` stores the FLATTEN.md output for all four
 * `shared/spec/samples/*.json` — ids byte-exact, order, every field — plus a synthetic
 * "photo corpus" merged list. The app consumes `flatten` from `@scanlist/ts-core`; this test proves
 * the version the RN app actually imports reproduces that fixture and the §3/§4 worked values, so
 * the tree UI, the tick ids and (later) A4's ranking all rest on the pinned output.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {docText, flatten, parseList} from '../core';
import type {FlattenedItem} from '../core';

const repoRoot = join(__dirname, '../../../../..');
const samplesDir = join(repoRoot, 'shared/spec/samples');
const golden = JSON.parse(
  readFileSync(join(repoRoot, 'shared/fixtures/golden.json'), 'utf8'),
) as {
  lists: Array<{
    id: string;
    source: string;
    title: string;
    itemCount: number;
    items: FlattenedItem[];
  }>;
};

const SAMPLES = [
  'van-weekly.json',
  'string-amounts.json',
  'aliases-es-cz.json',
  'deep-nesting.json',
];

function parseSample(file: string) {
  const text = readFileSync(join(samplesDir, file), 'utf8');
  const parsed = parseList(text);
  if (!parsed.ok) {
    throw new Error(`${file}: ${parsed.errors.join('; ')}`);
  }
  return parsed.list;
}

function goldenFor(file: string) {
  const entry = golden.lists.find(
    list => list.source === `shared/spec/samples/${file}`,
  );
  if (!entry) {
    throw new Error(`golden.json has no list for ${file}`);
  }
  return entry;
}

describe('flatten parity with shared/fixtures/golden.json', () => {
  it.each(SAMPLES)('%s parses and matches the golden snapshots byte for byte', file => {
    const list = parseSample(file);
    const flat = flatten(list);
    const expected = goldenFor(file);

    expect(flat).toEqual(expected.items);
    expect(flat).toHaveLength(expected.itemCount);
    expect(flat.map(item => item.id)).toEqual(expected.items.map(item => item.id));
    expect(flat.map(item => item.name)).toEqual(expected.items.map(item => item.name));
    flat.forEach((item, index) => {
      expect(item.order).toBe(index);
    });
  });

  it('covers every sample of the golden fixture (44 items in the photo corpus)', () => {
    const allIds = SAMPLES.flatMap(file => flatten(parseSample(file)).map(i => i.id));
    expect(new Set(allIds).size).toBe(44);
    const corpus = golden.lists.find(list => list.id === 'photo-corpus');
    expect(corpus?.itemCount).toBe(44);
    // Every sample item appears in the merged corpus with the same id (it is prefixed by a section,
    // so its derived id differs — compare names+amounts instead, which the fixture stores).
    const corpusNames = (corpus?.items ?? []).map(
      item => `${item.name}|${String(item.amount)}|${item.unit ?? ''}`,
    );
    SAMPLES.forEach(file => {
      flatten(parseSample(file)).forEach(item => {
        expect(corpusNames).toContain(
          `${item.name}|${String(item.amount)}|${item.unit ?? ''}`,
        );
      });
    });
  });
});

describe('FLATTEN.md §3/§4 worked values', () => {
  it('derives the documented sha1 ids, including an explicit id and a 4-deep path', () => {
    const flat = flatten(parseSample('van-weekly.json'));
    const bananas = flat.find(item => item.name === 'Bananas');
    expect(bananas?.id).toBe('sha1:998e2c1acb80597f39892b85f9dfa8726ead298e');
    const tomatoes = flat.find(item => item.name === 'Tomatoes');
    expect(tomatoes?.id).toBe('sha1:801b3e63df7a42974bc5f11b4a342251f8c04ba3');

    const deep = flatten(parseSample('deep-nesting.json'));
    const cumin = deep.find(item => item.name === 'Cumin');
    expect(cumin?.id).toBe('spice-cumin');
    expect(cumin?.path).toEqual(['Home', 'Kitchen', 'Pantry', 'Spices']);
  });

  it('builds docText as "name; aliases; section > path" and never includes the note', () => {
    const flat = flatten(parseSample('van-weekly.json'));
    const byName = (name: string) => flat.find(item => item.name === name);
    expect(docText(byName('Bananas') as FlattenedItem)).toBe(
      'Bananas; Fresh > Fruit & veg',
    );
    expect(docText(byName('Tomatoes') as FlattenedItem)).toBe(
      'Tomatoes; tomates; Fresh > Fruit & veg',
    );
    expect(docText(byName('Oat milk') as FlattenedItem)).toBe(
      'Oat milk; bebida de avena; Fresh > Dairy',
    );

    const deep = flatten(parseSample('deep-nesting.json'));
    const paprika = deep.find(item => item.name === 'Smoked paprika');
    expect(paprika?.note).toBe('top up before the chili');
    expect(docText(paprika as FlattenedItem)).not.toContain('chili');
  });

  it('keeps free-text amounts as text and numbers as numbers after flattening', () => {
    const flat = flatten(parseSample('string-amounts.json'));
    const texts = flat.filter(item => typeof item.amount === 'string');
    const numbers = flat.filter(item => typeof item.amount === 'number');
    expect(texts.length).toBeGreaterThan(0);
    expect(numbers.length).toBeGreaterThan(0);
    flat.forEach(item => {
      if (item.amount !== null) {
        expect(['string', 'number']).toContain(typeof item.amount);
      }
    });
  });
});
