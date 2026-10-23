/**
 * Types for `ui/chat-color.js`. The module ships as plain JS so the browser and
 * Node's test runner can both import it without a build step.
 */

export type AvatarColorToken =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "magenta"
  | "pink"
  | "brown"
  | "olive"
  | "gray"
  | "slate";

export type ChatAccentTheme = "light" | "dark";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export interface ChatAgent {
  id?: string;
  avatarColor?: string;
  avatarImage?: string;
}

export interface ChatColorOptions {
  /** Persist extracted colors here (defaults to `localStorage` when present). */
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** Image sampler for the browser path; injectable so tests skip the canvas. */
  extractImageColor?: (src: string) => string | null | Promise<string | null>;
  /** Wall clock for cache writes and expiry; defaults to `Date.now`. */
  now?: () => number;
  /** localStorage key namespace; override in tests. */
  storageKey?: string;
}

export interface ChatColorCacheEntry {
  color: string;
  hash: string;
  savedAt: number;
}

export interface ChatAccentVars {
  "--chat-accent": string;
  "--chat-accent-2": string;
  "--chat-accent-ink": string;
}

export interface ChatAccentControllerOptions extends ChatColorOptions {
  /** Element the accent vars are set on; defaults to `[data-chat-accent]`. */
  container?: HTMLElement | null;
  /** Theme reader; defaults to the document/`localStorage` theme. */
  theme?: () => ChatAccentTheme;
}

/** Named avatar color tokens -> hex. */
export const AVATAR_HEX: Readonly<Record<AvatarColorToken, string>>;
/** The same tokens as a frozen list. */
export const AVATAR_COLORS: readonly AvatarColorToken[];

export function rgbToHex(rgb: Rgb): string;
export function hexToRgb(hex: string): Rgb | null;
export function rgbToHsl(rgb: Rgb): Hsl;
export function hslToRgb(hsl: Hsl): Rgb;
export function relativeLuminance(rgb: Rgb): number;
export function contrastRatio(a: Rgb, b: Rgb): number;
export function readableInk(background: Rgb): string;
export function normalizeColorToken(value: unknown): string;
export function hashSeed(seed: string): number;
export function paletteColorFor(seed: string): string;
export function dominantColorFromPixels(data: Uint8ClampedArray): string | null;
export function currentTheme(): ChatAccentTheme;
export function chatAccentFor(
  agent: ChatAgent | null | undefined,
  options?: ChatColorOptions,
): string | null;
export function accentVars(
  source: string,
  theme?: ChatAccentTheme | "auto",
): ChatAccentVars | null;

export class ChatAccentController {
  constructor(options?: ChatAccentControllerOptions);
  /** Set or clear the conversation's accent. `null` restores the default accent. */
  apply(agent: ChatAgent | null | undefined, theme?: ChatAccentTheme | "auto"): void;
  /** The vars most recently applied, or `null` when the default accent is in use. */
  getVars(): ChatAccentVars | null;
  /** Re-apply for the current theme; call from the theme toggle. */
  refresh(theme?: ChatAccentTheme | "auto"): void;
}

declare const _default: {
  AVATAR_HEX: typeof AVATAR_HEX;
  AVATAR_COLORS: typeof AVATAR_COLORS;
  chatAccentFor: typeof chatAccentFor;
  accentVars: typeof accentVars;
  ChatAccentController: typeof ChatAccentController;
};
export default _default;
