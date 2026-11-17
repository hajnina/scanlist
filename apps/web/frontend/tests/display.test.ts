/**
 * LIST.md §4 rendering: `amountText` / `displayText` / note, straight from the spec's examples.
 *
 * The amount union must never be coerced (LIST.md §3): a quoted "3" stays text, a number is a
 * quantity, and a unit without an amount renders as nothing.
 */

import { describe, expect, it } from "vitest";

import {
  amountText,
  displayName,
  displayNote,
  displayText,
  formatJsonNumber,
} from "../src/core/display";

describe("formatJsonNumber — shortest round-trip, JSON style", () => {
  it("renders integers without a decimal point", () => {
    expect(formatJsonNumber(6)).toBe("6");
    expect(formatJsonNumber(-2)).toBe("-2");
    expect(formatJsonNumber(0)).toBe("0");
    expect(formatJsonNumber(-0)).toBe("0");
  });

  it("keeps fractional values short", () => {
    expect(formatJsonNumber(0.5)).toBe("0.5");
    expect(formatJsonNumber(1.25)).toBe("1.25");
    expect(formatJsonNumber(2.5)).toBe("2.5");
  });

  it("uses the plain range and only falls back to exponents outside it", () => {
    expect(formatJsonNumber(1e-6)).toBe("0.000001");
    expect(formatJsonNumber(1e-7)).toBe("1e-7");
    expect(formatJsonNumber(1e15)).toBe("1000000000000000");
    expect(formatJsonNumber(1e21)).toBe("1e+21");
    expect(formatJsonNumber(999999999999999)).toBe("999999999999999");
  });
});

describe("amountText / displayText — LIST.md §4 examples", () => {
  it("follows the five normative examples", () => {
    expect(displayText({ amount: 6 })).toBe("6");
    expect(displayText({ amount: 1, unit: "kg" })).toBe("1 kg");
    expect(displayText({ amount: "2 packs" })).toBe("2 packs");
    expect(displayText({ unit: "kg" })).toBe("");
    expect(displayText({ amount: 0.5, unit: "l" })).toBe("0.5 l");
  });

  it("never coerces the union", () => {
    expect(amountText({ amount: "3" })).toBe("3");
    expect(amountText({ amount: 3 })).toBe("3");
    expect(amountText({ amount: "1/2" })).toBe("1/2");
    expect(amountText({ amount: "a handful" })).toBe("a handful");
    expect(amountText({})).toBe("");
    expect(amountText({ amount: null })).toBe("");
    expect(amountText({ amount: "   " })).toBe("");
  });

  it("trims the unit and drops it when there is no amount", () => {
    expect(displayText({ amount: 2, unit: "  kg " })).toBe("2 kg");
    expect(displayText({ amount: 2, unit: "   " })).toBe("2");
    expect(displayText({ unit: "kg" })).toBe("");
  });

  it("renders notes separately and never inside displayText (LIST.md §4)", () => {
    const item = { name: "Oat milk", amount: "2 cartons", unit: "l", note: "  the barista one " };
    expect(displayText(item)).toBe("2 cartons l");
    expect(displayNote(item)).toBe("the barista one");
    expect(displayNote({ note: "   " })).toBeNull();
    expect(displayNote({})).toBeNull();
  });

  it("trims names for display only", () => {
    expect(displayName({ name: "  Milk  " })).toBe("Milk");
  });
});
