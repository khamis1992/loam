/**
 * Unit tests: the per-bot chat accent module (C20).
 *
 * The acceptance contract is that the accent is stable per conversation, that a
 * conversation with no bot falls back to the app accent, that the extracted
 * dominant color ignores transparent/white/black pixels, and that the returned
 * ink always clears WCAG AA 4.5:1 against the accent fill for every palette
 * color in both themes. The palette list is also pinned against the server's
 * AVATAR_COLORS so the two cannot drift apart.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { AVATAR_COLORS as SERVER_AVATAR_COLORS } from "../server/agents.js";
import {
  AVATAR_COLORS,
  AVATAR_HEX,
  accentVars,
  chatAccentFor,
  contrastRatio,
  dominantColorFromPixels,
  hashSeed,
  hexToRgb,
  hslToRgb,
  normalizeColorToken,
  paletteColorFor,
  readableInk,
  rgbToHsl,
  rgbToHex,
} from "../../ui/chat-color.js";

/** In-memory localStorage stand-in with a controllable clock. */
function memoryStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    raw: (key: string) => store.get(key) ?? null,
  };
}

/** Build RGBA pixels for a solid color, with optional transparency/white noise. */
function pixels(
  color: { r: number; g: number; b: number; a?: number },
  count: number,
  noise: Array<{ r: number; g: number; b: number; a?: number }> = [],
) {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    // Noise is sprinkled into the first `noise.length` pixels only, so the rest
    // of the frame stays a solid field of `color`.
    const p = i < noise.length ? { ...color, ...noise[i] } : color;
    data[i * 4] = p.r;
    data[i * 4 + 1] = p.g;
    data[i * 4 + 2] = p.b;
    data[i * 4 + 3] = p.a ?? 255;
  }
  return data;
}

