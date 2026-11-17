/**
 * The render tree + tick/untick (card A2).
 *
 * `buildListTree` joins ts-core's flattened items onto the imported tree by position; `withItemDone`
 * rebuilds the tree with the SAME positional ids. Both are pinned here: ids/order equal `flatten`,
 * duplicate names in one section stay distinct, duplicate explicit ids get the `~2` suffix, and a
 * tick can only ever flip the row it names.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {flatten, parseList} from '../core';
import type {ScanList} from '../core';
import {amountText, buildListTree, displayText, findItem, formatJsonNumber, isEmptyList} from '../view';
import type {SectionNode} from '../view';
import {toggleItem, withItemDone} from '../edit';

const repoRoot = join(__dirname, '../../../../..');

function sampleText(file: string): string {
  return readFileSync(join(repoRoot, 'shared/spec/samples', file), 'utf8');
}

function parseOrThrow(text: string): ScanList {
  const parsed = parseList(text);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('; '));
  }
  return parsed.list;
}

function treeIds(sections: SectionNode[]): string[] {
  const out: string[] = [];
  const walk = (section: SectionNode) => {
    section.items.forEach(node => out.push(node.flat.id));
    section.sections.forEach(walk);
  };
  sections.forEach(walk);
  return out;
}

describe('buildListTree', () => {
  it('joins ts-core ids onto the tree in flatten order', () => {
    const list = parseOrThrow(sampleText('van-weekly.json'));
    const tree = buildListTree(list);
    const flat = flatten(list);

    expect(treeIds(tree.sections)).toEqual(flat.map(item => item.id));
    expect(tree.total).toBe(flat.length);
    expect(tree.done).toBe(flat.filter(item => item.done).length);
    expect(tree.title).toBe(list.title);
    expect(tree.version).toBe(1);
    expect(isEmptyList(tree)).toBe(false);
  });

  it('counts ticked and total items per section subtree', () => {
    const list = parseOrThrow(sampleText('van-weekly.json'));
    const tree = buildListTree(list);
    const root = tree.sections[0] as SectionNode;
    expect(root.total).toBeGreaterThan(root.items.length);
    expect(root.done).toBe(
      flatten(list).filter(item => item.done).length,
    );
    root.sections.forEach(child => {
      expect(child.done).toBeLessThanOrEqual(child.total);
    });
  });

  it('handles an empty list without crashing (LIST.md §1)', () => {
    const tree = buildListTree(parseOrThrow('{"title":"Empty","sections":[]}'));
    expect(tree.total).toBe(0);
    expect(isEmptyList(tree)).toBe(true);
    expect(tree.sections).toEqual([]);
  });

  it('keeps sibling sections with identical names distinct', () => {
    const list = parseOrThrow(
      JSON.stringify({
        title: 'Dupes',
        sections: [
          {name: 'Fresh', items: [{name: 'Milk'}]},
          {name: 'Fresh', items: [{name: 'Milk'}]},
        ],
      }),
    );
    const tree = buildListTree(list);
    const ids = treeIds(tree.sections);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(flatten(list).map(item => item.id));
  });
});

describe('findItem / display helpers', () => {
  it('finds an item by id and returns null for an unknown id', () => {
    const list = parseOrThrow(
      '{"title":"T","sections":[{"name":"S","items":[{"name":"Bread"}]}]}',
    );
    const tree = buildListTree(list);
    const id = flatten(list)[0]?.id as string;
    expect(findItem(tree, id)?.flat.name).toBe('Bread');
    expect(findItem(tree, 'sha1:does-not-exist')).toBeNull();
  });

  it('renders amount + unit per LIST.md §4', () => {
    const cases: Array<[number | string | null, string | null, string]> = [
      [6, null, '6'],
      [1, 'kg', '1 kg'],
      ['2 packs', null, '2 packs'],
      [0.5, 'l', '0.5 l'],
      [null, 'kg', ''],
    ];
    cases.forEach(([amount, unit, expected]) => {
      expect(displayText({amount, unit})).toBe(expected);
    });
    expect(amountText(-2)).toBe('-2');
    expect(formatJsonNumber(6)).toBe('6');
    expect(formatJsonNumber(0.5)).toBe('0.5');
  });
});

describe('tick / untick by flattened id', () => {
  const list = parseOrThrow(
    JSON.stringify({
      title: 'Dupes',
      sections: [
        {
          name: 'Fresh',
          items: [
            {name: 'Milk', amount: 2},
            {name: 'Milk', amount: 3},
          ],
        },
        {name: 'Frozen', items: [{name: 'Milk', amount: 4}]},
      ],
    }),
  );
  const flat = flatten(list);

  it('gives the three Milks three distinct ids', () => {
    expect(new Set(flat.map(item => item.id)).size).toBe(3);
  });

  it('ticks only the named row, then untick restores it', () => {
    const second = flat[1]?.id as string;
    const ticked = withItemDone(list, second, true);
    expect(ticked).not.toBeNull();
    if (!ticked) {
      return;
    }
    const tickedFlat = flatten(ticked);
    expect(tickedFlat.filter(item => item.done).map(item => item.id)).toEqual([second]);
    // Untouched fields survive, ids are unchanged by the edit.
    expect(tickedFlat.map(item => item.id)).toEqual(flat.map(item => item.id));
    expect(tickedFlat[1]?.amount).toBe(3);

    const unticked = withItemDone(ticked, second, false);
    expect(unticked && flatten(unticked).every(item => !item.done)).toBe(true);
  });

  it('toggleItem flips the current state and returns null for an unknown id', () => {
    const target = flat[2]?.id as string;
    const first = toggleItem(list, target);
    expect(first && flatten(first).find(item => item.id === target)?.done).toBe(true);
    const second = toggleItem(first as ScanList, target);
    expect(second && flatten(second).find(item => item.id === target)?.done).toBe(false);
    expect(toggleItem(list, 'sha1:nope')).toBeNull();
  });

  it('never removes an item when ticking (LIST.md §3)', () => {
    const ticked = withItemDone(list, flat[0]?.id as string, true) as ScanList;
    expect(flatten(ticked)).toHaveLength(flat.length);
  });

  it('renames duplicate explicit ids like flatten does (FLATTEN.md §3.3)', () => {
    const dupes = parseOrThrow(
      JSON.stringify({
        title: 'T',
        sections: [
          {
            name: 'S',
            items: [
              {id: 'milk', name: 'Milk'},
              {id: 'milk', name: 'Milk'},
            ],
          },
        ],
      }),
    );
    expect(flatten(dupes).map(item => item.id)).toEqual(['milk', 'milk~2']);
    const second = withItemDone(dupes, 'milk~2', true) as ScanList;
    // The rebuild keeps the same ids, so the tick landed on the second item.
    expect(flatten(second).map(item => [item.id, item.done])).toEqual([
      ['milk', false],
      ['milk~2', true],
    ]);
  });

  it('finds a duplicate by id in the render tree', () => {
    const tree = buildListTree(list);
    const ids = treeIds(tree.sections);
    expect(findItem(tree, ids[1] as string)?.item.amount).toBe(3);
  });
});
