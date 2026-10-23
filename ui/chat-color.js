/**
 * Per-bot chat accent color (C20 / UI1).
 *
 * Every conversation currently shares one fixed accent (teal/green). This module
 * derives one accent per conversation from its bot, so the user bubble, the send
 * button and the composer focus ring carry the color of the avatar you are
 * talking to, while a conversation with no bot keeps the exact app default.
 *
 * Importable from Node (node:test) and from the browser with no side effects:
 * `document`/`localStorage` are only touched inside functions, never at import
 * time, so the pure helpers stay unit-testable and DOM wiring stays the
 * caller's job. Types live in the sibling `chat-color.d.ts`.
 */

/**
 * Named avatar color tokens -> hex. Mirrors `AVATAR_COLORS` in
 * `src/server/agents.ts` and the web `AVATAR_PALETTE` bases. The test suite
 * asserts the two lists stay in sync; add an entry here whenever a token is
 * added there.
 */
export const AVATAR_HEX = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffc53d",
  green: "#30a46c",
  teal: "#12a594",
  cyan: "#00a2c7",
  blue: "#0090ff",
  indigo: "#3e63dd",
  violet: "#6e56cf",
  purple: "#8e4ec6",
  magenta: "#d6409f",
  pink: "#ec4899",
  brown: "#ad7f58",
  olive: "#8a9a2b",
  gray: "#6e6f77",
  slate: "#64748b",
};

/** The same tokens as a frozen list, the shape `src/server/agents.ts` publishes. */
export const AVATAR_COLORS = Object.freeze(Object.keys(AVATAR_HEX));

/** Alternate spellings accepted on input and mapped onto a canonical token. */
const COLOR_ALIASES = { grey: "gray" };

const THEME_STORAGE_KEY = "loam-theme";
const COLOR_STORAGE_PREFIX = "loam.chatColor.";
/** Saved color entries expire so a stale value cannot outlive a redesign. */
const COLOR_CACHE_DAYS = 30;
/** Dark ink used for light fills; light ink used for dark fills. */
const INK_DARK = "#0b1220";
const INK_LIGHT = "#ffffff";
/** WCAG AA contrast floor for the send button label on the accent fill. */
const AA_TEXT = 4.5;

/** Downsampled sample grid per axis; 32x32 keeps extraction under one frame. */
const SAMPLE_GRID = 32;
/** A cluster must cover this share of the sampled pixels to dominate. */
const MIN_SHARE = 0.12;
/** Per-channel tolerance for merging a pixel into a cluster. */
const CLUSTER_TOLERANCE = 26;
/** Colors treated as unusable when extracted from an image. */
const NEAR_WHITE = 242;
const NEAR_BLACK = 16;
/** Minimum channel spread, otherwise a pixel counts as a wash. */
const MIN_SPREAD = 18;
/**
 * Lightness ladder used to pick a fill tone for each theme. The accent keeps the
 * source hue and only its lightness is retargeted, so the color stays visible in
 * both themes; a hue's own luminance decides which rung it needs.
 */
const LIGHT_THEME = { start: 0.62, step: -0.02, floor: 0.34 };
const DARK_THEME = { start: 0.74, step: -0.02, floor: 0.44 };

/* ------------------------------------------------------------------ color math */

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function channel(value) {
  const n = Number(value);
  return Number.isFinite(n) ? clampChannel(n) : 0;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/** Lowercase `#rrggbb` for sRGB channels. */
export function rgbToHex({ r, g, b }) {
  const hex = (value) => clampChannel(value).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Parse `#rgb` or `#rrggbb`; `null` for anything else. */
export function hexToRgb(hex) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1] ?? "";
  if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
  };
}

export function rgbToHsl({ r, g, b }) {
  const rn = clampChannel(r) / 255;
  const gn = clampChannel(g) / 255;
  const bn = clampChannel(b) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return { h, s: clamp01(s), l: clamp01(l) };
}

