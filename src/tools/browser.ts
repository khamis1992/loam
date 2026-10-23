import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Config } from "../config.js";
import { DATA_DIR } from "../config.js";
import { log } from "../log.js";
import { resolveWrite } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { bool, num, str } from "./registry.js";
import { publishBrowserFrame } from "./browserFrames.js";
import { getSettings } from "../server/settings.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

let browser: Browser | null = null;
/** Per-companion isolated browser sessions (frontier section 7): each session
 *  owns a separate context (cookies/localStorage/accounts) plus a persistent
 *  storage profile under DATA_DIR/browser-profiles/<session>. */
interface BrowserSession {
  context: BrowserContext;
  pages: Map<string, Page>;
}
/**
 * Isolated browser sessions (J6). Each entry holds a live Chromium context, so
 * this map must be bounded: the oldest session is closed (context disposed) when
 * a new one would exceed the cap, instead of leaking a browser per companion.
 */
const sessions = new BoundedMap<string, BrowserSession>(32, "browser-sessions", (_session, entry) => {
  try { void entry.context.close(); } catch { /* already gone */ }
});
registerCacheStats("browser-sessions", () => sessions.stats());
let counter = 0;
let sessionResolver: ((ctx: ToolContext) => string) | null = null;

/** Wired by index.ts: task → its companion's session (agent:<id>) or an
 *  ephemeral per-task session; anonymous runs share "shared". */
export function setBrowserSessionResolver(resolver: (ctx: ToolContext) => string): void {
  sessionResolver = resolver;
}

export function browserSessionFor(ctx: ToolContext): string {
  try {
    return sessionResolver?.(ctx) ?? "shared";
  } catch {
    return "shared";
  }
}

export function browserSessionsInfo(): Array<{ session: string; pages: number }> {
  return [...sessions.entries()].map(([session, s2]) => ({ session, pages: s2.pages.size })).sort((a, b) => a.session.localeCompare(b.session));
}

/* ---------- session tracing / recording state ---------- */
let recording = false;
let traceName: string | null = null;
let traceStartedAt: string | null = null;
let videoDir: string | null = null;
let lastVideoPath: string | null = null;
let lastTracePath: string | null = null;
const actionLog: Array<{ at: string; op: string; index?: number; text?: string; ok: boolean; message: string; url: string }> = [];
let lastTable: { text: string; snapshotId: number; pageId: string; url: string; title: string; at: string } | null = null;

function logAction(entry: { op: string; index?: number; text?: string; ok: boolean; message: string; url: string }): void {
  actionLog.push({ at: new Date().toISOString(), ...entry });
  if (actionLog.length > 300) actionLog.splice(0, actionLog.length - 300);
}

export function getBrowserState(): {
  running: boolean;
  recording: boolean;
  traceName: string | null;
  traceStartedAt: string | null;
  pages: Array<{ id: string; url: string }>;
  sessions: Array<{ session: string; pages: number }>;
  lastTable: typeof lastTable;
  actions: typeof actionLog;
  lastVideoPath: string | null;
  lastTracePath: string | null;
} {
  return {
    running: browser !== null,
  sessions: browserSessionsInfo(),
    recording,
    traceName,
    traceStartedAt,
    pages: [...sessions.values()].flatMap((s2) => [...s2.pages.entries()].map(([id, page]) => ({ id, url: page.url() }))),
    lastTable,
    actions: actionLog.slice(-40),
    lastVideoPath,
    lastTracePath,
  };
}

function profileDir(session: string): string {
  return path.join(DATA_DIR, "browser-profiles", session.replace(/[^\w.-]/g, "_"));
}

function profileStateFile(session: string): string {
  return path.join(profileDir(session), "storage.json");
}

