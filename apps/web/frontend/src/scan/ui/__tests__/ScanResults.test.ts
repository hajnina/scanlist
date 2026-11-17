// @vitest-environment happy-dom
/**
 * Card C5 — the scan results panel renders decideTop's output and nothing more.
 *
 * Hero present → one big tick affordance; hero null → the honest "no confident match" card with no
 * tick button. Chips and rows are presentation of the controller's state.
 *
 * happy-dom + the `ElementInternals` shim for the same reason as C2's app.test.ts: @material/web is
 * Lit-based and calls `attachInternals()` from its constructor.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";

import { ScanResults } from "../ScanResults";
import type { ScanRow } from "../ranking";
import type { ScanUiState } from "../controller";

function installElementInternalsShim(): void {
  const proto = HTMLElement.prototype as unknown as { attachInternals?: () => ElementInternals };
  if (typeof proto.attachInternals === "function") return;
  const states = { add() {}, delete() {}, has: () => false, clear() {}, forEach() {} };
  proto.attachInternals = () =>
    ({
      form: null,
      labels: [],
      states,
      willValidate: false,
      validity: { valid: true },
      validationMessage: "",
      setFormValue() {},
      setValidity() {},
      checkValidity: () => true,
      reportValidity: () => true,
    }) as unknown as ElementInternals;
}

installElementInternalsShim();

let root: HTMLDivElement | null = null;

function mount(state: ScanUiState, onTick = vi.fn()): ReturnType<typeof vi.fn> {
  root = document.createElement("div");
  document.body.append(root);
  render(h(ScanResults, { state, onTick }), root);
  return onTick;
}

afterEach(() => {
  if (root !== null) render(null, root);
  root = null;
  document.body.innerHTML = "";
});

function text(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function row(overrides: Partial<ScanRow> & { id: string; name: string }): ScanRow {
  return {
    amount: "",
    note: null,
    done: false,
    score: null,
    isHero: false,
    ...overrides,
  };
}

function state(overrides: Partial<ScanUiState> = {}): ScanUiState {
  return {
    phase: "ready",
    rows: [
      row({ id: "milk", name: "Milk", amount: "1 l", score: 0.83, isHero: true }),
      row({ id: "bread", name: "Bread", score: 0.71 }),
      row({ id: "eggs", name: "Eggs", score: null, done: true }),
    ],
    hero: row({ id: "milk", name: "Milk", amount: "1 l", score: 0.83, isHero: true }),
    ranked: true,
    heroStatus: "similarity 0.83 · never auto-ticked",
    chips: [
      { key: "barcode", label: "BARCODE", detail: "3017620422003", active: true },
      { key: "off", label: "OFF", detail: "found", active: true },
      { key: "ocr", label: "OCR", detail: "2 lines", active: true },
      { key: "image", label: "IMAGE", detail: "—", active: false },
      { key: "queries", label: "QUERIES", detail: "3/16", active: true },
    ],
    queries: { text: 3, image: 0, max: 16, pending: 0 },
    prepared: { done: 3, total: 3 },
    barcode: null,
    error: null,
    ...overrides,
  };
}

describe("ScanResults — hero card", () => {
  it("shows the hero from decideTop with one big tick button", () => {
    const onTick = mount(state());

    expect(text()).toContain("BEST MATCH");
    expect(text()).toContain("similarity 0.83");
    const tick = document.querySelector("md-filled-button");
    expect(tick?.textContent).toBe("Tick Milk");

    tick?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0]?.[0]).toMatchObject({ id: "milk", name: "Milk" });
  });

  it("renders the null hero honestly: no tick button, gate explanation", () => {
    mount(
      state({
        hero: null,
        ranked: true,
        heroStatus: "Nothing is a confident match yet — keep scanning or tick from the list.",
        rows: [row({ id: "milk", name: "Milk", score: 0.8 }), row({ id: "bread", name: "Bread", score: 0.78 })],
      }),
    );

    expect(text()).toContain("NO CONFIDENT MATCH");
    expect(text()).toContain("Nothing is a confident match");
    expect(document.querySelector("md-filled-button")).toBeNull();
    expect(text()).toContain("never ticks anything");
  });

  it("shows item-embedding progress before the first hero", () => {
    mount(
      state({
        phase: "preparing",
        hero: null,
        ranked: false,
        rows: [],
        prepared: { done: 1, total: 4 },
        heroStatus: "",
      }),
    );

    expect(text()).toContain("READING YOUR LIST");
    expect(text()).toContain("1/4");
    const fill = document.querySelector<HTMLElement>(".progress-fill");
    expect(fill?.style.width).toBe("25%");
  });

  it("shows the last committed name as a short confirmation", () => {
    root = document.createElement("div");
    document.body.append(root);
    render(h(ScanResults, { state: state(), onTick: vi.fn(), lastTick: "Milk" }), root);
    expect(text()).toContain("Ticked Milk");
  });
});

describe("ScanResults — chips and rows", () => {
  it("lights only the live sources", () => {
    mount(state());
    const active = Array.from(document.querySelectorAll(".scan-chip.is-active")).map((chip) =>
      chip.getAttribute("data-source"),
    );
    expect(active).toEqual(["barcode", "off", "ocr", "queries"]);
    expect(text()).toContain("3017620422003");
    expect(text()).toContain("2 lines");
    expect(text()).toContain("3/16");
  });

  it("keeps rank order, scores and done styling", () => {
    mount(state());
    const names = Array.from(document.querySelectorAll(".scan-row .item-name")).map(
      (element) => element.textContent,
    );
    expect(names).toEqual(["Milk", "Bread", "Eggs"]);

    const scores = Array.from(document.querySelectorAll(".scan-score")).map((element) => element.textContent);
    // Done rows never show a score (they are outside the ranking).
    expect(scores).toEqual(["0.83", "0.71"]);
    expect(document.querySelector(".scan-row.is-done .item-name")?.textContent).toBe("Eggs");
    expect(document.querySelector(".scan-row.is-hero .item-name")?.textContent).toBe("Milk");
    expect(document.querySelector(".amount")?.textContent).toBe("1 l");
  });

  it("explains an empty list", () => {
    mount(state({ rows: [], hero: null, ranked: false }));
    expect(text()).toContain("This list has no items to rank yet");
  });
});
