/**
 * MF7: URL-change triggers ("url-watch" routines). The server polls a URL on a
 * caller-chosen interval (minimum 5 minutes — no per-page nagging), extracts
 * text (optionally scoped to a CSS-like selector or a regex), hashes it, and
 * only when the hash changes creates a task for the routine's agent whose
 * prompt carries a short unified diff of the old vs. new text. Unchanged
 * pages cost nothing: no model call, no task.
 *
 * Connectors: watchConnector(kind, fetcher) lets future connectors (GitHub
 * issues, Gmail search …) plug their own content fetch into the same
 * fetch → extract → hash → diff loop; a schedule with watchConnector=<kind>
 * routes its content through the registry instead of a raw HTTP fetch.
 */
import crypto from "node:crypto";
import { addSchedule, deleteSchedule, listSchedules, getTask, updateUrlWatchState, markScheduleRun } from "./db.js";
import { getAgent } from "./agents.js";
import { log } from "../log.js";
import { BoundedMap } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";

export const MIN_URL_WATCH_INTERVAL_SECONDS = 5 * 60;
/** Single fetch deadline; a hung endpoint must not wedge the poll loop. */
const FETCH_TIMEOUT_MS = 20_000;
/** Text cap per watch, both for hashing and for the diff that enters a prompt. */
const MAX_WATCH_TEXT = 20_000;
const MAX_SNIPPET = 2000;
const MAX_DIFF_LINES = 4000;

// ---------------------------------------------------------------------------
// Connector registry (MF7): generic hook so connectors plug in their content.
// ---------------------------------------------------------------------------

/** Fetch the textual content to hash for a watch of connector `kind`. */
export type WatchContentFetcher = (input: { url: string; scheduleId: string }) => Promise<string>;

/**
 * Registered connector fetchers (J6). Previously an unbounded map: any code
 * path that called `watchConnector` with a fresh kind accumulated a permanent
 * entry. Bounded LRU; the unregister closure returned by `watchConnector` still
 * removes its own entry.
 */
const connectorFetchers = new BoundedMap<string, WatchContentFetcher>(64, "url-watch-connectors");
registerCacheStats("url-watch-connectors", () => connectorFetchers.stats());

/** Register a connector-backed content fetcher for kind (e.g. "github-issues"). */
export function watchConnector(kind: string, fetcher: WatchContentFetcher): () => void {
  connectorFetchers.set(kind, fetcher);
  return () => { if (connectorFetchers.get(kind) === fetcher) connectorFetchers.delete(kind); };
}

export function getConnector(kind: string): WatchContentFetcher | undefined {
  return connectorFetchers.get(kind);
}

export function listConnectors(): string[] {
  return [...connectorFetchers.keys()];
}

// ---------------------------------------------------------------------------
// Text extraction (CSS-like selector or regex), hashing, diffing.
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/** First block in `html` whose start tag matches the selector; tag-stripped. */
function pickElement(html: string, selector: string): string | null {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openPattern =
    selector.startsWith("#")
      ? new RegExp(`<(\\w+)[^>]*\\bid\\s*=\\s*["']?${escape(selector.slice(1))}["']?\\b[^<>]*?>`, "i")
      : selector.startsWith(".")
        ? new RegExp(`<(\\w+)[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escape(selector.slice(1))}\\b[^"']*["'][^<>]*?>`, "i")
        : /^[a-z][a-z0-9-]*$/i.test(selector)
          ? new RegExp(`<${escape(selector)}(\\s[^>]*)?>`, "i")
          : null;
  if (!openPattern) return null;
  const open = openPattern.exec(html);
  if (!open) return null;
  const name = open[1] ?? selector;
  const from = open.index;
  const close = new RegExp(`</\\s*${escape(name)}\\s*>`, "i").exec(html.slice(from + open[0].length));
  const body = close ? html.slice(from + open[0].length, from + open[0].length + close.index) : html.slice(from + open[0].length);
  return stripHtml(body);
}

/**
 * Extract watchable text. `selector` forms:
 *  `/pattern/flags` or `re:pattern` — every regex match, one per line;
 *  `#id` / `.class` / `tag` — first matching element, tag-stripped;
 *  absent — full page text with scripts/styles dropped.
 */