/** Interleave two colors into one frame, so neither cluster can dominate. */
function splitPixels(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, count: number) {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const p = i % 2 === 0 ? a : b;
    data[i * 4] = p.r;
    data[i * 4 + 1] = p.g;
    data[i * 4 + 2] = p.b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** A frame with `count` visually distinct saturated colors, evenly spread. */
function distinctPixels(count: number) {
  const data = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = huePixel((360 / count) * i) ?? [0, 0, 0];
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** A fully saturated RGB pixel at `hue` degrees. */
function huePixel(hue: number) {
  const sectorIndex = Math.floor(hue / 60) % 6;
  const fraction = hue / 60 - Math.floor(hue / 60);
  const ascending = Math.round(255 * fraction);
  const descending = Math.round(255 * (1 - fraction));
  const table: Array<[number, number, number]> = [
    [255, ascending, 0],
    [descending, 255, 0],
    [0, 255, ascending],
    [0, descending, 255],
    [ascending, 0, 255],
    [255, 0, descending],
  ];
  return table[sectorIndex];
}

describe("chat accent palette", () => {
  it("mirrors the server AVATAR_COLORS token list", () => {
    assert.deepEqual([...AVATAR_COLORS], [...SERVER_AVATAR_COLORS]);
  });

  it("maps every token to a lowercase hex color", () => {
    for (const token of AVATAR_COLORS) {
      assert.match(AVATAR_HEX[token], /^#[0-9a-f]{6}$/, `${token} must be hex`);
    }
  });

  it("normalizes names and aliases, and rejects unknown input", () => {
    assert.equal(normalizeColorToken("Violet"), "violet");
    assert.equal(normalizeColorToken("  grey  "), "gray");
    assert.equal(normalizeColorToken("#6e56cf"), "");
    assert.equal(normalizeColorToken(undefined), "");
    assert.equal(normalizeColorToken(""), "");
  });

  it("hashes deterministically and is non-zero for non-empty input", () => {
    assert.equal(hashSeed("agent_abc"), hashSeed("agent_abc"));
    assert.notEqual(hashSeed("agent_abc"), hashSeed("agent_xyz"));
    assert.equal(hashSeed(""), 0);
  });

  it("resolves a palette color per id, and a different id to a different color", () => {
    assert.equal(paletteColorFor("agent_abc"), paletteColorFor("agent_abc"));
    assert.notEqual(paletteColorFor("agent_abc"), paletteColorFor("agent_xyz"));
  });
});

describe("chatAccentFor", () => {
  it("returns null when there is no agent, leaving the app accent untouched", () => {
    assert.equal(chatAccentFor(null), null);
    assert.equal(chatAccentFor(undefined), null);
    assert.equal(chatAccentFor({}), null);
    assert.equal(chatAccentFor({ id: "" }), null);
  });

  it("prefers an explicit avatar color token", () => {
    assert.equal(chatAccentFor({ id: "agent_1", avatarColor: "violet" }), AVATAR_HEX.violet);
    assert.equal(chatAccentFor({ id: "agent_1", avatarColor: "grey" }), AVATAR_HEX.gray);
  });

  it("ignores an unknown avatar color and falls back to the id hash", () => {
    const storage = memoryStorage();
    assert.equal(
      chatAccentFor({ id: "agent_1", avatarColor: "chartreuse" }, { storage }),
      paletteColorFor("agent_1"),
    );
    assert.equal(storage.raw("loam.chatColor.agent_1"), null);
  });

  it("extracts and caches an avatar image color, keyed by the image URL", async () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    const extract = async (src: string) => {
      seen.push(src);
      return "#12a594";
    };
    const applied: Array<string | null> = [];
    const options = {
      storage,
      extractImageColor: extract,
      now: () => 1_000,
      onAccent: (color: string | null) => applied.push(color),
    };
    const first = chatAccentFor({ id: "agent_img", avatarImage: "/api/x.png" }, options);
    // Sampling is async, so the synchronous result is the deterministic fallback.
    assert.equal(first, paletteColorFor("agent_img"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(applied, ["#12a594"]);
    assert.deepEqual(seen, ["/api/x.png"]);
    assert.ok(storage.raw("loam.chatColor.agent_img")!.includes("#12a594"));

    // A matching cache entry short-circuits extraction entirely.
    const cached = chatAccentFor({ id: "agent_img", avatarImage: "/api/x.png" }, options);
    assert.equal(cached, "#12a594");
    assert.deepEqual(seen, ["/api/x.png"]);
    assert.deepEqual(applied, ["#12a594"]);

    // A changed image URL invalidates the cache entry.
    const changed = chatAccentFor({ id: "agent_img", avatarImage: "/api/y.png" }, options);
    assert.equal(changed, paletteColorFor("agent_img"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, ["/api/x.png", "/api/y.png"]);
  });

  it("ignores an unusable extraction result without caching it", async () => {
    const storage = memoryStorage();
    const options = { storage, extractImageColor: () => null, now: () => 1_000 };
    assert.equal(chatAccentFor({ id: "agent_img", avatarImage: "/api/z.png" }, options), paletteColorFor("agent_img"));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(storage.raw("loam.chatColor.agent_img"), null);
  });

  it("treats an expired cache entry as a miss", async () => {
    const THIRTY_DAYS = 30 * 86_400_000;
    const storage = memoryStorage({
      "loam.chatColor.agent_img": JSON.stringify({
        color: "#123456",
        hash: `h${hashSeed("/api/old.png").toString(36)}`,
        savedAt: 0,
      }),
    });
    // The entry was written at t=0 and read after its 30-day window, so it is a
    // miss and the extractor supplies the color instead.
    const clock = THIRTY_DAYS + 1;
    const options = {
      storage,
      now: () => clock,
      extractImageColor: () => "#654321",
    };
    assert.equal(chatAccentFor({ id: "agent_img", avatarImage: "/api/old.png" }, options), "#654321");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(chatAccentFor({ id: "agent_img", avatarImage: "/api/old.png" }, options), "#654321");
  });

  it("notifies the caller when an async sample lands, and clears the stale cache", async () => {
    const THIRTY_DAYS = 30 * 86_400_000;
    const storage = memoryStorage({
      "loam.chatColor.agent_img": JSON.stringify({
        color: "#123456",
        hash: `h${hashSeed("/api/old.png").toString(36)}`,
        savedAt: 0,
      }),
    });
    const applied: Array<string | null> = [];
    const options = {
      storage,
      now: () => THIRTY_DAYS + 1,
      extractImageColor: async () => "#654321",
      onAccent: (color: string | null) => applied.push(color),
    };
    assert.equal(chatAccentFor({ id: "agent_img", avatarImage: "/api/old.png" }, options), paletteColorFor("agent_img"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(applied, ["#654321"]);
    // The rewritten entry is fresh again, so the next read is served from cache.
    assert.equal(chatAccentFor({ id: "agent_img", avatarImage: "/api/old.png" }, options), "#654321");
  });

  it("survives a throwing extractor and a throwing storage backend", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(
      chatAccentFor(
        { id: "agent_img", avatarImage: "/api/a.png" },
        { storage: hostile, extractImageColor: () => { throw new Error("boom"); } },
      ),
      paletteColorFor("agent_img"),
    );
  });
});

describe("dominantColorFromPixels", () => {
  it("returns null when there are no usable pixels", () => {
    assert.equal(dominantColorFromPixels(new Uint8ClampedArray(0)), null);
    assert.equal(dominantColorFromPixels(pixels({ r: 0, g: 0, b: 0 }, 16)), null);
    assert.equal(dominantColorFromPixels(pixels({ r: 255, g: 255, b: 255 }, 16)), null);
    // Fully transparent pixels are dropped, leaving nothing to cluster.
    const transparent = new Uint8ClampedArray(16 * 4);
    assert.equal(dominantColorFromPixels(transparent), null);
  });

  it("returns the dominant saturated color as hex", () => {
    const hex = dominantColorFromPixels(pixels({ r: 18, g: 165, b: 148 }, 64));
    assert.equal(hex, "#12a594");
  });

  it("ignores a small share of white/black noise pixels", () => {
    const data = pixels({ r: 18, g: 165, b: 148 }, 48, [
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 0, g: 0, b: 0, a: 255 },
    ]);
    assert.equal(dominantColorFromPixels(data), "#12a594");
  });

  it("returns null when no single color dominates the frame", () => {
    // Twelve distinct hues spread the vote evenly, so no cluster reaches the
    // dominance share.
    assert.equal(dominantColorFromPixels(distinctPixels(12)), null);
  });

  it("breaks a tie between equal clusters deterministically", () => {
    // Blue and red each cover half the frame; the first cluster seen wins.
    const data = splitPixels({ r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 0 }, 16);
    assert.equal(dominantColorFromPixels(data), "#0000ff");
  });
});

describe("accentVars", () => {
  it("returns null for empty or non-hex input", () => {
    assert.equal(accentVars(""), null);
    assert.equal(accentVars("   "), null);
    assert.equal(accentVars("#12345"), null);
    assert.equal(accentVars("chartreuse"), null);
  });

  it("keeps the source hue and returns three custom properties", () => {
    const vars = accentVars("#12a594", "dark");
    assert.ok(vars);
    assert.deepEqual(Object.keys(vars!).sort(), ["--chat-accent", "--chat-accent-2", "--chat-accent-ink"]);
    const source = rgbToHsl(hexToRgb("#12a594")!);
    const accent = rgbToHsl(hexToRgb(vars!["--chat-accent"])!);
    const hueDelta = Math.min(Math.abs(source.h - accent.h), 360 - Math.abs(source.h - accent.h));
    assert.ok(hueDelta < 2, `hue must be preserved, delta ${hueDelta}`);
    assert.match(vars!["--chat-accent"], /^#[0-9a-f]{6}$/);
    assert.match(vars!["--chat-accent-2"], /^#[0-9a-f]{6}$/);
  });

  it("clears WCAG AA 4.5:1 for every palette color in both themes", () => {
    for (const token of AVATAR_COLORS) {
      for (const theme of ["light", "dark"] as const) {
        const vars = accentVars(AVATAR_HEX[token], theme);
        assert.ok(vars, `${token}/${theme} must produce vars`);
        const ratio = contrastRatio(hexToRgb(vars!["--chat-accent-ink"])!, hexToRgb(vars!["--chat-accent"])!);
        assert.ok(ratio >= 4.5, `${token}/${theme} ink contrast ${ratio.toFixed(2)} must be >= 4.5`);
      }
    }
  });

  it("never darkens the fill past its ink, and keeps the gradient sibling ordered", () => {
    for (const token of AVATAR_COLORS) {
      for (const theme of ["light", "dark"] as const) {
        const vars = accentVars(AVATAR_HEX[token], theme)!;
        const ink = readableInk(hexToRgb(vars["--chat-accent"])!);
        assert.equal(vars["--chat-accent-ink"], ink);
        const fill = rgbToHsl(hexToRgb(vars["--chat-accent"])!);
        const fill2 = rgbToHsl(hexToRgb(vars["--chat-accent-2"])!);
        assert.ok(fill2.l >= fill.l - 0.01, `${token}/${theme} gradient sibling must not be darker`);
      }
    }
  });
});

describe("color math", () => {
  it("parses and formats hex round-trips", () => {
    assert.deepEqual(hexToRgb("#12a594"), { r: 18, g: 165, b: 148 });
    assert.deepEqual(hexToRgb("#abc"), { r: 170, g: 187, b: 204 });
    assert.equal(hexToRgb("#12345"), null);
    assert.equal(rgbToHex({ r: 18, g: 165, b: 148 }), "#12a594");
  });

  it("clamps out-of-range channels", () => {
    assert.equal(rgbToHex({ r: 999, g: -40, b: 128.6 }), "#ff0081");
  });

  it("converts between rgb and hsl without losing the hue", () => {
    const rgb = { r: 18, g: 165, b: 148 };
    const back = rgbToHex(hslToRgb(rgbToHsl(rgb)));
    assert.equal(back, "#12a594");
  });

  it("matches published WCAG 2.2 reference ratios", () => {
    assert.ok(Math.abs(contrastRatio(hexToRgb("#000000")!, hexToRgb("#ffffff")!) - 21) < 0.001);
    // #767676 on white is the WCAG AA large-text boundary (4.5:1).
    assert.ok(Math.abs(contrastRatio(hexToRgb("#767676")!, hexToRgb("#ffffff")!) - 4.5422) < 0.001);
    assert.ok(Math.abs(contrastRatio(hexToRgb("#12a594")!, hexToRgb("#0b1220")!) - 6.0943) < 0.001);
  });

  it("picks the better ink for light and dark fills", () => {
    assert.equal(readableInk(hexToRgb("#ffc53d")!), "#0b1220");
    assert.equal(readableInk(hexToRgb("#12a594")!), "#0b1220");
    assert.equal(readableInk(hexToRgb("#0b1220")!), "#ffffff");
  });
});