async function ensureContextFor(cfg: Config, session: string): Promise<BrowserContext> {
  const existing = sessions.get(session);
  if (existing) return existing.context;
  const b = await ensureBrowser(cfg);
  const stateFile = profileStateFile(session);
  fs.mkdirSync(profileDir(session), { recursive: true });
  const context = await b.newContext({
    viewport: cfg.browser.viewport,
    ...(fs.existsSync(stateFile) ? { storageState: stateFile } : {}),
    ...(recording && videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}),
  });
  sessions.set(session, { context, pages: new Map() });
  log.info(`browser session "${session}" ready (isolated context${fs.existsSync(stateFile) ? " + restored profile" : ""})`);
  return context;
}

async function newPage(cfg: Config, session = "shared"): Promise<{ id: string; page: Page }> {
  const ctx = await ensureContextFor(cfg, session);
  const page = await ctx.newPage();
  const id = `page_${++counter}`;
  sessions.get(session)!.pages.set(id, page);
  page.on("close", () => sessions.get(session)?.pages.delete(id));
  return { id, page };
}

/** Persist a session's storage (cookies + origin storage) to its profile dir. */
export async function persistBrowserSession(session: string): Promise<void> {
  const entry = sessions.get(session);
  if (!entry) return;
  try {
    await entry.context.storageState({ path: profileStateFile(session) });
  } catch {
    /* best effort */
  }
}

/** Close one isolated session (persisting its profile). */
export async function closeBrowserSession(session: string): Promise<void> {
  const entry = sessions.get(session);
  if (!entry) return;
  await persistBrowserSession(session);
  try {
    await entry.context.close();
  } catch {
    /* ignore */
  }
  sessions.delete(session);
}

/** Close every isolated session WITHOUT persisting it, then delete the
 *  browser profile dirs (Settings > In-App Browser > clear browser data). */
export async function clearBrowserData(): Promise<{ profilesRemoved: boolean }> {
  for (const [session, entry] of [...sessions.entries()]) {
    try {
      await entry.context.close();
    } catch {
      /* ignore */
    }
    sessions.delete(session);
  }
  let removed = false;
  try {
    fs.rmSync(path.join(DATA_DIR, "browser-profiles"), { recursive: true, force: true });
    removed = true;
  } catch {
    /* ignore */
  }
  lastTable = null;
  actionLog.length = 0;
  return { profilesRemoved: removed };
}

const SNAPSHOT_JS = `(() => {
  const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[role="menuitem"],[role="tab"],[contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(sel));
  const nodes = [];
  let i = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    i += 1;
    const ref = 'r' + i;
    el.setAttribute('data-llm-ref', ref);
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.value || el.getAttribute('name') || '').toString().replace(/\\s+/g, ' ').trim().slice(0, 90);
    nodes.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: label,
      value: (el.value === undefined ? '' : String(el.value)).slice(0, 50),
      disabled: el.disabled === true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
    if (nodes.length >= 200) break;
  }
  return { title: document.title, url: location.href, count: nodes.length, nodes };
})()`;

async function ensureBrowser(cfg: Config): Promise<Browser> {
  if (browser) return browser;
  const attempts: Array<() => Promise<Browser>> = [
    () => chromium.launch({ channel: cfg.browser.channel as "msedge" | "chrome", headless: cfg.browser.headless }),
    () => chromium.launch({ headless: cfg.browser.headless }),
  ];
  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      browser = await attempt();
      log.info(`browser launched (channel=${cfg.browser.channel})`);
      return browser;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `cannot launch browser. Tried channel "${cfg.browser.channel}" and bundled chromium. Install Edge/Chrome or run: npx playwright install chromium. ${lastErr instanceof Error ? lastErr.message : ""}`,
  );
}

function getPage(id: string): Page {
  for (const s2 of sessions.values()) {
    const p = s2.pages.get(id);
    if (p) return p;
  }
  throw new Error(`no such page: ${id} (open one with browser_open)`);
}

function sel(args: Record<string, unknown>): string {
  const ref = str(args, "ref").trim();
  if (ref) return `[data-llm-ref="${ref}"]`;
  const selector = str(args, "selector").trim();
  if (selector) return selector;
  throw new Error("provide either ref (from browser_snapshot) or selector");
}

