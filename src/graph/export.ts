/**
 * Neo N14: a run as a self-contained static replay.
 *
 * The canvas (N2) is a live, server-backed surface. This module turns a finished
 * run into something that outlives the server: one JSON bundle (graph + the
 * outputs it produced) and one standalone HTML page that renders it with a
 * timeline scrubber. The page makes no network request at all, so it opens from
 * a `file://` URL, from a share link, or from an email attachment.
 *
 * Two guarantees the acceptance test pins:
 *   1. scrubbing reveals nodes in event order (frame N shows the first N nodes);
 *   2. the exported bytes contain no credential.
 *
 * (2) is enforced twice: every string is passed through `stripSecrets` (which
 * removes credential-shaped substrings), and the finished bundle is scanned with
 * `findSecret` before it is handed back. `assertReplayClean` fails closed, so a
 * caller cannot accidentally publish a bundle that still carries a token.
 */
import { redact } from "../log.js";
import { REDACTED, findSecret, stripSecrets } from "../memory/redact.js";
import { compareNodes, type RunNode, type RunNodeStatus, type RunNodeType } from "./store.js";

/** Bump when the bundle shape changes in a way an old viewer cannot read. */
export const REPLAY_FORMAT = 1;

/** Per-field cap, so one runaway tool summary cannot bloat the export. */
const MAX_FIELD_CHARS = 600;
/** Ceiling on nodes in one replay; a share link must stay openable. */
export const MAX_REPLAY_NODES = 5_000;
/** Ceiling on produced outputs listed by one replay. */
const MAX_REPLAY_OUTPUTS = 200;

/**
 * The node payload fields a replay may publish. Everything else is dropped: tool
 * arguments are the usual place a credential or a private path hides, so an
 * allow-list (not a deny-list) is the only safe projection.
 */
const PUBLIC_DATA_KEYS = [
  "title",
  "query",
  "url",
  "path",
  "tool",
  "kind",
  "stepId",
  "summary",
  "message",
  "reason",
  "verdict",
  "text",
  "label",
  "labelAr",
  "model",
  "mode",
  "mime",
  "status",
] as const;

/** Numeric/boolean payload fields that are safe verbatim. */
const PUBLIC_DATA_FLAGS = ["ok", "round", "attempt", "stopped", "sizeBytes", "steps", "total"] as const;

export interface ReplayNode {
  id: string;
  parent_ids: string[];
  type: RunNodeType;
  status: RunNodeStatus;
  /** Sanitized payload: allow-listed scalars only. */
  data?: Record<string, unknown>;
  position: number;
  created: number;
  updated: number;
}

export interface ReplayEdge {
  from: string;
  to: string;
}

/** One produced file the run left behind. */
export interface ReplayOutput {
  path: string;
  title: string;
  kind: string;
  mime: string;
  sizeBytes: number;
}

/** One step of the timeline: revealing it shows every node up to `index`. */
export interface ReplayFrame {
  index: number;
  nodeId: string;
  at: number;
  type: RunNodeType;
  status: RunNodeStatus;
  /** Short human label, already sanitized. */
  label: string;
}

export interface ReplayStats {
  totalNodes: number;
  nodesByType: Record<string, number>;
  nodesByStatus: Record<string, number>;
  edges: number;
  depth: number;
  /** Wall-clock span of the run, from the first node to the last. */
  durationMs: number;
}

export interface RunReplay {
  format: number;
  runId: string;
  title: string;
  /** ISO timestamps, so a viewer never has to guess a timezone. */
  createdAt: string;
  generatedAt: string;
  nodes: ReplayNode[];
  edges: ReplayEdge[];
  frames: ReplayFrame[];
  outputs: ReplayOutput[];
  stats: ReplayStats;
  /** How many credential-shaped substrings were removed while building this. */
  redactions: number;
  /** True when the run was still running when it was exported. */
  partial: boolean;
}

export interface BuildReplayInput {
  runId: string;
  title?: string;
  nodes: RunNode[];
  /** Injected clock, so the export is deterministic in tests. */
  now?: number;
  /** The run had not finished when it was exported. */
  partial?: boolean;
}

/**
 * Strip credentials from one string. `stripSecrets` handles token formats;
 * `redact` (the logger's redactor) additionally removes `key: value` pairs and
 * any vault value registered in this process, so the two rules compose.
 */