export function extractWatchText(raw: string, selector?: string): string {
  const input = raw.length > MAX_WATCH_TEXT * 4 ? raw.slice(0, MAX_WATCH_TEXT * 4) : raw;
  const sel = (selector ?? "").trim();
  if (sel) {
    const isRegex = (sel.startsWith("/") && sel.slice(1).includes("/")) || sel.startsWith("re:");
    if (isRegex) {
      const body = sel.startsWith("re:") ? sel.slice(3) : sel.slice(1, sel.lastIndexOf("/"));
      let flags = sel.startsWith("re:") ? "" : sel.slice(sel.lastIndexOf("/") + 1) || "";
      if (!flags.includes("g")) flags += "g";
      try {
        const matches = input.match(new RegExp(body, flags));
        const text = matches ? matches.filter((m) => m.length > 0).join("\n") : "";
        return text.slice(0, MAX_WATCH_TEXT);
      } catch {
        // a broken regex falls through to the whole page; never wedge the loop
      }
    }
    const picked = pickElement(input, sel);
    if (picked !== null && picked.length > 0) return picked.slice(0, MAX_WATCH_TEXT);
    return ""; // a scoped read that matched nothing is empty, never the whole page
  }
  return stripHtml(input).slice(0, MAX_WATCH_TEXT);
}

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/**
 * Short unified diff of old vs. new text (original LCS implementation, no
 * dependency). Context 2 lines; line counts are capped for memory safety.
 */
