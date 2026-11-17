/**
 * A render-level smoke test for the nested list screen (card A2).
 *
 * The card's rule is "UI thin over tested logic", so this test does not re-verify parsing or
 * persistence: it proves the screen renders the imported tree (top-level section headings and item
 * rows, with amount rows), expands a nested section on a header press, and routes a row press
 * through the repository by flattened id — the wiring the logic tests cannot see.
 */
import React from 'react';
import {readFileSync} from 'fs';
import {join} from 'path';
import ReactTestRenderer from 'react-test-renderer';
import {PaperProvider} from 'react-native-paper';
import {lightTheme} from '../../theme';
import {flatten} from '../core';
import {ListRepository, MemoryKeyValueStore} from '../store';
import {ListDetailScreen} from '../ui/ListDetailScreen';

jest.mock('react-native/Libraries/Vibration/Vibration', () => ({
  __esModule: true,
  default: {vibrate: jest.fn(), cancel: jest.fn()},
}));

jest.useFakeTimers();

const repoRoot = join(__dirname, '../../../../..');

async function importedVanWeekly() {
  const store = new MemoryKeyValueStore();
  const repository = new ListRepository(store, () => 1_700_000_000_000);
  const text = readFileSync(
    join(repoRoot, 'shared/spec/samples/van-weekly.json'),
    'utf8',
  );
  const result = await repository.importText(text);
  if (!result.ok) {
    throw new Error(result.errors.join('; '));
  }
  return {repository, stored: result.stored};
}

function render(repository: ListRepository, stored: Awaited<ReturnType<typeof importedVanWeekly>>['stored'], onChanged: (updated: typeof stored) => void) {
  return (
    <PaperProvider theme={lightTheme}>
      <ListDetailScreen
        repository={repository}
        stored={stored}
        onBack={() => undefined}
        onChanged={onChanged}
      />
    </PaperProvider>
  );
}

test('renders the imported tree and expands a nested section', async () => {
  const {repository, stored} = await importedVanWeekly();
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(render(repository, stored, () => undefined));
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });

  const collapsed = JSON.stringify(tree?.toJSON());
  expect(collapsed).toContain('Van weekly shop');
  expect(collapsed).toContain('Fresh');
  expect(collapsed).toContain('Fruit & veg');
  expect(collapsed).toContain('Dairy');
  // Top-level items render with amount + unit (LIST.md §4).
  expect(collapsed).toContain('2 packs');

  // Nested sections start collapsed; the header press opens one.
  const headers = tree?.root.findAll(
    node =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Fruit & veg',
  );
  expect(headers?.length).toBeGreaterThan(0);
  await ReactTestRenderer.act(async () => {
    headers?.[0]?.props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });

  const expanded = JSON.stringify(tree?.toJSON());
  expect(expanded).toContain('Bananas');
  expect(expanded).toContain('Tomatoes');
  expect(expanded).toContain('Export');

  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  jest.clearAllTimers();
});

test('pressing a row ticks it through the repository', async () => {
  const {repository, stored} = await importedVanWeekly();

  let changed: typeof stored | null = null;
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      render(repository, stored, updated => {
        changed = updated;
      }),
    );
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });

  const rows = tree?.root.findAll(
    node => node.props.accessibilityRole === 'checkbox',
  );
  expect(rows?.length).toBeGreaterThan(0);
  const row = rows?.[0];
  const name = String(row?.props.accessibilityLabel).split(',')[0];
  await ReactTestRenderer.act(async () => {
    row?.props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });

  expect(changed).not.toBeNull();
  const persisted = await repository.get(stored.id);
  const flat = persisted ? flatten(persisted.list) : [];
  expect(flat.length).toBeGreaterThan(0);
  expect(flat.find(item => item.name === name)?.done).toBe(true);

  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  jest.clearAllTimers();
});
