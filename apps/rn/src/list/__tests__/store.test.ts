/**
 * Persistence round-trip (card A2): import -> tick/untick -> reload -> export.
 *
 * The store writes the EXPORT document under `scanlist/list/<id>` (B2 precedent: one file per list
 * whose contents ARE the export), so these tests assert byte equality between the stored value and
 * `exportJson`, not a separate storage format. Corrupt input is skipped, never partially loaded
 * (LIST.md §5), and the index is a rebuildable cache rather than a source of truth.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {flatten, parseList} from '../core';
import type {ScanList} from '../core';
import {encodeList} from '../encode';
import {
  INDEX_STORAGE_KEY,
  ListRepository,
  MemoryKeyValueStore,
  isValidId,
  storageKeyFor,
} from '../store';

const repoRoot = join(__dirname, '../../../../..');

function sampleText(file: string): string {
  return readFileSync(join(repoRoot, 'shared/spec/samples', file), 'utf8');
}

function clock(start = 1_700_000_000_000) {
  let value = start;
  return () => (value += 1000);
}

describe('ListRepository — import and export', () => {
  it('imports every shared sample and stores the export document verbatim', async () => {
    const store = new MemoryKeyValueStore();
    const repository = new ListRepository(store, clock());

    const files = [
      'van-weekly.json',
      'string-amounts.json',
      'aliases-es-cz.json',
      'deep-nesting.json',
    ];
    for (const file of files) {
      const result = await repository.importText(sampleText(file));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      const exported = await repository.exportJson(result.stored.id);
      expect(await repository.storedDocument(result.stored.id)).toBe(exported);
      expect(exported).toBe(encodeList(result.stored.list));
      // The stored document re-imports to the same list.
      const reparsed = parseList(exported as string);
      expect(reparsed.ok && reparsed.list).toEqual(result.stored.list);
    }

    const lists = await repository.loadAll();
    expect(lists).toHaveLength(4);
    // Newest first (the lists screen order).
    expect(lists[0]?.list.title).toBe('Deep pantry audit');
  });

  it('rejects invalid JSON without writing anything (no partial import)', async () => {
    const store = new MemoryKeyValueStore();
    const repository = new ListRepository(store);

    const result = await repository.importText(
      '{"title":"Broken","sections":[{"name":"S","items":[{"amount":1}]}]}',
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual(['/sections/0/items/0/name: required']);
    expect(await repository.loadAll()).toEqual([]);
    expect(await repository.ids()).toEqual([]);
  });

  it('imports the same list twice under two ids (LIST.md §6: no dedupe)', async () => {
    const repository = new ListRepository(new MemoryKeyValueStore(), clock());
    const text = sampleText('van-weekly.json');
    const first = await repository.importText(text);
    const second = await repository.importText(text);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.stored.id).toBe('van-weekly-shop');
    expect(second.stored.id).toBe('van-weekly-shop-2');
    expect(await repository.ids()).toEqual([
      'van-weekly-shop',
      'van-weekly-shop-2',
    ]);
  });
});

describe('ListRepository — tick and untick', () => {
  async function importVanWeekly() {
    const store = new MemoryKeyValueStore();
    const repository = new ListRepository(store, clock());
    const imported = await repository.importText(sampleText('van-weekly.json'));
    if (!imported.ok) {
      throw new Error(imported.errors.join('; '));
    }
    return {store, repository, stored: imported.stored};
  }

  it('persists a tick and a later untick, with ids stable across reloads', async () => {
    const {repository, stored, store} = await importVanWeekly();
    const bananas = flatten(stored.list).find(item => item.name === 'Bananas');
    const id = bananas?.id as string;

    const ticked = await repository.toggle(stored.id, id);
    expect(ticked).not.toBeNull();
    const tickedList = ticked?.list as ScanList;
    expect(flatten(tickedList).find(item => item.id === id)?.done).toBe(true);

    // The stored value is the export document, done flag included.
    expect(await repository.storedDocument(stored.id)).toBe(encodeList(tickedList));
    expect(await repository.exportJson(stored.id)).toContain('"done": true');

    // A fresh repository over the same bytes (an app restart) sees the tick.
    const restarted = new ListRepository(store, clock());
    const reloaded = await restarted.get(stored.id);
    expect(reloaded?.list).toEqual(tickedList);

    const unticked = await restarted.toggle(stored.id, id);
    expect(unticked && flatten(unticked.list).every(item => !item.done)).toBe(true);
    expect(await restarted.exportJson(stored.id)).not.toContain('"done"');
  });

  it('never removes a ticked item from storage (LIST.md §3)', async () => {
    const {repository, stored} = await importVanWeekly();
    const before = flatten(stored.list).length;
    for (const item of flatten(stored.list)) {
      await repository.toggle(stored.id, item.id);
    }
    const allDone = await repository.get(stored.id);
    expect(allDone && flatten(allDone.list)).toHaveLength(before);
    expect(allDone && flatten(allDone.list).every(item => item.done)).toBe(true);
  });

  it('returns null for unknown lists and unknown item ids', async () => {
    const {repository, stored} = await importVanWeekly();
    expect(await repository.toggle(stored.id, 'sha1:nope')).toBeNull();
    expect(await repository.toggle('no-such-list', 'sha1:nope')).toBeNull();
    expect(await repository.exportJson('no-such-list')).toBeNull();
    expect(await repository.get('../etc/passwd')).toBeNull();
  });

  it('reports totals across all lists', async () => {
    const repository = new ListRepository(new MemoryKeyValueStore(), clock());
    await repository.importText(sampleText('van-weekly.json'));
    const second = await repository.importText(sampleText('deep-nesting.json'));
    expect(second.ok).toBe(true);
    const totals = await repository.totals();
    expect(totals.total).toBe(20);
    // deep-nesting.json ships two ticked items, van-weekly.json none.
    expect(totals.done).toBe(2);
  });
});

describe('ListRepository — corrupt data and index recovery', () => {
  it('skips a corrupt document instead of failing the screen, and prunes the index', async () => {
    const store = new MemoryKeyValueStore();
    const repository = new ListRepository(store, clock());
    const good = await repository.importText(sampleText('van-weekly.json'));
    expect(good.ok).toBe(true);

    // Write a truncated / non-JSON document as if a previous run died mid-write.
    await store.setItem(storageKeyFor('broken'), '{"title": "Broken", "sections": [');
    await store.setItem(
      INDEX_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {id: 'broken', updatedAt: 2},
          ...(good.ok ? [{id: good.stored.id, updatedAt: 1}] : []),
        ],
      }),
    );

    const lists = await repository.loadAll();
    expect(lists.map(entry => entry.id)).toEqual([good.ok ? good.stored.id : '']);
    expect(await repository.get('broken')).toBeNull();
    // The index no longer advertises the corrupt list.
    const index = JSON.parse((await store.getItem(INDEX_STORAGE_KEY)) as string) as {
      entries: Array<{id: string}>;
    };
    expect(index.entries.map(entry => entry.id)).toEqual([
      good.ok ? good.stored.id : '',
    ]);
  });

  it('rebuilds a missing index from the keys', async () => {
    const store = new MemoryKeyValueStore();
    const repository = new ListRepository(store, clock());
    const imported = await repository.importText(sampleText('string-amounts.json'));
    expect(imported.ok).toBe(true);
    await store.removeItem(INDEX_STORAGE_KEY);

    const lists = await repository.loadAll();
    expect(lists).toHaveLength(1);
    expect(lists[0]?.id).toBe(imported.ok ? imported.stored.id : '');
    // The rebuild wrote the index back.
    expect(await store.getItem(INDEX_STORAGE_KEY)).not.toBeNull();
  });

  it('rebuilds a corrupt index rather than throwing', async () => {
    const store = new MemoryKeyValueStore();
    const repository = new ListRepository(store, clock());
    await repository.importText(sampleText('string-amounts.json'));
    await store.setItem(INDEX_STORAGE_KEY, 'not json at all');
    const lists = await repository.loadAll();
    expect(lists).toHaveLength(1);
  });

  it('ignores keys that are not list documents (path-shaped ids)', async () => {
    const store = new MemoryKeyValueStore();
    const repository = new ListRepository(store);
    await store.setItem('scanlist/list/../../evil', sampleText('van-weekly.json'));
    await store.setItem('scanlist/other', '{}');
    expect(await repository.ids()).toEqual([]);
    expect(isValidId('../../evil')).toBe(false);
  });
});

describe('ListRepository — delete', () => {
  it('removes a list and its index entry', async () => {
    const repository = new ListRepository(new MemoryKeyValueStore(), clock());
    const imported = await repository.importText(sampleText('van-weekly.json'));
    if (!imported.ok) {
      throw new Error(imported.errors.join('; '));
    }
    expect(await repository.remove(imported.stored.id)).toBe(true);
    expect(await repository.get(imported.stored.id)).toBeNull();
    expect(await repository.loadAll()).toEqual([]);
    expect(await repository.remove(imported.stored.id)).toBe(false);
  });
});