function browserSessionTaskId(ctx?: ToolContext): string {
  return ctx?.taskId && ctx.taskId.length > 0 ? ctx.taskId : "";
}

/** Capture a JPEG frame for the live Browser tab (best-effort, throttled).
 *  `existingJpeg` lets callers reuse a screenshot they already took. */
export async function emitLiveFrame(page: Page, ctx: ToolContext, existingJpeg?: string): Promise<void> {
  const key = browserSessionTaskId(ctx);
  if (!key) return;
  try {
    const url = page.url();
    if (!/^https?:/i.test(url)) return;
    let jpegBase64 = existingJpeg;
    let title: string | undefined;
    try {
      title = await page.title();
    } catch {
      /* ignore */
    }
    if (!jpegBase64) {
      jpegBase64 = (await page.screenshot({ type: "jpeg", quality: 55 })).toString("base64");
    }
    publishBrowserFrame(key, { url, title, jpegBase64 });
  } catch {
    /* live view is best-effort; never fail the agent action on a frame capture */
  }
}

/* ------------------------------------------------------------------ *
 * Fast indexed action space (architecture inspired by browser-use      *
 * "jev-ultrafast", MIT). Independent TS implementation:                *
 *  - one atomic DOM read -> indexed element table (no screenshots)     *
 *  - the model picks an OPERATION + INDEX (not selectors/coordinates)  *
 *  - every action re-validates freshness + occlusion before dispatch    *
 * ------------------------------------------------------------------ */

const TABLE_JS = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="tab"],[role="option"],[contenteditable="true"]';
  const vh = window.innerHeight, vw = window.innerWidth;
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (n >= 60) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < -40 || r.top > vh + 40 || r.right < -40 || r.left > vw + 40) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    if (el.disabled === true) continue;
    const role = (el.getAttribute('role') || el.tagName.toLowerCase());
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.value || el.getAttribute('name') || '').toString().replace(/\\s+/g, ' ').trim().slice(0, 70);
    const value = (el.value === undefined ? '' : String(el.value)).replace(/\\s+/g, ' ').slice(0, 40);
    n += 1;
    el.setAttribute('data-llm-idx', String(n));
    items.push({ i: n, tag: el.tagName.toLowerCase(), role, name, value });
  }
  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    canScrollDown: Math.round(window.scrollY + window.innerHeight) < document.body.scrollHeight - 4,
    items,
  };
})()`;

function roleToOp(tag: string, role: string): string[] {
  const ops = ["CLICK"];
  if (tag === "input" || tag === "textarea" || role === "textbox" || role === "combobox") ops.push("TYPE_TEXT");
  if (tag === "select" || role === "combobox" || role === "listbox") ops.push("SELECT");
  return ops;
}

interface TableResult {
  url: string;
  title: string;
  scrollY: number;
  canScrollDown: boolean;
  items: Array<{ i: number; tag: string; role: string; name: string; value: string }>;
}

interface TableSnapshot {
  id: number;
  pageId: string;
  url: string;
}

const snapshots = new WeakMap<Page, TableSnapshot>();
let snapshotCounter = 0;
const focusEmulation = new WeakSet<Page>();

async function ensureFocusEmulation(page: Page): Promise<void> {
  if (focusEmulation.has(page)) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    focusEmulation.add(page);
  } catch {
    /* optional capability */
  }
}

export async function buildTable(page: Page): Promise<{ result: TableResult; text: string; snapshotId: number }> {
  await ensureFocusEmulation(page);
  const result = (await page.evaluate(TABLE_JS)) as TableResult;
  const id = ++snapshotCounter;
  const pageId = [...sessions.values()].flatMap((s2) => [...s2.pages.entries()]).find(([, p]) => p === page)?.[0] ?? "unknown";
  snapshots.set(page, { id, pageId, url: result.url });
  const lines: string[] = [
    `snapshot #${id}  ${result.title || "(no title)"}`.slice(0, 140),
    `url: ${result.url}`,
    result.canScrollDown ? `scrollY=${result.scrollY} (more below → SCROLL_DOWN)` : `scrollY=${result.scrollY} (bottom)`,
    `elements (${result.items.length}):`,
  ];
  for (const it of result.items) {
    const ops = roleToOp(it.tag, it.role).filter((o) => o !== "CLICK" || true);
    const value = it.value && it.value !== it.name ? ` · "${it.value}"` : "";
    lines.push(`  [${it.i}] ${it.role.padEnd(10)} "${it.name}"${value}   ops:${ops.join(",")}`);
  }
  const text = lines.join("\n");
  lastTable = { text, snapshotId: id, pageId, url: result.url, title: result.title, at: new Date().toISOString() };
  return { result, text, snapshotId: id };
}
const CLICK_JS = `(idx) => {
  const el = document.querySelector('[data-llm-idx="' + idx + '"]');
  if (!el) return { ok: false, reason: 'element no longer present (page changed) — re-observe' };
  if (!el.isConnected) return { ok: false, reason: 'element detached — re-observe' };
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return { ok: false, reason: 'element is not visible' };
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
    return { ok: false, reason: 'element is outside the viewport — scroll first' };
  }
  const top = document.elementFromPoint(cx, cy);
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    return { ok: false, reason: 'element is covered by ' + (top.tagName || 'another element') + ' — re-observe' };
  }
  return { ok: true, box: { cx, cy, label: (el.getAttribute('aria-label') || el.innerText || el.value || '').slice(0, 40) } };
}`;

