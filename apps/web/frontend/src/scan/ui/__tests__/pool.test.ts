/**
 * Card C5 pool-order decision (lead note + B4-sync review, web twin):
 * barcode + up to 16 OCR lines can be live, but the ranker takes only the first 16 text queries and
 * drops the rest in arrival order. A barcode arriving last must never be the one dropped.
 *
 * These tests pin the client-side fix: barcode query text in slot 0, OCR capped at 15 beside it, and
 * the image window (4 newest within 2000 ms) RANK.md §2.2 asks for.
 */

import { describe, expect, it } from "vitest";

import {
  BARCODE_TTL_MS,
  DEFAULT_POOL_LIMITS,
  IMAGE_WINDOW_MS,
  MAX_IMAGE_VECTORS,
  OCR_LINE_TTL_MS,
  assembleQueryPool,
  imageWindow,
  liveBarcode,
  liveOcrLines,
} from "../pool";
import type { BarcodeEvidence, ImageEvidence, OcrLineEvidence } from "../pool";

const NOW = 1_000_000;

function lines(count: number, at = NOW - 100): OcrLineEvidence[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `line ${index}`,
    at,
    confidence: 0.9,
  }));
}

function barcode(text: string | null, state: BarcodeEvidence["state"] = "found", at = NOW - 100): BarcodeEvidence {
  return { barcode: "3017620422003", at, text, state };
}

describe("assembleQueryPool — barcode-first pool order", () => {
  it("reserves slot 0 for the barcode and caps OCR at MAX_TEXT_QUERIES - 1 beside it", () => {
    const pool = assembleQueryPool(
      { barcodes: [barcode("Nutella")], ocrLines: lines(16), images: [] },
      NOW,
    );

    expect(pool.texts).toHaveLength(16);
    expect(pool.texts[0]).toBe("Nutella");
    // 16 live lines, only 15 fit because the barcode owns a slot; the *last* line is dropped.
    expect(pool.texts.slice(1)).toEqual(lines(16).slice(0, 15).map((line) => line.text));
    expect(pool.texts).not.toContain("line 15");
    expect(pool.droppedOcrLines).toBe(1);
    expect(pool.liveOcrLines).toBe(16);
    expect(pool.barcodeInPool).toBe(true);
  });

  it("uses the full 16 slots for OCR when there is no barcode text", () => {
    const pool = assembleQueryPool({ barcodes: [], ocrLines: lines(16), images: [] }, NOW);
    expect(pool.texts).toHaveLength(16);
    expect(pool.droppedOcrLines).toBe(0);
    expect(pool.barcodeInPool).toBe(false);
  });

  it("does not reserve a slot while OFF is pending or has no usable name", () => {
    const pending = assembleQueryPool(
      { barcodes: [barcode(null, "pending")], ocrLines: lines(16), images: [] },
      NOW,
    );
    expect(pending.texts).toHaveLength(16);
    expect(pending.barcode).not.toBeNull();
    expect(pending.barcodeInPool).toBe(false);
  });

  it("drops a barcode older than its hold but keeps a newer one", () => {
    const old = barcode("Old", "found", NOW - BARCODE_TTL_MS - 1);
    const fresh = { ...barcode("Fresh", "found", NOW - 10), barcode: "4006381333931" };

    const pool = assembleQueryPool({ barcodes: [old, fresh], ocrLines: [], images: [] }, NOW);
    expect(pool.barcode?.barcode).toBe("4006381333931");
    expect(pool.texts).toEqual(["Fresh"]);
    expect(liveBarcode([old], NOW)).toBeNull();
  });

  it("collapses repeated OCR lines (one query per line) and refreshes their timestamp", () => {
    const repeated: OcrLineEvidence[] = [
      { text: "Milk", at: NOW - 2000, confidence: 0.5 },
      { text: "Milk", at: NOW - 100, confidence: 0.9 },
      { text: "Bread", at: NOW - 50, confidence: 0.8 },
    ];
    const pool = assembleQueryPool({ barcodes: [], ocrLines: repeated, images: [] }, NOW);

    expect(pool.texts).toEqual(["Milk", "Bread"]);
    expect(liveOcrLines(repeated, NOW)).toHaveLength(2);
  });

  it("expires an OCR line after its TTL and keeps it exactly at the boundary", () => {
    const line: OcrLineEvidence = { text: "Milk", at: NOW - OCR_LINE_TTL_MS, confidence: 1 };
    expect(liveOcrLines([line], NOW)).toHaveLength(1);
    expect(liveOcrLines([line], NOW + 1)).toHaveLength(0);
  });
});

describe("imageWindow — RANK.md §2.2", () => {
  function frame(capturedAt: number): ImageEvidence {
    return { vector: [capturedAt], capturedAt };
  }

  it("keeps the 4 newest vectors from the last 2000 ms", () => {
    const images = [
      frame(NOW - 3000),
      frame(NOW - 1800),
      frame(NOW - 1200),
      frame(NOW - 600),
      frame(NOW - 10),
    ];
    const kept = imageWindow(images, NOW);
    expect(kept).toHaveLength(MAX_IMAGE_VECTORS);
    expect(kept.map((image) => image.capturedAt)).toEqual([
      NOW - 10,
      NOW - 600,
      NOW - 1200,
      NOW - 1800,
    ]);
  });

  it("drops everything older than the window", () => {
    expect(imageWindow([frame(NOW - IMAGE_WINDOW_MS - 1)], NOW)).toEqual([]);
    expect(imageWindow([frame(NOW + 50)], NOW)).toHaveLength(1); // clock skew is not evidence to drop
  });

  it("is part of the assembled pool, independently of the text slots", () => {
    const pool = assembleQueryPool(
      { barcodes: [], ocrLines: lines(16), images: [frame(NOW - 100)] },
      NOW,
    );
    expect(pool.texts).toHaveLength(16);
    expect(pool.images).toHaveLength(1);
  });
});

describe("pool limits are injectable (tests + future calibration)", () => {
  it("honours a smaller cap", () => {
    const pool = assembleQueryPool(
      { barcodes: [barcode("Nutella")], ocrLines: lines(10), images: [] },
      NOW,
      { ...DEFAULT_POOL_LIMITS, maxTextQueries: 5 },
    );
    expect(pool.texts).toHaveLength(5);
    expect(pool.texts[0]).toBe("Nutella");
    expect(pool.droppedOcrLines).toBe(6);
  });
});