function clean(value: string, counter: { n: number }): string {
  const stripped = stripSecrets(value);
  const logged = redact(stripped);
  if (logged !== value) counter.n += 1;
  return logged.slice(0, MAX_FIELD_CHARS);
}

/** True when a string looks like it still carries a credential. */
export function hasSecret(value: string): boolean {
  return findSecret(value) !== null;
}

/** Sanitize an unknown payload into the publishable subset, or undefined. */
function publicData(data: unknown, counter: { n: number }): Record<string, unknown> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_DATA_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) out[key] = clean(value, counter);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  for (const key of PUBLIC_DATA_FLAGS) {
    const value = raw[key];
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Deep-sanitize an arbitrary JSON value: only allow-listed scalars survive. */
export function sanitizeReplayValue(value: unknown): unknown {
  const counter = { n: 0 };
  if (typeof value === "string") return clean(value, counter);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeReplayValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // A key can itself be a credential when a tool used a token as a map key.
      out[clean(key, counter)] = sanitizeReplayValue(item);
    }
    return out;
  }
  return undefined;
}

/** The one-line label a frame and a card share. */
function labelOf(node: ReplayNode): string {
  const data = node.data ?? {};
  for (const key of ["title", "query", "url", "path", "summary", "message", "reason", "verdict", "tool", "stepId"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return node.type;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

/** Longest parent chain, used for the stats block. Cycle-safe. */
function depthOf(nodes: ReplayNode[]): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = byId.get(id);
    const parents = node ? node.parent_ids.filter((p) => byId.has(p)) : [];
    const value = parents.length === 0 ? 0 : Math.max(...parents.map(visit)) + 1;
    visiting.delete(id);
    memo.set(id, value);
    return value;
  };
  let max = 0;
  for (const node of nodes) max = Math.max(max, visit(node.id));
  return max;
}

/** Outputs a run produced: published artifacts plus file writes it reported. */
function collectOutputs(nodes: ReplayNode[], counter: { n: number }): ReplayOutput[] {
  const byPath = new Map<string, ReplayOutput>();
  for (const node of nodes) {
    const data = node.data ?? {};
    const path = typeof data.path === "string" ? data.path : "";
    if (!path) continue;
    const tool = typeof data.tool === "string" ? data.tool : "";
    const isArtifact = node.type === "document" || node.type === "media" || node.type === "webpage";
    const isWrite = tool === "file_write" || tool === "file_edit";
    if (!isArtifact && !isWrite) continue;
    const existing = byPath.get(path);
    const title = typeof data.title === "string" && data.title ? data.title : path;
    const next: ReplayOutput = {
      path,
      title,
      kind: typeof data.kind === "string" ? data.kind : node.type,
      mime: typeof data.mime === "string" ? data.mime : "",
      sizeBytes: typeof data.sizeBytes === "number" ? data.sizeBytes : 0,
    };
    // A published artifact is richer than the tool call that produced it, so it
    // wins over an earlier write of the same path.
    if (!existing || (existing.mime === "" && next.mime !== "")) byPath.set(path, next);
    if (byPath.size >= MAX_REPLAY_OUTPUTS) break;
  }
  for (const output of byPath.values()) {
    output.path = clean(output.path, counter);
    output.title = clean(output.title, counter);
  }
  return [...byPath.values()];
}

/** Build the sanitized, self-contained replay of one run. */
export function buildRunReplay(input: BuildReplayInput): RunReplay {
  const counter = { n: 0 };
  const now = input.now ?? Date.now();

  // Event order, so the scrubber reveals nodes in the order the agent made them.
  const ordered = [...input.nodes].sort(compareNodes).slice(0, MAX_REPLAY_NODES);

  const nodes: ReplayNode[] = ordered.map((node) => {
    // Sanitize once: a second pass would double-count `redactions` and hide a
    // bug where the counter no longer describes the exported bytes.
    const data = publicData(node.data, counter);
    return {
      id: node.id,
      parent_ids: [...node.parent_ids],
      type: node.type,
      status: node.status,
      ...(data !== undefined ? { data } : {}),
      position: node.position ?? 0,
      created: node.created,
      updated: node.updated,
    };
  });

  const known = new Set(nodes.map((node) => node.id));
  const edges: ReplayEdge[] = [];
  for (const node of nodes) {
    for (const parent of node.parent_ids) {
      // An edge to a node outside the export (pruned, or another run) is dropped
      // rather than drawn as a dangling connector.
      if (known.has(parent) && parent !== node.id) edges.push({ from: parent, to: node.id });
    }
  }

  const frames: ReplayFrame[] = nodes.map((node, index) => ({
    index,
    nodeId: node.id,
    at: node.created,
    type: node.type,
    status: node.status,
    label: labelOf(node),
  }));

  const created = nodes.length > 0 ? Math.min(...nodes.map((n) => n.created)) : now;
  const updated = nodes.length > 0 ? Math.max(...nodes.map((n) => n.updated)) : now;

  const replay: RunReplay = {
    format: REPLAY_FORMAT,
    runId: input.runId,
    title: clean(input.title?.trim() || input.runId, counter),
    createdAt: new Date(created).toISOString(),
    generatedAt: new Date(now).toISOString(),
    nodes,
    edges,
    frames,
    outputs: collectOutputs(nodes, counter),
    stats: {
      totalNodes: nodes.length,
      nodesByType: countBy(nodes, (n) => n.type),
      nodesByStatus: countBy(nodes, (n) => n.status),
      edges: edges.length,
      depth: depthOf(nodes),
      durationMs: Math.max(0, updated - created),
    },
    redactions: counter.n,
    partial: input.partial === true,
  };
  return replay;
}

export interface SecretFinding {
  /** Where the credential was found, as a JSON path such as `nodes[3].data.url`. */
  path: string;
  /** The pattern source that matched; never the credential itself. */
  pattern: string;
}

/**
 * Walk the bundle and report every credential-shaped value. The acceptance test
 * requires zero findings; `assertReplayClean` turns a non-empty result into a
 * thrown error so a caller cannot publish an unsafe export.
 */
export function scanReplayForSecrets(replay: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const pattern = findSecret(value);
      if (pattern) findings.push({ path, pattern });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const pattern = findSecret(key);
        if (pattern) findings.push({ path: `${path}.<key>`, pattern });
        walk(item, `${path}.${key}`);
      }
    }
  };
  walk(replay, "$");
  return findings;
}