const TYPE_JS = `([idx, text]) => {
  const el = document.querySelector('[data-llm-idx="' + idx + '"]');
  if (!el) return { ok: false, reason: 'element no longer present — re-observe' };
  if (el.disabled) return { ok: false, reason: 'element is disabled' };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  el.focus();
  if (setter && setter.set) setter.set.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: String(el.value).slice(0, 60) };
}`;

const SELECT_JS = `([idx, label]) => {
  const el = document.querySelector('[data-llm-idx="' + idx + '"]');
  if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'not a native <select> — use CLICK then SELECT on an option' };
  const opt = [...el.options].find((o) => o.label.trim() === label.trim() || o.value === label);
  if (!opt) return { ok: false, reason: 'no option matching "' + label + '"' };
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: opt.label };
}`;

type Op = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";

export async function performAct(
  page: Page,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const op = (str(args, "op").toUpperCase() as Op) || "WAIT";
  const idx = num(args, "index", 0);
  const text = str(args, "text");
  const snap = snapshots.get(page);
  const providedSnap = num(args, "snapshotId", 0);
  if (op !== "WAIT" && op !== "SCROLL_UP" && op !== "SCROLL_DOWN") {
    if (!snap || (providedSnap > 0 && providedSnap !== snap.id)) {
      return { ok: false, message: `stale observation (snapshot #${snap?.id ?? "none"} vs #${providedSnap || "?"}) — call browser_table again first` };
    }
    if (idx <= 0) return { ok: false, message: "index is required (1-based, from browser_table)" };
  }

  switch (op) {
    case "CLICK": {
      const probe = (await page.evaluate(`(${CLICK_JS})(${idx})`)) as { ok: boolean; reason?: string; box?: { cx: number; cy: number; label: string } };
      if (!probe || !probe.ok || !probe.box) return { ok: false, message: probe?.reason ?? "click rejected" };
      await page.mouse.click(probe.box.cx, probe.box.cy);
      await page.waitForTimeout(120);
      return { ok: true, message: `CLICK [${idx}] "${probe.box.label}"` };
    }
    case "TYPE_TEXT": {
      if (!text) return { ok: false, message: "TYPE_TEXT needs text" };
      const probe = (await page.evaluate(`(${TYPE_JS})(${JSON.stringify([idx, text])})`)) as { ok: boolean; reason?: string; value?: string };
      if (!probe || !probe.ok) return { ok: false, message: probe?.reason ?? "type rejected" };
      await page.waitForTimeout(150); // allow suggestion lists to appear
      return { ok: true, message: `TYPE_TEXT [${idx}] → "${probe.value}"` };
    }
    case "SELECT": {
      const probe = (await page.evaluate(`(${SELECT_JS})(${JSON.stringify([idx, text])})`)) as { ok: boolean; reason?: string; value?: string };
      if (!probe || !probe.ok) return { ok: false, message: probe?.reason ?? "select rejected" };
      await page.waitForTimeout(120);
      return { ok: true, message: `SELECT [${idx}] → "${probe.value}"` };
    }
    case "SCROLL_UP":
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(120);
      return { ok: true, message: "SCROLL_UP" };
    case "SCROLL_DOWN":
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(120);
      return { ok: true, message: "SCROLL_DOWN" };
    case "WAIT": {
      const ms = Math.min(Math.max(num(args, "waitMs", 500), 50), 10_000);
      await page.waitForTimeout(ms);
      return { ok: true, message: `WAIT ${ms}ms` };
    }
    case "DONE":
      return { ok: true, message: "DONE noted — verify the outcome with browser_table / browser_eval before reporting success" };
    case "BLOCKED":
      return { ok: true, message: "BLOCKED noted — explain what stops the task (captcha, login, missing element)" };
    default:
      return { ok: false, message: `unsupported op: ${op}` };
  }
}