export function hslToRgb({ h, s, l }) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const lum = clamp01(l);
  const chroma = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lum - chroma / 2;
  const sector = Math.floor(hue / 60) % 6;
  const table = {
    0: [chroma, x, 0],
    1: [x, chroma, 0],
    2: [0, chroma, x],
    3: [0, x, chroma],
    4: [x, 0, chroma],
    5: [chroma, 0, x],
  };
  const [r, g, b] = table[sector] ?? [0, 0, 0];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** WCAG 2.2 relative luminance of an sRGB color. */
export function relativeLuminance(rgb) {
  const linear = (value) => {
    const v = clampChannel(value) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** WCAG 2.2 contrast ratio between two sRGB colors. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Ink that clears WCAG AA 4.5:1 on `background`. Picking the better of dark and
 * light ink always lands at or above 4.5:1, so every palette color is safe.
 */
export function readableInk(background) {
  return contrastRatio(background, hexToRgb(INK_DARK) ?? { r: 0, g: 0, b: 0 }) >=
    contrastRatio(background, hexToRgb(INK_LIGHT) ?? { r: 255, g: 255, b: 255 })
    ? INK_DARK
    : INK_LIGHT;
}

/* ------------------------------------------------------------- token -> color */

/** Canonical lowercase token for an input color name; empty when unknown. */
export function normalizeColorToken(value) {
  if (typeof value !== "string") return "";
  const key = value.trim().toLowerCase();
  if (!key) return "";
  const token = COLOR_ALIASES[key] ?? key;
  return token in AVATAR_HEX ? token : "";
}

/** 32-bit unsigned hash of a string (FNV-1a style, 0 for empty input). */
export function hashSeed(seed) {
  if (!seed) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic palette color for an id: the same id always resolves to the
 * same color, so an agent without an explicit avatar color keeps a stable mark.
 */
export function paletteColorFor(seed) {
  const token = AVATAR_COLORS[hashSeed(seed) % AVATAR_COLORS.length] ?? "blue";
  return AVATAR_HEX[token];
}

/** Hex for a named token, falling back to the id hash for unknown names. */
function hexOfToken(token) {
  return AVATAR_HEX[token] ?? paletteColorFor(token);
}

/* ------------------------------------------------------------ image sampling */

/** Drop transparent, near-white, near-black and washed-out pixels. */
function cleanPixels(data) {
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 26) continue;
    const rgb = { r: channel(data[i]), g: channel(data[i + 1]), b: channel(data[i + 2]) };
    const spread = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
    if (spread < MIN_SPREAD) continue;
    if (rgb.r >= NEAR_WHITE && rgb.g >= NEAR_WHITE && rgb.b >= NEAR_WHITE) continue;
    if (rgb.r <= NEAR_BLACK && rgb.g <= NEAR_BLACK && rgb.b <= NEAR_BLACK) continue;
    pixels.push(rgb);
  }
  return pixels;
}

function nearestCluster(clusters, pixel) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cluster of clusters) {
    const distance =
      Math.abs(cluster.r - pixel.r) + Math.abs(cluster.g - pixel.g) + Math.abs(cluster.b - pixel.b);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = cluster;
    }
  }
  return bestDistance <= CLUSTER_TOLERANCE * 3 ? best : null;
}

/**
 * Dominant saturated color of an avatar image: pixels are clustered by color,
 * the largest cluster wins and its weighted centroid is returned as hex. A
 * photo background or a white logo canvas therefore never leaks a gray accent.
 */
