// @vitest-environment happy-dom
/**
 * Card C5 — the Scan screen itself: camera session (mocked) → signals → rank tick → DOM.
 *
 * The ranker maths and the pool order are proven in `controller.test.ts`/`pool.test.ts`; this file
 * proves the *screen* obligations:
 *
 *  - a signal that arrives through C4's `onSignal` becomes a ranked row and a hero card;
 *  - nothing is committed automatically — the list only changes when the human ticks;
 *  - the hero button and the bottom scan-tick both go through C2's `onToggle` with the ORIGINAL
 *    `ScanListItem` (a `FlattenedItem` copy would persist nothing);
 *  - the null hero renders honestly and the tick affordance stays disabled;
 *  - no list → no camera, no session, an explicit "NO LIST OPEN" card;
 *  - a camera failure is classified and retryable;
 *  - the OCR toggle restarts the single-use session, and haptics go through `navigator.vibrate`;
 *  - the live chips describe the pool the ranker actually used.
 *
 * The session module is mocked because it needs a real `<video>`/camera (C4's own tests cover it);
 * everything below the seam — signals, the 400 ms tick, ts-core, the DOM — is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { h, render } from "preact";
import { docText, flatten } from "@scanlist/ts-core";
import type { ScanList, ScanListItem } from "@scanlist/ts-core";

import { SCAN_TICK_INTERVAL_MS, ScanScreen } from "../ScanScreen";
import * as flip from "../flip";
import type { ScanSessionOptions } from "../../sources/session";
import type { ScanSignal } from "../../sources/types";
import type { EmbedPort, EmbedResolution } from "../textEmbedder";
import type { OffPort } from "../offClient";
import { vec } from "./helpers";

/**
 * happy-dom has no `ElementInternals`; @material/web's Lit elements call `attachInternals()` from
 * their constructor (same shim as C2's `tests/app.test.ts`).
 */
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

const sessionMock = vi.hoisted(() => ({
  sessions: [] as Array<{
    options: unknown;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  /** Set to an error to make the NEXT session's `start()` reject (camera failure tests). */
  startError: null as unknown,
}));

vi.mock("../../sources/session", () => ({
  createScanSession: (options: unknown) => {
    const start = vi.fn(() =>
      sessionMock.startError === null
        ? Promise.resolve()
        : Promise.reject(sessionMock.startError),
    );
    const stop = vi.fn();
    sessionMock.sessions.push({ options, start, stop });
    return {
      start,
      stop,
      stats: () => ({ detector: "injected", upload: {}, bytes: {} }),
    };
  },
}));

// The real engine downloads Tesseract; the screen only needs to prove it asks for one and that a
// stopped session is replaced (the session owns/disposes the engine).
vi.mock("../../sources/ocrEngine", () => ({
  createTesseractEngine: vi.fn(() => ({ dispose: () => Promise.resolve() })),
}));

function sessionOptions(index = sessionMock.sessions.length - 1): ScanSessionOptions {
  const entry = sessionMock.sessions[index];
  if (entry === undefined) throw new Error(`no scan session #${index}`);
  return entry.options as ScanSessionOptions;
}

/** These tests run on real timers: the screen's cadence is the ranker's own 400 ms floor. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Preact runs effects after paint (rAF), so "mounted" is a couple of frames, not one microtask. */
const MOUNT = 60;

function makeList(names: string[]): ScanList {
  return { title: "Shop", sections: [{ name: "Shop", items: names.map((name) => ({ name })) }] };
}

function resolve(
  texts: readonly string[],
  cache: ReadonlyMap<string, number[]>,
): EmbedResolution {
  const vectors = new Map<string, number[]>();
  const pending: string[] = [];
  for (const text of texts) {
    const found = cache.get(text);
    if (found === undefined) pending.push(text);
    else vectors.set(text, found);
  }
  return { vectors, pending, failed: [] };
}

/** Synchronous fake of `POST /embed/text`: item docs on orthogonal axes, queries by raw text. */
function fakeEmbed(
  list: ScanList,
  queries: ReadonlyMap<string, number[]>,
): EmbedPort {
  const docs = new Map<string, number[]>();
  flatten(list).forEach((item, index) => docs.set(docText(item), vec({ [index]: 1 })));
  return {
    resolveDocs: (texts) => resolve(texts, docs),
    resolveQueries: (texts) => resolve(texts, queries),
    lastError: () => null,
    dispose: () => undefined,
  };
}

function fakeOff(table: Record<string, string> = {}): OffPort {
  return {
    lookup: (barcode) => {
      const text = table[barcode];
      return text === undefined
        ? { state: "none", text: null }
        : { state: "found", text };
    },
    dispose: () => undefined,
  };
}

function ocr(text: string, at = Date.now()): ScanSignal {
  return { source: "ocr", text, confidence: 0.9, at };
}

let root: HTMLDivElement | null = null;
let vibrate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionMock.sessions.length = 0;
  sessionMock.startError = null;
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", {
    value: vibrate,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (root !== null) render(null, root);
  root = null;
  document.body.innerHTML = "";
  delete (navigator as { vibrate?: unknown }).vibrate;
});

