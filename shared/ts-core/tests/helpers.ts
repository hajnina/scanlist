import type { FlattenedItem, RankItem } from "../src/types";

/** Assert a value is present (test helper for `noUncheckedIndexedAccess`). */
export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error("expected a value, got " + String(value));
  }
  return value;
}

/** Minimal FLATTEN.md item for ranker tests; `vec` is the only RANK.md input extra. */
export function makeItem(
  id: string,
  vec: number[] | null,
  overrides: Partial<FlattenedItem> = {},
): RankItem {
  const item: FlattenedItem = {
    id,
    name: id,
    amount: null,
    unit: null,
    note: null,
    aliases: [],
    done: false,
    path: [],
    pathText: "",
    index: 0,
    order: 0,
    ...overrides,
  };
  return { ...item, vec };
}