export function unifiedDiff(before: string, after: string, context = 2): string {
  const oldLines = before.split("\n").slice(0, MAX_DIFF_LINES);
  const newLines = after.split("\n").slice(0, MAX_DIFF_LINES);
  const n = oldLines.length;
  const m = newLines.length;
  let ops: Array<{ type: "same" | "del" | "add"; text: string }>;
  if (n * m > 4_000_000) {
    ops = [
      ...oldLines.map((text) => ({ type: "del" as const, text })),
      ...newLines.map((text) => ({ type: "add" as const, text })),
    ];
  } else {
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldLines[i] === newLines[j]) { ops.push({ type: "same", text: oldLines[i]! }); i++; j++; }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { ops.push({ type: "del", text: oldLines[i]! }); i++; }
      else { ops.push({ type: "add", text: newLines[j]! }); j++; }
    }
    while (i < n) { ops.push({ type: "del", text: oldLines[i]! }); i++; }
    while (j < m) { ops.push({ type: "add", text: newLines[j]! }); j++; }
  }

  type Line = string;
  const hunks: string[] = [];
  let idx = 0;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx]!.type === "same") idx++;
    if (idx >= ops.length) break;
    const startChange = idx;
    while (idx < ops.length && ops[idx]!.type !== "same") idx++;
    const endChange = idx;

    const pre = ops.slice(Math.max(0, startChange - context), startChange);
    const beforeLine = Math.max(0, startChange - context);
    // Post context: same-line run after the change, cut at `context` unless
    // more changes follow immediately.
    const post: typeof ops = [];
    let tail = idx;
    let pending = context;
    while (tail < ops.length && pending > 0) {
      if (ops[tail]!.type === "same") {
        const hasMoreChanges = ops.slice(tail + 1, tail + pending + 1).some((o) => o.type !== "same");
        post.push(ops[tail]!);
        tail++;
        if (!hasMoreChanges) pending--;
        else pending = context;
      } else break;
    }
    // Trailing end of the op stream: no further change possible.
    if (idx >= ops.length) {
      post.length = 0;
      tail = idx;
    }
    void beforeLine;

    let oldStart = 0;
    let newStart = 0;
    for (let k = 0; k < Math.max(0, startChange - context); k++) {
      if (ops[k]!.type !== "add") oldStart++;
      if (ops[k]!.type !== "del") newStart++;
    }
    const oldCount = [...pre, ...ops.slice(startChange, endChange), ...post].filter((o) => o.type !== "add").length;
    const newCount = [...pre, ...ops.slice(startChange, endChange), ...post].filter((o) => o.type !== "del").length;
    const lines: Line[] = [];
    lines.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`);
    for (const o of pre) lines.push((o.type === "add" ? "+" : "-") + o.text);
    for (const o of ops.slice(startChange, endChange)) lines.push((o.type === "add" ? "+" : "-") + o.text);
    for (const o of post) lines.push((o.type === "add" ? "+" : "-") + o.text);
    hunks.push(lines.join("\n"));
    idx = Math.max(endChange, tail);
  }
  if (hunks.length === 0) {
    return `@@ old=${oldLines.length} new=${m} @@\n+ (${oldLines.length === 0 && m > 0 ? "new content" : oldLines.length > 0 && m === 0 ? "content emptied" : "text fully rewritten — old and new share no context"})`;
  }
  return hunks.join("\n");
}

/** Clamp a requested interval to the 5-minute floor. */
export function clampWatchIntervalSeconds(intervalSeconds: number): number {
  return Math.max(MIN_URL_WATCH_INTERVAL_SECONDS, Math.floor(intervalSeconds));
}

// ---------------------------------------------------------------------------
// Create the routine and poll due schedules.
// ---------------------------------------------------------------------------

export interface UrlWatchInput {
  url: string;
  intervalSeconds?: number;
  selector?: string;
  connector?: string;
  prompt: string;
  agentId?: string;
  workMode?: string;
}

export interface UrlWatchCreateResult {
  scheduleId: string;
  url: string;
  intervalSeconds: number;
}

/** Create a url-watch routine end-to-end (API/tool entry). */
export function createUrlWatch(input: UrlWatchInput): UrlWatchCreateResult | { error: string } {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) return { error: "عنوان URL غير صالح (http/https فقط)" };
  const prompt = input.prompt.trim();
  if (!prompt) return { error: "prompt مطلوب" };
  const interval = clampWatchIntervalSeconds(input.intervalSeconds ?? MIN_URL_WATCH_INTERVAL_SECONDS);
  const s = addSchedule(prompt, interval, input.agentId, input.workMode, "url-watch", url);
  updateUrlWatchState(s.id, {
    ...(input.selector?.trim() ? { watchSelector: input.selector.trim() } : {}),
    ...(input.connector?.trim() ? { watchConnector: input.connector.trim() } : {}),
    lastWatchCheckedAt: undefined,
  });
  return { scheduleId: s.id, url, intervalSeconds: interval };
}

export interface UrlWatchDeps {
  run: (opts: { prompt: string; scheduleId: string; agentId?: string; workMode?: string }) => Promise<string>;
  /** Injection seam for tests/mock connectors; default is global fetch with a timeout. */
  fetcher?: WatchContentFetcher;
  intervalMs?: number;
  timeoutMs?: number;
  /** Test seam: replaces the per-schedule interval gate of the due check. */
  dueEverySeconds?: number;
}

/** Active url watches (id, url, interval, optional selector). */
export function watchList(): Array<{ id: string; url: string; intervalSeconds: number; selector?: string }> {
  return listSchedules()
    .filter((s) => s.kind === "url-watch")
    .map((s) => ({ id: s.id, url: s.watchPath ?? "", intervalSeconds: s.intervalSeconds, ...(s.watchSelector ? { selector: s.watchSelector } : {}) }));
}

const runIsBusy = (status: string): boolean => ["queued", "running", "interrupted"].includes(status);

/** One poll cycle: check every due url-watch; fire the agent only on change. */
async function pollOnce(deps: UrlWatchDeps): Promise<void> {
  const now = new Date();
  for (const s of listSchedules()) {
    if (s.kind !== "url-watch" || !s.enabled) continue;
    if (s.agentId && getAgent(s.agentId)?.archivedAt) continue;
    const last = s.lastWatchCheckedAt ? Date.parse(s.lastWatchCheckedAt) : Number.NaN;
    const gateSeconds = Math.max(0, deps.dueEverySeconds ?? s.intervalSeconds);
    if (!Number.isNaN(last) && now.getTime() - last < gateSeconds * 1000) continue;
    if (!s.watchPath) continue;

    let raw: string | null = null;
    try {
      raw = deps.fetcher
        ? await deps.fetcher({ url: s.watchPath, scheduleId: s.id })
        : await defaultFetch(s.watchPath, s.watchConnector, s.id, deps.timeoutMs);
    } catch (err) {
      log.warn(`url-watch ${s.id}: fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const fetchedAt = now.toISOString();
    if (raw === null) {
      void updateUrlWatchState(s.id, { lastWatchCheckedAt: fetchedAt });
      continue;
    }
    const text = extractWatchText(raw, s.watchSelector);
    const hash = hashText(text);
    const previousHash = s.lastWatchHash;

    if (previousHash === undefined) {
      // First successful read: record the baseline, no task, no model call.
      void updateUrlWatchState(s.id, { lastWatchHash: hash, lastWatchSnippet: text.slice(0, MAX_SNIPPET), lastWatchCheckedAt: fetchedAt });
      continue;
    }

    if (hash === previousHash) {
      void updateUrlWatchState(s.id, { lastWatchCheckedAt: fetchedAt });
      continue; // unchanged → no model call
    }

    const previousRun = s.lastTaskId ? getTask(s.lastTaskId) : undefined;
    if (previousRun && runIsBusy(previousRun.status)) {
      log.info(`url-watch ${s.id}: change detected while a run is in flight; skipped this cycle`);
      void updateUrlWatchState(s.id, { lastWatchCheckedAt: fetchedAt });
      continue;
    }

    const diff = unifiedDiff(s.lastWatchSnippet ?? "", text);
    const prompt =
      `${s.prompt}\n\n` +
      `تغيّر محتوى المراقب: ${s.watchPath}\n` +
      "```diff\n" + diff + "\n```\n" +
      `المقتطف الحالي: ${text.slice(0, 400)}`;
    log.info(`url-watch ${s.id}: fired (content changed)`);
    try {
      const taskId = await deps.run({
        prompt,
        scheduleId: s.id,
        ...(s.agentId ? { agentId: s.agentId } : {}),
        ...(s.workMode ? { workMode: s.workMode } : {}),
      });
      void updateUrlWatchState(s.id, {
        lastWatchHash: hash,
        lastWatchSnippet: text.slice(0, MAX_SNIPPET),
        lastWatchCheckedAt: fetchedAt,
        lastWatchChangedAt: fetchedAt,
      });
      markScheduleRun(s.id, taskId);
    } catch (err) {
      log.warn(`url-watch ${s.id}: run failed: ${err instanceof Error ? err.message : String(err)}`);
      void updateUrlWatchState(s.id, { lastWatchHash: hash, lastWatchSnippet: text.slice(0, MAX_SNIPPET), lastWatchCheckedAt: fetchedAt, lastWatchChangedAt: fetchedAt });
    }
  }
}