type ToggleMock = Mock<(item: ScanListItem) => void>;
type VoidMock = Mock<() => void>;

function mount(props: {
  list: ScanList | null;
  embed?: EmbedPort;
  off?: OffPort;
  onToggle?: ToggleMock;
  onBack?: VoidMock;
}): { onToggle: ToggleMock; onBack: VoidMock } {
  const onToggle = props.onToggle ?? vi.fn<(item: ScanListItem) => void>();
  const onBack = props.onBack ?? vi.fn<() => void>();
  root = document.createElement("div");
  document.body.append(root);
  render(
    h(ScanScreen, {
      list: props.list,
      onBack,
      onToggle,
      ...(props.embed === undefined ? {} : { embed: props.embed }),
      ...(props.off === undefined ? {} : { off: props.off }),
    }),
    root,
  );
  return { onToggle, onBack };
}

function text(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function click(element: Element | null): void {
  if (element === null) throw new Error("expected an element to click");
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("ScanScreen — auto-rank, manual tick", () => {
  it("turns a C4 OCR signal into a hero without committing anything, then commits on a human tick", async () => {
    const list = makeList(["Milk", "Bread"]);
    const embed = fakeEmbed(list, new Map([["milk label", vec({ 0: 1 })]]));
    const { onToggle } = mount({ list, embed, off: fakeOff() });

    await wait(MOUNT); // let the effects run, `session.start()` resolve and the first tick land
    expect(sessionMock.sessions).toHaveLength(1);
    expect(text()).toContain("CAMERA LIVE");
    expect(text()).toContain("auto-ranks, never auto-ticks");

    // The camera session reports one label line; the screen must not tick it for us.
    sessionOptions().onSignal(ocr("milk label"));
    await wait(SCAN_TICK_INTERVAL_MS + 80);

    expect(text()).toContain("BEST MATCH");
    expect(document.querySelector(".scan-hero-name .hero-value")?.textContent).toBe("Milk");
    expect(text()).toContain("never auto-ticked");
    expect(onToggle).not.toHaveBeenCalled();
    expect(list.sections[0]?.items?.[0]).not.toHaveProperty("done", true);

    // The bottom tick button is the manual commit path, and it hands C2 the ORIGINAL item object.
    click(document.querySelector(".scan-tick"));
    await wait(20);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0]?.[0]).toBe(list.sections[0]?.items?.[0]);
    expect(text()).toContain("Ticked Milk");
    // Exactly one Tap (ToggleOn) pattern for the commit, after the camera-start pulse.
    expect(vibrate).toHaveBeenCalledWith([18]);
  });

  it("renders the null hero honestly and keeps the tick affordance disabled", async () => {
    const list = makeList(["Milk", "Bread"]);
    // Below NO_MATCH_TEXT (0.79) and with no image evidence: a real "no confident match" state.
    const embed = fakeEmbed(list, new Map([["ambiguous", vec({ 0: 0.6, 1: 0.5 })]]));
    const { onToggle } = mount({ list, embed, off: fakeOff() });

    await wait(MOUNT);
    sessionOptions().onSignal(ocr("ambiguous"));
    await wait(SCAN_TICK_INTERVAL_MS + 80);

    expect(text()).toContain("NO CONFIDENT MATCH");
    expect(text()).toContain("Nothing is a confident match");
    const tick = document.querySelector<HTMLButtonElement>(".scan-tick");
    expect(tick?.disabled).toBe(true);
    click(tick);
    expect(onToggle).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalledWith([18]);
  });

  it("shows the live source chips from the pool the ranker used", async () => {
    const list = makeList(["Milk", "Bread"]);
    const embed = fakeEmbed(list, new Map([["milk label", vec({ 0: 1 })]]));
    mount({ list, embed, off: fakeOff({ "3017620422003": "Milk" }) });

    await wait(MOUNT);
    const options = sessionOptions();
    options.onSignal({ source: "barcode", text: "3017620422003", confidence: 1 });
    options.onSignal(ocr("milk label"));
    await wait(SCAN_TICK_INTERVAL_MS + 80);

    const chip = (key: string): string =>
      document.querySelector(`.scan-chip[data-source="${key}"] .scan-chip-detail`)?.textContent ?? "";
    expect(chip("barcode")).toBe("3017620422003");
    expect(chip("off")).toBe("found");
    expect(chip("ocr")).toBe("1 line");
    expect(chip("queries")).toBe("2/16");
    const active = Array.from(document.querySelectorAll(".scan-chip.is-active")).map((element) =>
      element.getAttribute("data-source"),
    );
    expect(active).toEqual(["barcode", "off", "ocr", "queries"]);
  });

  it("measures the ranked rows in document space — the capture receives the viewport scroll", async () => {
    const list = makeList(["Milk", "Bread"]);
    const embed = fakeEmbed(list, new Map([["milk label", vec({ 0: 1 })]]));
    // A scrolled page: without this offset a scroll between the two captures animates as a move.
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true, writable: true });
    Object.defineProperty(window, "scrollX", { value: 0, configurable: true, writable: true });
    const captureSpy = vi.spyOn(flip, "capturePositions");

    try {
      mount({ list, embed, off: fakeOff() });
      await wait(MOUNT);
      sessionOptions().onSignal(ocr("milk label"));
      await wait(SCAN_TICK_INTERVAL_MS + 80);

      // The ranked render is the first FLIP "first" capture; it must be in document space.
      expect(document.querySelector(".scan-hero-name .hero-value")?.textContent).toBe("Milk");
      expect(captureSpy).toHaveBeenCalled();
      const lastCall = captureSpy.mock.calls[captureSpy.mock.calls.length - 1];
      expect(lastCall?.[1]).toEqual({ x: 0, y: 300 });
    } finally {
      captureSpy.mockRestore();
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true, writable: true });
      Object.defineProperty(window, "scrollX", { value: 0, configurable: true, writable: true });
    }
  });
});