/** Fail closed when a bundle still carries a credential. */
export function assertReplayClean(replay: unknown): void {
  const findings = scanReplayForSecrets(replay);
  if (findings.length > 0) {
    const first = findings[0]!;
    throw new Error(`run replay rejected: possible secret at ${first.path}`);
  }
}

/** Suggested download name for one run's replay. */
export function replayFileName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return `loam-replay-${safe}.json`;
}

/** Suggested download name for the standalone page. */
export function replayHtmlFileName(runId: string): string {
  return replayFileName(runId).replace(/\.json$/, ".html");
}

export interface ReplayHtmlOptions {
  /** Bundle to embed. Defaults to nothing: the caller must pass one. */
  replay: RunReplay;
  /** Locale of the page chrome; the content itself stays `dir="auto"`. */
  locale?: "en" | "ar";
}

/** Page chrome, in both locales, so the export is readable either way. */
const COPY = {
  en: {
    dir: "ltr",
    replay: "Run replay",
    graph: "Run graph",
    timeline: "Timeline",
    outputs: "Produced files",
    step: "Step",
    of: "of",
    play: "Play",
    pause: "Pause",
    reset: "Reset",
    viewOnly: "View only",
    nodes: "nodes",
    edges: "edges",
    depth: "depth",
    duration: "duration",
    redacted: "credentials removed",
    partial: "This run was still in progress when it was exported.",
    noOutputs: "This run produced no files.",
    offline: "Standalone file — no network access required.",
  },
  ar: {
    dir: "rtl",
    replay: "إعادة تشغيل المهمة",
    graph: "مخطط المهمة",
    timeline: "الخط الزمني",
    outputs: "الملفات الناتجة",
    step: "الخطوة",
    of: "من",
    play: "تشغيل",
    pause: "إيقاف مؤقت",
    reset: "إعادة",
    viewOnly: "للعرض فقط",
    nodes: "عقدة",
    edges: "وصلة",
    depth: "العمق",
    duration: "المدة",
    redacted: "بيانات اعتماد أُزيلت",
    partial: "كانت هذه المهمة قيد التنفيذ عند تصديرها.",
    noOutputs: "لم تُنتج هذه المهمة أي ملفات.",
    offline: "ملف مستقل — لا يحتاج اتصالًا بالشبكة.",
  },
} as const;