export function dominantColorFromPixels(data) {
  const pixels = cleanPixels(data);
  if (pixels.length === 0) return null;
  const clusters = [];
  for (const pixel of pixels) {
    const cluster = nearestCluster(clusters, pixel);
    if (cluster) {
      const total = cluster.n + 1;
      cluster.r = (cluster.r * cluster.n + pixel.r) / total;
      cluster.g = (cluster.g * cluster.n + pixel.g) / total;
      cluster.b = (cluster.b * cluster.n + pixel.b) / total;
      cluster.n = total;
    } else {
      clusters.push({ ...pixel, n: 1 });
    }
  }
  let winner = clusters[0];
  for (const cluster of clusters) if (cluster.n > (winner?.n ?? 0)) winner = cluster;
  if (!winner || winner.n / pixels.length < MIN_SHARE) return null;
  return rgbToHex(winner);
}

/** Canvas path for `avatarImage`: downsample to a small grid, then cluster it. */
function extractWithCanvas(src) {
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (color) => {
      if (settled) return;
      settled = true;
      resolve(color);
    };
    const image = new Image();
    // Avatars are first-party assets (/api/...), so canvas tainting is unexpected.
    image.crossOrigin = "anonymous";
    const done = () => finish(null);
    image.onload = () => {
      try {
        const canvas = doc.createElement("canvas");
        canvas.width = SAMPLE_GRID;
        canvas.height = SAMPLE_GRID;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return done();
        context.drawImage(image, 0, 0, SAMPLE_GRID, SAMPLE_GRID);
        const data = context.getImageData(0, 0, SAMPLE_GRID, SAMPLE_GRID).data;
        finish(dominantColorFromPixels(data));
      } catch {
        // A tainted canvas throws on getImageData; treat the image as unusable.
        done();
      }
    };
    image.onerror = done;
    image.src = src;
  });
}

/* ------------------------------------------------------------------- storage */

function safeGet(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
  } catch {
    /* storage is best-effort: a full or blocked store must not break the chat */
  }
}