describe("ScanScreen — honest non-list and camera states", () => {
  it("never opens the camera with no list open", async () => {
    const { onBack } = mount({ list: null });

    await wait(MOUNT);
    expect(sessionMock.sessions).toHaveLength(0);
    expect(text()).toContain("NO LIST OPEN");
    expect(text()).toContain("it never creates new ones");
    click(document.querySelector("md-filled-button"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("classifies a denied camera and offers a retry that starts a new session", async () => {
    const list = makeList(["Milk"]);
    sessionMock.startError = { code: "denied", message: "Permission denied" };
    mount({ list, embed: fakeEmbed(list, new Map()), off: fakeOff() });

    await wait(MOUNT);
    expect(text()).toContain("CAMERA UNAVAILABLE");
    expect(document.querySelector(".scan-error[role='alert']")?.textContent).toContain(
      "Camera permission was denied",
    );
    expect(sessionMock.sessions[0]?.stop).toHaveBeenCalled();

    sessionMock.startError = null;
    click(document.querySelector("md-outlined-button")); // Retry camera
    await wait(MOUNT);
    expect(sessionMock.sessions).toHaveLength(2);
    expect(text()).toContain("CAMERA LIVE");
  });
});

describe("ScanScreen — session lifecycle + haptics", () => {
  it("stops the camera on request and restarts the single-use session when OCR is toggled", async () => {
    const list = makeList(["Milk"]);
    mount({ list, embed: fakeEmbed(list, new Map()), off: fakeOff() });

    await wait(MOUNT);
    expect(sessionMock.sessions).toHaveLength(1);
    expect(vibrate).toHaveBeenCalledWith([30]); // LongPress start pulse
    expect(sessionOptions().ocr).toBeDefined(); // OCR defaults on

    const buttons = Array.from(document.querySelectorAll("md-text-button"));
    const stopButton = buttons.find((button) => button.textContent.includes("Stop camera"));
    click(stopButton ?? null);
    await wait(MOUNT);
    expect(sessionMock.sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(text()).toContain("CAMERA OFF");

    const startButton = Array.from(document.querySelectorAll("md-text-button")).find((button) =>
      button.textContent.includes("Start camera"),
    );
    click(startButton ?? null);
    await wait(MOUNT);
    // A stopped session is single-use: the screen builds a fresh one (with a fresh engine).
    expect(sessionMock.sessions).toHaveLength(2);
    expect(sessionMock.sessions[1]?.stop).not.toHaveBeenCalled();

    const ocrButton = Array.from(document.querySelectorAll("md-text-button")).find((button) =>
      button.textContent.includes("Read labels"),
    );
    click(ocrButton ?? null);
    await wait(MOUNT);
    expect(sessionMock.sessions).toHaveLength(3);
    expect(sessionOptions(2).ocr).toBeUndefined(); // "Read labels: off"
    expect(text()).toContain("OCR off");
  });

  it("treats a missing Vibration API as 'no haptics', not as a failed tick", async () => {
    delete (navigator as { vibrate?: unknown }).vibrate;
    const list = makeList(["Milk", "Bread"]);
    const embed = fakeEmbed(list, new Map([["milk label", vec({ 0: 1 })]]));
    const { onToggle } = mount({ list, embed, off: fakeOff() });

    await wait(MOUNT);
    sessionOptions().onSignal(ocr("milk label"));
    await wait(SCAN_TICK_INTERVAL_MS + 80);

    expect(() => click(document.querySelector(".scan-tick"))).not.toThrow();
    await wait(20);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Ticked Milk");
  });
});