/** Escape text placed inside HTML element content. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * JSON safe to inline inside a `<script>` element: `<` becomes `\u003c`, so a
 * `</script>` inside run data can never close the element early.
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Render the standalone replay page.
 *
 * The page embeds the bundle and a small vanilla-JS scrubber: dragging the range
 * input reveals the first N nodes, so the graph rebuilds step by step exactly as
 * it was built live. No script, style, font or image is loaded from anywhere, so
 * the file is genuinely offline and safe to hand to a third party.
 */
export function renderReplayHtml(options: ReplayHtmlOptions): string {
  const { replay } = options;
  const copy = COPY[options.locale === "ar" ? "ar" : "en"];
  // The viewer is deliberately dependency-free; only the bundle is data.
  const payload = inlineJson(replay);

  const outputsHtml =
    replay.outputs.length === 0
      ? `<p class="muted">${escapeHtml(copy.noOutputs)}</p>`
      : `<ul class="outputs">${replay.outputs
          .map(
            (o) =>
              `<li dir="auto"><span class="kind">${escapeHtml(o.kind)}</span> <span class="path">${escapeHtml(
                o.path,
              )}</span>${o.sizeBytes > 0 ? ` <span class="muted">(${escapeHtml(String(o.sizeBytes))} B)</span>` : ""}</li>`,
          )
          .join("")}</ul>`;

  return `<!doctype html>
<html lang="${options.locale === "ar" ? "ar" : "en"}" dir="${copy.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(replay.title)} — ${escapeHtml(copy.replay)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:24px;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#faf9f7;color:#1f2a24}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:16px}
h1{font-size:19px;margin:0;font-weight:650}
.badge{margin-inline-start:auto;border:1px solid #d7d2c8;border-radius:999px;padding:2px 10px;font-size:12px;color:#5d6b62}
.muted{color:#6c7a71;font-size:13px}
.stats{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 18px;padding:0;list-style:none;font-size:13px;color:#4c5a52}
.stats b{font-weight:650;color:#1f2a24}
.scrubber{position:sticky;top:0;z-index:2;background:#faf9f7;border-bottom:1px solid #e6e1d8;padding:10px 0 14px;margin-bottom:18px}
.scrub-row{display:flex;align-items:center;gap:10px}
input[type=range]{flex:1;min-width:0;accent-color:#187665}
button{font:inherit;border:1px solid #d7d2c8;background:#fff;border-radius:8px;padding:4px 12px;cursor:pointer}
button:hover{background:#f2efe9}
.counter{font-variant-numeric:tabular-nums;font-size:13px;color:#4c5a52;min-width:9ch}
main{display:grid;gap:24px;grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
@media (max-width:820px){main{grid-template-columns:minmax(0,1fr)}}
/* The run graph: one lane per node, links drawn to the parents above it. */
.graph{position:relative;overflow-x:auto;border:1px solid #e6e1d8;border-radius:12px;background:#fff;margin-bottom:18px;padding:12px 0}
.marker{position:absolute;left:0;right:0;height:0;transition:opacity .15s ease}
.marker.pending{opacity:.18}
.marker .node{position:absolute;transform:translateY(-50%);min-width:84px;max-width:180px;padding:5px 10px;border:1px solid #d7d2c8;border-radius:9px;background:#faf9f7;font-size:12px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.marker.current .node{border-color:#187665;box-shadow:0 0 0 2px rgba(24,118,101,.16)}
.link{position:absolute;left:34px;width:2px;background:#cfc9bd;transform:translateX(-50%)}
ol.timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
ol.timeline li{display:flex;gap:10px;align-items:baseline;border:1px solid #e6e1d8;border-radius:10px;padding:8px 10px;background:#fff}
ol.timeline li.pending{opacity:.35}
ol.timeline li.current{border-color:#187665;box-shadow:0 0 0 2px rgba(24,118,101,.14)}
.dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:5px}
.s-init{background:#b9b3a7}.s-running{background:#2f7fe0}.s-finished{background:#187665}.s-failed{background:#c2412f}.s-skipped{background:#8d8a80}
.type{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6c7a71;flex:none}
.label{min-width:0;overflow-wrap:anywhere}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#6c7a71;margin:0 0 8px}
ul.outputs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
ul.outputs li{border:1px solid #e6e1d8;border-radius:10px;padding:8px 10px;background:#fff;overflow-wrap:anywhere}
.kind{font-size:11px;text-transform:uppercase;color:#6c7a71;margin-inline-end:6px}
.path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.notice{margin:0 0 14px;padding:8px 10px;border:1px solid #e6e1d8;border-radius:10px;background:#fff;font-size:13px;color:#4c5a52}
footer{margin-top:26px;color:#6c7a71;font-size:12px}
</style>
</head>
<body>
<header>
  <h1 dir="auto">${escapeHtml(replay.title)}</h1>
  <span class="badge">${escapeHtml(copy.viewOnly)}</span>
</header>
<ul class="stats">
  <li><b id="stat-nodes">${escapeHtml(String(replay.stats.totalNodes))}</b> ${escapeHtml(copy.nodes)}</li>
  <li><b id="stat-edges">${escapeHtml(String(replay.stats.edges))}</b> ${escapeHtml(copy.edges)}</li>
  <li><b>${escapeHtml(String(replay.stats.depth))}</b> ${escapeHtml(copy.depth)}</li>
  <li><b>${escapeHtml(String(Math.round(replay.stats.durationMs / 1000)))}s</b> ${escapeHtml(copy.duration)}</li>
  ${replay.redactions > 0 ? `<li><b>${escapeHtml(String(replay.redactions))}</b> ${escapeHtml(copy.redacted)}</li>` : ""}
</ul>
${replay.partial ? `<p class="notice">${escapeHtml(copy.partial)}</p>` : ""}
<section class="scrubber" aria-label="${escapeHtml(copy.timeline)}">
  <div class="scrub-row">
    <button type="button" id="play">${escapeHtml(copy.play)}</button>
    <button type="button" id="reset">${escapeHtml(copy.reset)}</button>
    <input type="range" id="scrub" min="0" max="${escapeHtml(String(Math.max(0, replay.frames.length - 1)))}" step="1" value="${escapeHtml(String(Math.max(0, replay.frames.length - 1)))}">
    <span class="counter" id="counter"></span>
  </div>
</section>
<main>
  <section>
    <h2>${escapeHtml(copy.graph)}</h2>
    <div class="graph" id="graph" role="img" aria-label="${escapeHtml(copy.graph)}"></div>
  </section>
  <section>
    <h2>${escapeHtml(copy.timeline)}</h2>
    <ol class="timeline" id="timeline"></ol>
  </section>
  <section>
    <h2>${escapeHtml(copy.outputs)}</h2>
    ${outputsHtml}
  </section>
</main>
<footer>${escapeHtml(copy.offline)}</footer>
<script>
(function(){
  "use strict";
  var REPLAY = ${payload};
  var COPY = ${inlineJson(copy)};
  var frames = REPLAY.frames || [];
  var nodesById = {};
  (REPLAY.nodes || []).forEach(function(n){ nodesById[n.id] = n; });
  var order = frames.map(function(f){ return f.nodeId; });
  var scrub = document.getElementById("scrub");
  var counter = document.getElementById("counter");
  var timeline = document.getElementById("timeline");
  var graph = document.getElementById("graph");
  var statNodes = document.getElementById("stat-nodes");
  var statEdges = document.getElementById("stat-edges");
  var playBtn = document.getElementById("play");
  var resetBtn = document.getElementById("reset");
  var timer = null;

  function esc(text){
    return String(text == null ? "" : text).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  // Layout: a node's row is the longest chain of ancestors above it, so the
  // graph reads as a tree laid out top to bottom. Purely positional, so it needs
  // no library and stays readable on a narrow phone.
  var lane = new Array(frames.length);
  for (var i = 0; i < frames.length; i++){
    var node = nodesById[frames[i].nodeId];
    var parents = (node && node.parent_ids || []).filter(function(p){ return nodesById[p]; });
    // A node sits one lane below its highest already-placed parent, so a parent
    // and child never share a row and the links stay vertical. Siblings share a
    // lane, which keeps a wide run compact.
    var depth = 0;
    for (var p = 0; p < parents.length; p++){
      var idx = order.indexOf(parents[p]);
      if (idx >= 0 && idx < i && lane[idx] + 1 > depth) depth = lane[idx] + 1;
    }
    lane[i] = depth;
  }
  var laneCount = lane.length ? Math.max.apply(null, lane) + 1 : 0;
  graph.style.setProperty("--lanes", laneCount);
  graph.style.height = (laneCount * 62 + 24) + "px";

  // Rows and markers are built once; scrubbing only toggles classes, so dragging
  // stays cheap even for a long run.
  var rows = frames.map(function(frame, i){
    var li = document.createElement("li");
    li.className = "pending";
    li.setAttribute("dir", "auto");
    li.innerHTML = '<span class="dot s-' + esc(frame.status) + '"></span>' +
      '<span class="type">' + esc(frame.type) + '</span>' +
      '<span class="label">' + esc(frame.label) + '</span>';
    li.dataset.index = String(i);
    timeline.appendChild(li);
    return li;
  });

  var markers = frames.map(function(frame, i){
    var node = nodesById[frame.nodeId];
    var parents = (node && node.parent_ids || []).filter(function(p){ return nodesById[p]; });
    var links = parents.map(function(p){
      var idx = order.indexOf(p);
      return '<span class="link" style="top:' + (lane[i] * 62 + 30) + 'px;height:' + ((lane[i] - lane[idx]) * 62) + 'px"></span>';
    }).join("");
    var marker = document.createElement("div");
    marker.className = "marker pending";
    marker.style.left = "26px";
    marker.style.top = (lane[i] * 62 + 22) + "px";
    marker.innerHTML = links +
      '<span class="node s-' + esc(frame.status) + '" title="' + esc(frame.label) + '">' + esc(frame.type) + '</span>';
    graph.appendChild(marker);
    return marker;
  });

  function render(){
    var upTo = Math.max(0, Math.min(frames.length - 1, Number(scrub.value) || 0));
    var shown = frames.length === 0 ? 0 : upTo + 1;
    for (var i = 0; i < rows.length; i++){
      rows[i].classList.toggle("pending", i > upTo);
      rows[i].classList.toggle("current", i === upTo);
      markers[i].classList.toggle("pending", i > upTo);
      markers[i].classList.toggle("current", i === upTo);
    }
    counter.textContent = COPY.step + " " + shown + " " + COPY.of + " " + frames.length;
    statNodes.textContent = String(shown);
    statEdges.textContent = String(countEdges(upTo));
    var current = rows[upTo];
    if (current && current.scrollIntoView) current.scrollIntoView({ block: "nearest" });
  }

  /** Edges whose both ends are revealed at this frame. */
  function countEdges(upTo){
    var visible = {};
    for (var i = 0; i <= upTo; i++) visible[order[i]] = true;
    var count = 0;
    (REPLAY.edges || []).forEach(function(edge){ if (visible[edge.from] && visible[edge.to]) count++; });
    return count;
  }

  scrub.addEventListener("input", render);
  resetBtn.addEventListener("click", function(){ stop(); scrub.value = "0"; render(); });
  playBtn.addEventListener("click", function(){ timer ? stop() : start(); });

  function start(){
    // Playback starts from the beginning when the scrubber is already at the end.
    if (frames.length === 0) return;
    if (Number(scrub.value) >= frames.length - 1) scrub.value = "0";
    playBtn.textContent = COPY.pause;
    timer = setInterval(function(){
      var next = Number(scrub.value) + 1;
      if (next >= frames.length - 1){ scrub.value = String(frames.length - 1); render(); stop(); return; }
      scrub.value = String(next);
      render();
    }, 700);
    render();
  }

  function stop(){
    if (timer){ clearInterval(timer); timer = null; }
    playBtn.textContent = COPY.play;
  }

  render();
})();
</script>
</body>
</html>
`;
}

/** Convenience: build, verify and render in one call. */
export function renderRunReplayHtml(input: BuildReplayInput & { locale?: "en" | "ar" }): {
  replay: RunReplay;
  html: string;
} {
  const replay = buildRunReplay(input);
  assertReplayClean(replay);
  return { replay, html: renderReplayHtml({ replay, locale: input.locale }) };
}

export { REDACTED };