/** Current theme, preferring the document and falling back to the stored one. */
export function currentTheme() {
  const doc = globalThis.document;
  if (doc?.documentElement?.dataset?.theme) {
    return doc.documentElement.dataset.theme === "light" ? "light" : "dark";
  }
  return safeGet(globalThis.localStorage, THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

/** Read a cached color when its image hash still matches and the entry is fresh. */
function readCache(storage, key, hash, now) {
  const raw = safeGet(storage, key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.hash !== hash || typeof parsed.color !== "string") return null;
    if (now() - (parsed.savedAt ?? 0) > COLOR_CACHE_DAYS * 86_400_000) return null;
    return hexToRgb(parsed.color) ? parsed.color : null;
  } catch {
    return null;
  }
}

function writeCache(storage, key, hash, color, now) {
  const entry = { color, hash, savedAt: now() };
  safeSet(storage, key, JSON.stringify(entry));
}

/* ------------------------------------------------------------- accent resolve */

/**
 * Accent color for a conversation's bot, by priority:
 * 1. `agent.avatarColor` (a named token) resolves to its palette hex.
 * 2. `agent.avatarImage` is sampled in the browser and cached in localStorage
 *    under `loam.chatColor.<id>`, keyed with a hash of the image URL.
 * 3. The agent id hashes deterministically into the palette.
 * 4. No agent (or no id) -> `null`, leaving the default accent untouched.
 *
 * When the color is still being sampled the id hash is returned immediately and
 * `options.onAccent` is called once the sample lands, so the caller can repaint
 * the conversation without waiting for its next render.
 */
export function chatAccentFor(agent, options = {}) {
  if (!agent || typeof agent.id !== "string" || !agent.id) return null;
  const token = normalizeColorToken(agent.avatarColor);
  if (token) return hexOfToken(token);
  const now = options.now ?? Date.now;
  const storage = options.storage ?? globalThis.localStorage;
  const prefix = options.storageKey ?? COLOR_STORAGE_PREFIX;
  const key = `${prefix}${agent.id}`;
  const image = typeof agent.avatarImage === "string" ? agent.avatarImage.trim() : "";
  if (image) {
    const hash = `h${hashSeed(image).toString(36)}`;
    const cached = readCache(storage, key, hash, now);
    if (cached) return cached;
    const extract = options.extractImageColor ?? extractWithCanvas;
    const fallback = paletteColorFor(agent.id);
    try {
      const extracted = extract(image);
      if (extracted && typeof extracted.then === "function") {
        // Sampling is async: keep the deterministic fallback for this render and
        // notify the caller so the extracted color is painted as soon as it lands.
        const settled = (color) => {
          if (color && hexToRgb(color)) writeCache(storage, key, hash, color, now);
          if (typeof options.onAccent === "function") options.onAccent(color);
        };
        void Promise.resolve(extracted).then(settled, () => undefined);
        return fallback;
      }
      if (extracted && hexToRgb(extracted)) {
        writeCache(storage, key, hash, extracted, now);
        return extracted;
      }
    } catch {
      /* extraction is best-effort; the id hash below still yields a color */
    }
  }
  return paletteColorFor(agent.id);
}

/* ------------------------------------------------------------- accent tokens */

/**
 * Build the `--chat-accent*` custom properties for one conversation.
 *
 * The source hue and saturation are kept and only the lightness is retargeted, so
 * the accent reads as the bot's color in both themes. The lightness is chosen
 * from a fixed ladder, which guarantees the returned ink clears WCAG AA 4.5:1
 * against the `--chat-accent` fill for every palette color in both themes.
 */
export function accentVars(source, theme = "auto") {
  const rgb = hexToRgb(source);
  if (!rgb) return null;
  const resolved = theme === "auto" ? currentTheme() : theme;
  const light = resolved === "light";
  const ladder = light ? LIGHT_THEME : DARK_THEME;
  const hsl = rgbToHsl(rgb);
  const steps = Math.ceil((ladder.start - ladder.floor) / -ladder.step);
  for (let i = 0; i <= steps; i++) {
    const target = clamp01(ladder.start + ladder.step * i);
    const accent = rgbToHex(hslToRgb({ ...hsl, l: target }));
    const ink = readableInk(hexToRgb(accent) ?? rgb);
    if (contrastRatio(hexToRgb(ink) ?? rgb, hexToRgb(accent) ?? rgb) >= AA_TEXT) {
      // `--chat-accent-2` is the gradient sibling: a deeper rung of the same hue.
      const accent2 = rgbToHex(hslToRgb({ ...hsl, l: clamp01(target + 0.06) }));
      return { "--chat-accent": accent, "--chat-accent-2": accent2, "--chat-accent-ink": ink };
    }
  }
  return null;
}

/**
 * Small controller the chat views use: it owns the `--chat-accent*` custom
 * properties on one container, so a conversation's color never leaks into
 * `:root` or another screen, and it recomputes them on every theme toggle.
 */
export class ChatAccentController {
  constructor(options = {}) {
    this.container = options.container ?? null;
    this.options = { ...options };
    delete this.options.container;
    this.theme = options.theme ?? currentTheme;
    this.agent = null;
    this.vars = null;
  }

  /** Set or clear the conversation's accent. `null` restores the default accent. */
  apply(agent, theme = "auto") {
    this.agent = agent ?? null;
    this.vars = accentVars(chatAccentFor(this.agent, this.options) ?? "", theme);
    const target =
      this.container ?? globalThis.document?.querySelector?.("[data-chat-accent]");
    if (!target) return;
    for (const name of ["--chat-accent", "--chat-accent-2", "--chat-accent-ink"]) {
      if (this.vars) target.style.setProperty(name, this.vars[name]);
      else target.style.removeProperty(name);
    }
  }

  /** The vars most recently applied, or `null` when the default accent is in use. */
  getVars() {
    return this.vars;
  }

  /** Re-apply for the current theme; call from the theme toggle. */
  refresh(theme = "auto") {
    this.apply(this.agent, theme);
  }
}

export default { AVATAR_HEX, AVATAR_COLORS, chatAccentFor, accentVars, ChatAccentController };