export async function closeBrowser(): Promise<void> {
  for (const session of [...sessions.keys()]) await closeBrowserSession(session);
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    browser = null;
  }
  recording = false;
  traceName = null;
  traceStartedAt = null;
  videoDir = null;
  lastVideoPath = null;
  lastTracePath = null;
  lastTable = null;
  actionLog.length = 0;
}

export const browserTools: Tool[] = [
  {
    name: "browser_open",
    description: "Open a new browser page and return its id plus an element snapshot. Optionally navigate to a URL.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Optional URL to open." } },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.cfg.policy.networkEnabled && str(args, "url").trim()) {
        return { ok: false, content: "network access is disabled in config" };
      }
      const url = str(args, "url").trim();
      if (url && !/^https?:\/\//i.test(url)) return { ok: false, content: "browser navigation requires an http(s) URL" };
      const session = browserSessionFor(ctx);
      const { id, page } = await newPage(ctx.cfg, session);
      if (session.startsWith("agent:")) void persistBrowserSession(session);
      // Default homepage from Settings > In-App Browser (if configured).
      const homepage = getSettings().browserHomepage?.trim();
      const target = url || (homepage && /^https?:\/\//i.test(homepage) ? homepage : "");
      if (target) await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const snap = (await page.evaluate(SNAPSHOT_JS)) as unknown;
      void emitLiveFrame(page, ctx);
      return { ok: true, content: `pageId=${id}\n${JSON.stringify(snap, null, 1)}` };
    },
  },
  {
    name: "browser_goto",
    description: "Navigate an existing page to a URL.",
    parameters: { type: "object", properties: { pageId: { type: "string" }, url: { type: "string" } }, required: ["pageId", "url"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.cfg.policy.networkEnabled) return { ok: false, content: "network access is disabled in config" };
      if (!/^https?:\/\//i.test(str(args, "url"))) return { ok: false, content: "browser navigation requires an http(s) URL" };
      const page = getPage(str(args, "pageId"));
      const res = await page.goto(str(args, "url"), { waitUntil: "domcontentloaded", timeout: 45_000 });
      logAction({ op: "GOTO", ok: true, message: str(args, "url"), url: page.url() });
      void emitLiveFrame(page, ctx);
      return { ok: true, content: `HTTP ${res?.status() ?? "?"} -> ${page.url()}` };
    },
  },
  {
    name: "browser_snapshot",
    description: "Return the current page title/url and a list of interactive elements with stable refs (use ref in click/type).",
    parameters: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      const snap = (await page.evaluate(SNAPSHOT_JS)) as unknown;
      return { ok: true, content: JSON.stringify(snap, null, 1) };
    },
  },
  {
    name: "browser_click",
    description: "Click an element by ref/selector, or by coordinates x,y.",
    parameters: {
      type: "object",
      properties: { pageId: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
      required: ["pageId"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      const x = args["x"];
      const y = args["y"];
      if (typeof x === "number" || typeof y === "number") {
        await page.mouse.click(num(args, "x", 0), num(args, "y", 0));
      } else {
        await page.click(sel(args), { timeout: 15_000 });
      }
      await page.waitForTimeout(250);
      void emitLiveFrame(page, ctx);
      return { ok: true, content: `clicked on ${page.url()}` };
    },
  },
  {
    name: "browser_type",
    description: "Type text into an element (replaces its content). Set submit=true to press Enter afterwards.",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        ref: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["pageId", "text"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      const target = sel(args);
      await page.fill(target, "");
      await page.type(target, str(args, "text"), { delay: 15 });
      if (bool(args, "submit")) await page.press(target, "Enter");
      void emitLiveFrame(page, ctx);
      return { ok: true, content: `typed ${str(args, "text").length} chars` };
    },
  },
  {
    name: "browser_press",
    description: "Press a keyboard key on the focused element (e.g. Enter, Tab, Control+A).",
    parameters: { type: "object", properties: { pageId: { type: "string" }, key: { type: "string" } }, required: ["pageId", "key"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      await page.keyboard.press(str(args, "key"));
      void emitLiveFrame(page, ctx);
      return { ok: true, content: `pressed ${str(args, "key")}` };
    },
  },
  {
    name: "browser_eval",
    description: "Evaluate a JavaScript expression inside the page and return its JSON result (advanced).",
    parameters: { type: "object", properties: { pageId: { type: "string" }, expression: { type: "string" } }, required: ["pageId", "expression"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      const result = (await page.evaluate(str(args, "expression"))) as unknown;
      return { ok: true, content: JSON.stringify(result, null, 1).slice(0, 8000) };
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the page into the workspace .screenshots folder. Returns the saved path.",
    parameters: {
      type: "object",
      properties: { pageId: { type: "string" }, fullPage: { type: "boolean" }, name: { type: "string" } },
      required: ["pageId"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      const dir = resolveWrite(ctx.workspace, ".screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const name = str(args, "name") || `browser_${Date.now()}`;
      const out = resolveWrite(ctx.workspace, path.join(dir, `${name}.png`));
      await page.screenshot({ path: out, fullPage: bool(args, "fullPage") });
      return { ok: true, content: `saved ${out} (${fs.statSync(out).size} bytes)` };
    },
  },
  {
    name: "browser_table",
    description:
      "FAST indexed observation (recommended): returns a numbered table of visible controls on the page (no screenshot). Then use browser_act with the OPERATION + INDEX. Prefer this over browser_snapshot for multi-step tasks.",
    parameters: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      const { text, snapshotId } = await buildTable(page);
      return { ok: true, content: `${text}\n\n(use browser_act with snapshotId=${snapshotId})` };
    },
  },
  {
    name: "browser_act",
    description:
      "Execute ONE action from the last browser_table: op ∈ CLICK | TYPE_TEXT | SELECT | SCROLL_UP | SCROLL_DOWN | WAIT | DONE | BLOCKED, with the element index. Targets are re-validated (freshness + occlusion) before dispatch; stale observations are rejected. Re-observe with browser_table after every action.",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        op: { type: "string", enum: ["CLICK", "TYPE_TEXT", "SELECT", "SCROLL_UP", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"] },
        index: { type: "number", description: "1-based element index from browser_table (required for CLICK/TYPE_TEXT/SELECT)." },
        text: { type: "string", description: "Text for TYPE_TEXT/SELECT (SELECT: the option label)." },
        snapshotId: { type: "number", description: "snapshot id printed by browser_table (guards against stale pages)." },
        waitMs: { type: "number", description: "For WAIT (default 500ms, max 10000)." },
      },
      required: ["pageId", "op"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const page = getPage(str(args, "pageId"));
      const res = await performAct(page, args);
      logAction({
        op: str(args, "op").toUpperCase() || "WAIT",
        index: args["index"] === undefined ? undefined : num(args, "index", 0),
        text: str(args, "text") || undefined,
        ok: res.ok,
        message: res.message,
        url: page.url(),
      });
      void emitLiveFrame(page, ctx);
      return { ok: res.ok, content: `${res.ok ? "OK" : "REJECTED"}: ${res.message}\n(now call browser_table to see the new state)` };
    },
  },
  {
    name: "browser_pages",
    description: "List open browser pages.",
    parameters: { type: "object", properties: {} },
    async run(): Promise<ToolResult> {
      const all = [...sessions.values()].flatMap((s2) => [...s2.pages.entries()]);
      if (all.length === 0) return { ok: true, content: "(no open pages)" };
      return { ok: true, content: all.map(([id, p]) => `${id}\t${p.url()}`).join("\n") };
    },
  },
  {
    name: "browser_close",
    description: "Close a browser page.",
    parameters: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const id = str(args, "pageId");
      let owner: { pages: Map<string, Page> } | undefined;
      for (const s2 of sessions.values()) if (s2.pages.has(id)) owner = s2;
      const page = owner?.pages.get(id);
      if (!page) return { ok: false, content: `no such page: ${id}` };
      await page.close();
      owner?.pages.delete(id);
      return { ok: true, content: `closed ${id}` };
    },
  },
  {
    name: "browser_trace_start",
    description:
      "Start recording the browser session: a video of the pages opened afterwards plus an action trace JSON (every CLICK/TYPE_TEXT/goto with its result). Closes any currently open pages.",
    parameters: { type: "object", properties: { name: { type: "string", description: "Recording name (default trace_<timestamp>)." } } },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const dir = path.join(ctx.cfg.workspace, ".browser-recordings");
      fs.mkdirSync(dir, { recursive: true });
      let closed = 0;
      // Recording restarts pages: close pages in THIS RUN's session (isolation
      // preserved — other companions' sessions keep their pages).
      const session = browserSessionFor(ctx);
      for (const [id, page] of [...(sessions.get(session)?.pages ?? [])]) {
        try {
          await page.close();
          closed += 1;
        } catch {
          /* ignore */
        }
        sessions.get(session)?.pages.delete(id);
      }
      recording = true;
      videoDir = dir;
      traceName = str(args, "name") || `trace_${Date.now()}`;
      traceStartedAt = new Date().toISOString();
      actionLog.length = 0;
      return { ok: true, content: `recording "${traceName}" started (closed ${closed} page(s))\noutput: ${dir}` };
    },
  },
  {
    name: "browser_trace_stop",
    description: "Stop recording: finalizes the video(s) and writes the action trace JSON. Returns the saved paths.",
    parameters: { type: "object", properties: {} },
    async run(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!recording) return { ok: false, content: "not recording (call browser_trace_start first)" };
      const name = traceName ?? `trace_${Date.now()}`;
      const dir = videoDir ?? path.join(ctx.cfg.workspace, ".browser-recordings");
      const rawVideos: string[] = [];
      const session = browserSessionFor(ctx);
      for (const [id, page] of [...(sessions.get(session)?.pages ?? [])]) {
        const video = page.video();
        try {
          await page.close();
        } catch {
          /* ignore */
        }
        if (video) {
          try {
            const p = await video.path();
            if (p) rawVideos.push(p);
          } catch {
            /* ignore */
          }
        }
        sessions.get(session)?.pages.delete(id);
      }
      await closeBrowserSession(session);
      recording = false;
      const kept: string[] = [];
      rawVideos.forEach((src, i) => {
        const dest = path.join(dir, rawVideos.length > 1 ? `${name}-${i + 1}.webm` : `${name}.webm`);
        try {
          fs.renameSync(src, dest);
          kept.push(dest);
        } catch {
          kept.push(src);
        }
      });
      lastVideoPath = kept[kept.length - 1] ?? null;
      const tracePath = path.join(dir, `${name}.json`);
      fs.writeFileSync(
        tracePath,
        JSON.stringify({ name, startedAt: traceStartedAt, stoppedAt: new Date().toISOString(), actions: actionLog }, null, 1),
        "utf8",
      );
      lastTracePath = tracePath;
      return {
        ok: true,
        content: `stopped.\nvideo: ${kept.join(", ") || "(none captured)"}\ntrace: ${tracePath} (${actionLog.length} actions)`,
      };
    },
  },
  {
    name: "browser_trace_status",
    description: "Report the browser session state: recording flag, open pages, last element table, recent actions, and last recording paths.",
    parameters: { type: "object", properties: {} },
    async run(): Promise<ToolResult> {
      const s = getBrowserState();
      return {
        ok: true,
        content: JSON.stringify(
          {
            recording: s.recording,
            traceName: s.traceName,
            pages: s.pages,
            lastTable: s.lastTable ? { snapshotId: s.lastTable.snapshotId, url: s.lastTable.url, title: s.lastTable.title } : null,
            recentActions: s.actions.slice(-10),
            lastVideoPath: s.lastVideoPath,
            lastTracePath: s.lastTracePath,
          },
          null,
          1,
        ),
      };
    },
  },
  {
    name: "browser_som",
    description:
      "Frontier Set-of-Mark (SoM) Vision Grounding: overlays high-contrast numbered badges ([1]..[N]) onto all interactive elements in the active page, captures a visual screenshot for the vision model, removes the temporary overlay cleanly, and returns the indexed grounding table.",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Optional page id (defaults to most recent page)." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const targetId = str(args, "pageId") || [...sessions.values()].flatMap((s2) => [...s2.pages.keys()]).pop() || "";
      if (!targetId) return { ok: false, content: "no open browser page (call browser_open first)" };
      const page = getPage(targetId);
      const somItems = (await page.evaluate(`(() => {
        const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="tab"]';
        const overlay = document.createElement('div');
        overlay.id = '__manus_som_overlay__';
        overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
        document.body.appendChild(overlay);
        const marks = [];
        let i = 0;
        for (const el of document.querySelectorAll(SEL)) {
          if (i >= 60) break;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
          i += 1;
          el.setAttribute('data-llm-idx', String(i));
          const box = document.createElement('div');
          box.style.cssText = 'position:fixed;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.top) + 'px;width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;border:2px solid #06b6d4;background:rgba(6,182,212,0.08);border-radius:4px;';
          const badge = document.createElement('span');
          badge.textContent = '#' + i;
          badge.style.cssText = 'position:absolute;top:-18px;left:0;background:#4f46e5;color:#fff;font:bold 11px monospace;padding:1px 5px;border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,0.4);';
          box.appendChild(badge);
          overlay.appendChild(box);
          const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || '').toString().replace(/\\s+/g, ' ').trim().slice(0, 60);
          marks.push({ index: i, tag: el.tagName.toLowerCase(), label, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        }
        return marks;
      })()`)) as Array<{ index: number; tag: string; label: string; x: number; y: number }>;

      let b64 = "";
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 82 });
        b64 = buf.toString("base64");
        const shotsDir = path.join(ctx.cfg.workspace, ".screenshots");
        fs.mkdirSync(shotsDir, { recursive: true });
        fs.writeFileSync(path.join(shotsDir, `som_${Date.now()}.jpg`), buf);
        void emitLiveFrame(page, ctx, b64);
      } finally {
        await page.evaluate(`(() => { const el = document.getElementById('__manus_som_overlay__'); if (el) el.remove(); })()`).catch(() => {});
      }

      const legend = somItems.map((m) => `[#${m.index}] <${m.tag}> "${m.label}" @(${m.x},${m.y})`).join("\n");
      return {
        ok: true,
        content: `Set-of-Mark Grounding (${somItems.length} elements marked on screenshot):\n${legend || "(no interactive elements in viewport)"}`,
        ...(b64 ? { images: [b64] } : {}),
      };
    },
  },
];
