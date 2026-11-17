import { describe, expect, it } from "vitest";

import { sha1Hex } from "../src/sha1";

describe("sha1Hex", () => {
  it("matches the standard FIPS 180-1 vectors", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12",
    );
  });

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is 2 UTF-8 bytes; pinned with `printf 'é' | sha1sum`. The oracle hashes
    // `key.encode("utf-8")`, so a UTF-16 implementation would differ here.
    expect(sha1Hex("é")).toBe("bf15be717ac1b080b4f1c456692825891ff5073d");
    expect(sha1Hex("Milk#0")).toBe("2f551506bf4e121abecf1480482d5674359ee397");
  });

  it("matches every FLATTEN.md §3.2 worked id key", () => {
    expect(sha1Hex("Pantry/Pasta#0")).toBe(
      "19d895a3b978a4e00caccc2f20ce35044c83cd28",
    );
    expect(sha1Hex("Fresh/Fruit & veg/Bananas#0")).toBe(
      "998e2c1acb80597f39892b85f9dfa8726ead298e",
    );
    expect(sha1Hex("Fresh/Fruit & veg/Tomatoes#1")).toBe(
      "801b3e63df7a42974bc5f11b4a342251f8c04ba3",
    );
    expect(sha1Hex("A/B/C/D/Nutmeg#2")).toBe(
      "cfc789c216b0dd286fa1f6f40592e8db7aeb7197",
    );
  });
});