async function defaultFetch(url: string, connectorKind: string | undefined, scheduleId: string, timeoutMs?: number): Promise<string> {
  if (connectorKind) {
    const connector = connectorFetchers.get(connectorKind);
    if (!connector) throw new Error(`connector «${connectorKind}» غير مسجل`);
    return connector({ url, scheduleId });
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? FETCH_TIMEOUT_MS), redirect: "follow" });
  return `${String(res.status)}\n\n${await res.text()}`;
}

export function startUrlWatchers(deps: UrlWatchDeps): () => void {
  const intervalMs = deps.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    void pollOnce(deps).catch((err) => log.warn(`url-watch poll failed: ${err instanceof Error ? err.message : String(err)}`));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Delete a url-watch routine (stops nothing else; the poller reads the store). */
export function deleteUrlWatch(scheduleId: string): boolean {
  return deleteSchedule(scheduleId);
}

// ---------------------------------------------------------------------------
// Built-in connectors (MF7): GitHub issues — the one real connector, enabled
// because a token API exists (GITHUB_TOKEN / GH_TOKEN, same as skillsRegistry).
// ---------------------------------------------------------------------------

/**
 * GitHub issues connector: `url` may be "owner/repo[:label]" or a full
 * api.github.com issues URL. Returns the issue list as stable text lines.
 * Without a token the unauthenticated limit still works but is rate-capped.
 */
export function githubIssuesFetcher(input: { url: string; scheduleId: string }): Promise<string> {
  const target = input.url.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/issues$/i, "");
  const [repoPart, labelPart] = target.split(":");
  const api = /^https:\/\/api\.github\.com\//i.test(target)
    ? target
    : `https://api.github.com/repos/${repoPart}/issues${labelPart ? `?labels=${encodeURIComponent(labelPart)}&` : "?"}per_page=50&state=all&sort=updated`;
  const headers: Record<string, string> = {
    "user-agent": "loam-url-watch",
    accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(api, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(async (res) => {
    if (!res.ok) throw new Error(`github issues fetch failed: ${res.status}`);
    const items = (await res.json()) as Array<{ number: number; title: string; state: string; updated_at: string }>;
    if (!Array.isArray(items)) throw new Error("github issues response was not a list");
    return items
      .map((i) => `#${i.number} [${i.state}] ${i.title} (${i.updated_at})`)
      .join("\n");
  });
}

/** Idempotent registration of the built-in connectors (server boot). */
export function registerBuiltInConnectors(): void {
  if (!connectorFetchers.has("github-issues")) watchConnector("github-issues", githubIssuesFetcher);
}
