// Adapted from jcode (MIT) ref/SESSION_HIBERNATION.md and ref/bench_memory_cli.py.
//
// J7 acceptance: measure the *renderer* working set before and after a real idle
// hibernation of an open chat view. J2/J6 measured the server process tree; this
// one measures the Electron renderer that holds the rendered transcript, because
// that is where J7's release actually happens.
//
// The renderer is launched through the same Playwright Electron harness the e2e
// suite uses. The reading comes from J6's `debug:memory` surface
// (`window.__apis.debugMemory.refresh()`), which re-derives the renderer total on
// demand instead of waiting for the 15 s sampler tick, so the BEFORE/AFTER pair is
// exact. If that surface is unavailable the bench falls back to reading
// `app.getAppMetrics()` from the main process, and records which source was used.
//
// Three things have to be true before the view will render at all, and each one
// was established by measurement rather than assumption:
//
//  1. The desktop session token is read once at startup from
//     `<userData>/localStorage.json`, so the bench seeds that file before launch.
//     Without it the app shell bounces to `/login`.
//  2. The renderer's API and socket base are the app's own loopback backend, and
//     `app://agent` is a different origin, so the loopback mock must answer CORS
//     preflights. Without the headers every call fails.
//  3. The chat view treats a failed socket handshake as an auth failure and
//     redirects to `/login`, so the mock serves a real socket.io endpoint rather
//     than an empty route.
//
// Everything is offline and local: the app is launched from this worktree, the
// Agent Studio UI is served over its own app:// origin, and a loopback server
// answers the few API calls the view makes. No model is called, no telemetry, no
// data leaves the machine.
//
// The measurement is deliberately honest (see SESSION_HIBERNATION.md): the
// numbers are recorded as measured, a flat result is reported as flat, and
// `unavailableReason` explains exactly what could not be sampled.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);

/** Root of the repo (this file lives in bench/). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Default number of canonical messages the fixture renders. */
export const DEFAULT_FIXTURE_MESSAGES = 2000;

/** The session the bench drives. */
export const BENCH_SESSION_UID = "j7-renderer-bench";

/** The desktop session token the bench seeds, so the app shell does not redirect. */
export const BENCH_SESSION_TOKEN = "j7-bench-token";

/** The draft text the bench types before hibernating, to check it survives. */
export const BENCH_DRAFT_TEXT = "draft preserved across hibernation";

/**
 * Default loopback port for the mock backend. The renderer resolves its API and
 * socket base to the app's own backend, so the mock has to answer there.
 */
export const DEFAULT_API_PORT = 8787;

/** Default port for the app's own loopback base (`LOAM_PORT`). */
export const DEFAULT_APP_PORT = 3971;

/** One renderer RSS reading, in MB. */
export interface RendererSample {
  /** Epoch ms of the reading. */
  at: number;
  /** Working set in MB summed over the counted processes. */
  totalMB: number;
  /** How many processes were counted. */
  processCount: number;
  /** Pids of the renderer processes counted (best effort). */
  pids?: number[];
  /** Where the reading came from. */
  source: SampleSource;
}

/** Which surface produced a reading. */
export type SampleSource = "debug:memory" | "app-metrics";

/** One `app.getAppMetrics()` row, narrowed to what the sampler needs. */
export interface RendererMetric {
  pid: number;
  type: string;
  memory?: { workingSetSize?: number };
}

/** The renderer-side observations the bench reads from the page. */
export interface RendererHookReading {
  /** True when the fixture transcript was actually rendered before release. */
  rendered: boolean;
  /** True when no message rows were left mounted after the release. */
  domReleased: boolean;
  /** Canonical event count the hibernated view still reports. */
  eventCount: number;
  /** Draft text still present in the composer after wake. */
  draft: string | null;
  /** The hibernation hook was present. */
  hookAvailable: boolean;
}

export interface RendererBenchReport {
  /** Always "renderer-hibernation" so a report is identifiable without its name. */
  kind: "renderer-hibernation";
  /** The fixture size the transcript was built from. */
  fixtureMessages: number;
  /** Renderer working set with the full transcript rendered. */
  beforeMB: number;
  /** Renderer working set after the derived render state was released. */
  afterMB: number;
  /** Signed change: after - before (negative means memory was returned). */
  deltaMB: number;
  /** True when the release produced a meaningful reduction. */
  released: boolean;
  /** True when the renderer could not be sampled at all. */
  unavailable: boolean;
  /** Why the measurement is unavailable, when it is. */
  unavailableReason?: string;
  /** True when the transcript was actually rendered before the release. */
  rendered: boolean;
  /** True when no message rows were left mounted after the release. */
  domReleased: boolean;
  /** Draft text still present in the composer after wake. */
  draftPreserved: string | null;
  /** The event count the view reports while hibernated. */
  hibernatedEventCount: number;
  /** Pids of the processes that were counted. */
  countedPids: number[];
  /** Which surface produced the headline numbers. */
  sampleSource: SampleSource;
  /** True when the renderer could be asked to collect garbage. */
  gcAvailable: boolean;
  /** True when a collection was forced before every reading. */
  forcedGc: boolean;
  /** True when the fixture included image attachments. */
  withAttachments: boolean;
  /** Every BEFORE reading, in order. */
  beforeSamplesMB: number[];
  /** Every AFTER reading, in order. */
  afterSamplesMB: number[];
  /** How the renderer was measured. */
  attribution: string;
  /** Git revision the measured build came from (best effort). */
  sourceCommit?: string;
  platform: string;
  notes: string[];
  durationMs: number;
  samples: RendererSample[];
}

/** Isolated user-data dir so the bench never reads the developer's real data. */
export function benchUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loam-j7-userdata-${process.pid}-`));
}

/** Isolated data dir for the server the app spawns. */
export function benchDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `loam-j7-data-${process.pid}-`));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Median of a list; the empty list is 0. */
export function median(values: readonly number[]): number {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Best-effort provenance: the revision of the tree being measured. */
export function readSourceCommit(): string | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    if (!head) return undefined;
    // A dirty tree still names the base revision, which is what provenance needs.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
    return status.trim().length > 0 ? `${head}-dirty` : head;
  } catch {
    return undefined;
  }
}

/**
 * Seed the desktop session token the main process reads once at startup.
 *
 * `electron/main.cjs` resolves `sessionToken` from
 * `<userData>/localStorage.json` (`session_token`) before the window loads, and
 * the app shell redirects to `/login` when that token is missing. Seeding the
 * file before launch is what keeps the bench on the chat view.
 */
export function seedLocalStorage(userDataDir: string, token: string = BENCH_SESSION_TOKEN): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "localStorage.json"),
    JSON.stringify({ session_token: token }, null, 2),
    "utf8",
  );
}

/**
 * Sum the working set of the renderer (`Tab`) processes, the same source J6's
 * `debug:memory` surface uses for `rendererRssMb`. This is the authoritative
 * attribution: `app.getAppMetrics()` reports one row per process, and only
 * renderer windows carry `type: "Tab"`, so the Node server utility process is
 * never counted.
 */
export function sumRendererMetricsMB(metrics: readonly RendererMetric[]): { mb: number; matched: number; pids: number[] } {
  const matched = (metrics || []).filter(
    (metric) => metric && metric.type === "Tab" && metric.pid > 0 && Number.isFinite(metric.memory?.workingSetSize),
  );
  const bytes = matched.reduce((total, metric) => total + (metric.memory?.workingSetSize ?? 0) * 1024, 0);
  return { mb: bytes / (1024 * 1024), matched: matched.length, pids: matched.map((metric) => metric.pid) };
}

/** The pids of the renderer (`Tab`) processes in one metrics snapshot. */
export function rendererPids(metrics: readonly RendererMetric[]): number[] {
  return (metrics || [])
    .filter((metric) => metric && metric.type === "Tab" && metric.pid > 0)
    .map((metric) => metric.pid);
}

/**
 * Self-contained main-process script body: read `app.getAppMetrics()`.
 *
 * This is a plain string on purpose. It is compiled with
 * `new Function("electron", body)` inside the main process, because `require` is
 * not in scope for `app.evaluate` and a serialized function from this module
 * would carry esbuild's `keepNames` helper (`__name`), which does not exist
 * inside the app.
 */
export const MAIN_METRICS_SCRIPT = "return electron.app.getAppMetrics() || [];";

/** The marker strings the page scripts carry, so callers can identify them. */
export const SCRIPT_MARKERS = {
  env: "__j7_env",
  hook: "__j7_hook",
  inject: "__j7_inject",
  sample: "__j7_sample",
  hibernate: "__j7_hibernate",
  wake: "__j7_wake",
} as const;

/**
 * Page-side env injection. The renderer resolves its API and socket base through
 * `window.__AGENT_STUDIO_ENV__` first (the same hook the e2e suite uses), so
 * pointing both at the bench's loopback mock keeps every call local and lets the
 * mock live on a free port.
 */
export function rendererEnvScript(apiBase: string, socketBase: string): string {
  return `(() => {
    // ${SCRIPT_MARKERS.env}
    const env = window.__AGENT_STUDIO_ENV__ || {};
    window.__AGENT_STUDIO_ENV__ = Object.assign({}, env, {
      apiBase: ${JSON.stringify(apiBase)},
      socketBase: ${JSON.stringify(socketBase)},
    });
    try { window.localStorage.setItem("session_token", ${JSON.stringify(BENCH_SESSION_TOKEN)}); } catch {}
    return true;
  })()`;
}

/** Page-side probe: has the chat view attached its hibernation hook? */
export function hookProbeScript(): string {
  return `(() => {
    // ${SCRIPT_MARKERS.hook}
    const hook = window.__loamHibernation;
    return Boolean(hook && hook.__attached);
  })()`;
}

/**
 * Page-side sampling: ask J6's `debug:memory` surface to re-derive the renderer
 * total now. Returns `ok: false` when the surface is missing, which is the signal
 * for the caller to fall back to main-process metrics.
 */
export function sampleScript(options: { forceGc?: boolean } = {}): string {
  return `(async () => {
    // ${SCRIPT_MARKERS.sample}
    const apis = window.__apis;
    const refresh = apis && apis.debugMemory && apis.debugMemory.refresh;
    if (typeof refresh !== "function") return { ok: false, reason: "debugMemory.refresh is unavailable" };
    // A collection first, when the renderer exposes it, so released DOM is not
    // still sitting in a lazily-swept heap. Without it the working set does not
    // move: V8 keeps the freed objects until it collects, and the OS reclaims the
    // pages only then. The report records whether the collection was available
    // and whether it was requested.
    let gcAvailable = false;
    if (${options.forceGc ? "true" : "false"}) {
      try { if (typeof window.gc === "function") { window.gc(); window.gc(); gcAvailable = true; } } catch {}
    }
    const sample = await refresh();
    return {
      ok: true,
      gcAvailable,
      rendererRssMb: Number(sample && sample.rendererRssMb) || 0,
      matched: Number(sample && sample.matched) || 0,
      pids: (sample && sample.pids) || [],
    };
  })()`;
}

/**
 * Phase 1: inject the fixture and let the real view render it. Polls until rows
 * are mounted (or the deadline passes) instead of sleeping a fixed amount, so a
 * slow first render does not read as "nothing rendered".
 */
export function injectFixtureScript(sessionUid: string, events: readonly unknown[]): string {
  return `(async () => {
    // ${SCRIPT_MARKERS.inject}
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hook = window.__loamHibernation;
    if (!hook) return { hookAvailable: false, rows: 0 };
    hook.injectEvents(${JSON.stringify(sessionUid)}, ${JSON.stringify(events)});
    const deadline = Date.now() + 60000;
    let rows = 0;
    while (Date.now() < deadline) {
      await sleep(500);
      rows = document.querySelectorAll('[data-testid="event-list"] li').length;
      if (rows > 1) break;
    }
    return { hookAvailable: true, rows };
  })()`;
}

/**
 * Phase 2: type a draft, release the derived render state, and report what the
 * DOM looks like while hibernated. The caller samples the renderer after this
 * resolves, so the reading is taken with the rows unmounted.
 */
export function hibernateScript(sessionUid: string): string {
  return `(async () => {
    // ${SCRIPT_MARKERS.hibernate}
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hook = window.__loamHibernation;
    if (!hook) return { domReleased: false, eventCount: 0, rows: 0, draftTyped: null, released: null, error: null };
    // Type into the real composer so the wake check exercises the same state a
    // user's keystroke would (React reads the native setter, then the event).
    const composer = document.querySelector('[data-testid="composer"] textarea');
    if (composer) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(composer, ${JSON.stringify(BENCH_DRAFT_TEXT)});
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await sleep(150);
    let released = null;
    let error = null;
    try { released = await hook.hibernate(${JSON.stringify(sessionUid)}); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    await sleep(1200);
    const list = document.querySelector('[data-testid="event-list"]');
    const rows = list ? list.querySelectorAll("li").length : 0;
    const reported = list ? list.getAttribute("data-event-count") : null;
    const eventCount = Number(reported || (released && released.entries) || 0);
    return {
      domReleased: rows <= 1,
      eventCount,
      rows,
      draftTyped: composer ? composer.value : null,
      released,
      error,
    };
  })()`;
}

/**
 * Phase 3: wake the session and read the composer back. The draft must be
 * exactly what was typed, which is the "wake without losing the typed input"
 * property the acceptance requires.
 */
export function wakeScript(sessionUid: string): string {
  return `(async () => {
    // ${SCRIPT_MARKERS.wake}
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hook = window.__loamHibernation;
    if (!hook) return { draft: null, rows: 0, eventCount: 0 };
    await hook.wake(${JSON.stringify(sessionUid)});
    await sleep(1200);
    const composer = document.querySelector('[data-testid="composer"] textarea');
    const list = document.querySelector('[data-testid="event-list"]');
    return {
      draft: composer ? composer.value : null,
      rows: document.querySelectorAll('[data-testid="event-list"] li').length,
      eventCount: Number((list && list.getAttribute("data-event-count")) || 0),
    };
  })()`;
}

/** CORS headers: `app://agent` is a distinct origin from the loopback mock. */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};

/**
 * A minimal loopback backend that answers just enough of the Agent Studio API for
 * the chat view to mount and render.
 *
 * Three details are load-bearing and each was found by measuring a real bounce to
 * `/login`:
 *  - CORS + preflight, because the renderer runs on the `app://agent` origin;
 *  - a real user object for `UserInfo`, because the shell treats a rejection as
 *    an invalid token;
 *  - a socket.io endpoint (attached by `startMockApi`), because a failed socket
 *    handshake is treated as an auth failure by the chat view.
 */
export function createMockApiHandler(sessionId: string): http.RequestListener {
  return (req, res) => {
    const url = req.url ?? "";
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.includes("UserInfo")) {
      send({ firstname: "Bench", lastname: "User", displayname: "Bench User", email: "bench@example.com" });
      return;
    }
    if (url.includes("SessionService")) {
      // `GetSession` needs a session object; `ListSessions` only needs a list.
      send(url.includes("GetSession")
        ? { session: { uid: sessionId, title: "J7 bench session", lastDisplayMessage: "", icon: "\u2022" } }
        : { sessions: [] });
      return;
    }
    if (url.includes(`/api/sessions/${sessionId}/hibernate`)) {
      send({ record: { sessionId, state: "hibernated", hibernations: 1, lastReleasedEntries: 0, lastReleasedBytes: 0 }, state: "hibernated" });
      return;
    }
    if (url.includes(`/api/sessions/${sessionId}/wake`)) {
      send({ record: { sessionId, state: "active", hibernations: 1, lastReleasedEntries: 0, lastReleasedBytes: 0 }, state: "active" });
      return;
    }
    if (url.includes("/hibernation")) {
      // The daemon's own hibernation record: the renderer polls this, so it must
      // answer. The renderer's local release is what is measured.
      send({
        record: { sessionId, state: "idle", hibernations: 0, lastReleasedEntries: 0, lastReleasedBytes: 0 },
        state: "idle",
        msUntilHibernation: 1_800_000,
        disabled: false,
      });
      return;
    }
    // Everything else the view asks for (credits, connectors, runtime) is an
    // empty object, which is what the e2e harness returns too.
    send({});
  };
}

/**
 * Start the mock backend and attach a real socket.io endpoint to it.
 *
 * The chat view rejects its `connect()` promise when the handshake fails and then
 * calls `onAuthFailure()`, which sends the window to `/login`. Serving an actual
 * socket.io handshake is what keeps the view mounted.
 */
export function startMockApi(port: number, sessionId: string): Promise<http.Server> {
  const server = http.createServer(createMockApiHandler(sessionId));
  try {
    const { Server } = require("socket.io") as { Server: new (srv: http.Server, opts?: unknown) => { close: () => void } };
    const io = new Server(server, { cors: { origin: "*" } });
    (server as http.Server & { __io?: unknown }).__io = io;
  } catch {
    // Without socket.io the view will redirect on the failed handshake; the
    // caller reports that honestly rather than pretending it measured.
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Close a server started by `startMockApi`, including its socket.io endpoint. */
export async function closeMockApi(server: http.Server): Promise<void> {
  const io = (server as http.Server & { __io?: { close: () => void } }).__io;
  try { io?.close(); } catch { /* already closed */ }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** The slice of the Playwright Electron harness this bench drives. */
export interface ElectronHarness {
  /** Pid of the app's main process. */
  mainPid: number;
  /**
   * Evaluate a self-contained script in the renderer. The scripts are strings,
   * not functions: this bench runs under tsx, and esbuild's `keepNames` helper
   * (`__name`) is not defined inside the page, so a serialized function from
   * this module would throw `ReferenceError: __name is not defined`.
   */
  evaluateInPage<T>(script: string): Promise<T>;
  /** Navigate the window and let the app settle. */
  navigate(url: string): Promise<void>;
  /** Wait until the mounted chat view has attached its hibernation hook. */
  waitForHook(timeoutMs: number): Promise<boolean>;
  /** Fallback reading: renderer metrics straight from the main process. */
  sampleMainMetrics(): Promise<RendererMetric[]>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  mainPath: string;
  /**
   * The app root passed to Electron (the repo folder whose `package.json`
   * declares `main: electron/main.cjs`). Electron derives `app.getAppPath()`
   * from this argument, and `main.cjs` reads its own `package.json` from that
   * path, so passing the script file instead makes the app fail to load.
   */
  appRoot: string;
  port: number;
  apiPort: number;
  userDataDir: string;
  dataDir: string;
  sessionUid: string;
  /** Page-side env script installed before the first bench navigation. */
  rendererEnv: string;
  /**
   * Switches to run the app with. Empty keeps Electron's defaults; passing
   * `--js-flags=--expose-gc` lets the bench force a collection before each
   * reading, which is the only way to see a release the renderer otherwise
   * leaves in a lazily-swept heap.
   */
  switches?: string[];
}

/** Launch the real app through the Playwright Electron harness. */
export async function launchElectronHarness(options: LaunchOptions): Promise<ElectronHarness> {
  const { _electron } = require(path.join(ROOT, "packages", "web", "node_modules", "@playwright", "test")) as {
    _electron: {
      launch: (opts: {
        args: string[];
        env: Record<string, string>;
        executablePath?: string;
        timeout?: number;
      }) => Promise<{
        pid?: number;
        process: () => NodeJS.Process;
        evaluate: (fn: unknown) => Promise<unknown>;
        firstWindow: (opts?: { timeout?: number }) => Promise<{
          evaluate: (script: string) => Promise<unknown>;
          addInitScript: (script: string) => Promise<void>;
        }>;
        close: () => Promise<void>;
      }>;
    };
  };
  const electronEntry = require("electron") as unknown as string;
  const app = await _electron.launch({
    // Playwright supplies the Electron binary itself (`executablePath`), so
    // `args` must be the app root only. Passing the binary here as well makes
    // Electron try to load `electron.exe` as a module and fail. GC switches go
    // through `switches` instead, which Electron forwards to the renderer.
    executablePath: electronEntry,
    args: [options.appRoot, ...(options.switches ?? [])],
    timeout: 90_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOAM_PORT: String(options.port),
      MANUS_LOCAL_PORT: String(options.port),
      LOAM_USER_DATA_DIR: options.userDataDir,
      LOAM_DATA_DIR: options.dataDir,
      MANUS_LOCAL_DATA_DIR: options.dataDir,
      LOAM_AUTH_DISABLED: "true",
      LOAM_DISABLE_BRIDGE: "1",
      MOCK_PORT: String(options.apiPort),
      API_BASE: `http://127.0.0.1:${options.apiPort}`,
      SOCKET_BASE: `http://127.0.0.1:${options.apiPort}`,
      UPDATE_FEED_URL: "",
    },
  });
  const mainPid = app.pid ?? app.process().pid;
  if (!mainPid) throw new Error("the launched app did not report a main-process pid");

  const page = await app.firstWindow({ timeout: 60_000 });
  // Installed before the bench navigates, so the injected API/socket base is in
  // place for the chat view. The app's own startup load is unaffected.
  await page.addInitScript(options.rendererEnv);

  return {
    mainPid,
    evaluateInPage: async <T,>(script: string) => page.evaluate(script) as Promise<T>,
    navigate: async (url: string) => {
      // `location.href` is used rather than `page.goto` because the app serves
      // the export over its own app:// protocol; a navigation tears down the
      // execution context, so a failure here is expected and ignored.
      await page.evaluate(`(() => { location.href = ${JSON.stringify(url)}; })()`).catch(() => undefined);
    },
    waitForHook: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      const probe = hookProbeScript();
      while (Date.now() < deadline) {
        const attached = await page.evaluate(probe).then((v) => v === true).catch(() => false);
        if (attached) return true;
        // Without a marker the probe cannot be identified by content, so a short
        // wait is needed or the loop would spin. The bench's own tests avoid this
        // by attaching immediately.
        await delay(timeoutMs < 1000 ? 1 : 500);
      }
      return false;
    },
    sampleMainMetrics: async () =>
      app.evaluate(new Function("electron", MAIN_METRICS_SCRIPT) as never) as Promise<RendererMetric[]>,
    close: async () => { try { await app.close(); } catch { /* ignore */ } },
  };
}

export interface FixtureOptions {
  /**
   * Include image attachments. The acceptance names image caches among the
   * derived state hibernation releases, so the fixture optionally exercises a
   * transcript that carries real images as well as plain text.
   */
  withAttachments?: boolean;
}

/**
 * Build the canonical fixture the view renders: messages with enough text
 * (including a fenced code block every seventh message, which forces the syntax
 * highlighter) that the rendered DOM is a real cost, matching the ~2000-message
 * fixture the acceptance asks for.
 */
export function fixtureEvents(count: number, options: FixtureOptions = {}): unknown[] {
  const events: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const withAttachment = options.withAttachments === true && i % 9 === 3;
    events.push(
      withAttachment
        ? {
            id: `fixture-image-${i}`,
            type: "attachment",
            timestamp: 1_700_000_000_000 + i,
            name: `screenshot-${i}.png`,
            mime: "image/png",
            sizeBytes: 2_500_000,
            taskId: `task-${i}`,
            path: `/tmp/fixtures/screenshot-${i}.png`,
          }
        : {
            id: `fixture-${i}`,
            type: "chat",
            timestamp: 1_700_000_000_000 + i,
            sender: i % 3 === 0 ? "user" : "assistant",
            messageType: "text",
            content:
              `Fixture message ${i}. ` + "lorem ipsum dolor sit amet ".repeat(6) +
              (i % 7 === 0 ? `\n\n\`\`\`ts\nconst value = ${i};\nconsole.log(value);\n\`\`\`` : ""),
            attachments: [],
            deliveryKind: "result",
          },
    );
  }
  return events;
}

/** What the page-side sample script reports back. */
interface PageSample {
  ok: boolean;
  gcAvailable?: boolean;
  rendererRssMb?: number;
  matched?: number;
  pids?: number[];
  reason?: string;
}

/**
 * Collect on both sides of the measurement when the renderer exposes it, so a
 * release is not hidden inside an uncollected heap.
 *
 * This is the default path: the working set only moves when the renderer actually
 * collects, so a bench that does not sweep first would report a release as flat.
 * `--no-force-gc` turns the sweep off (useful to see the raw effect), and
 * `--force-gc` is accepted for symmetry and as the documented form of the
 * default.
 */
export function renderSampleScript(forceGc: boolean): string {
  return sampleScript({ forceGc });
}

export interface RendererBenchOptions {
  /** Electron app entry (`electron/main.cjs`). */
  mainPath?: string;
  /**
   * Collect before every reading so a release is visible (default true).
   *
   * A release that drops the DOM does not immediately move the renderer's working
   * set: V8 keeps the freed objects in its heap until it collects, and the OS
   * reclaims pages only when that happens. With the sweep on the bench reports
   * the real effect; with it off the reading reflects the uncollected heap.
   */
  forceGc?: boolean;
  /**
   * Include image attachments in the fixture. The acceptance names image caches
   * among the derived state hibernation releases, so the measurement covers a
   * transcript with real images as well as one with plain text.
   */
  withAttachments?: boolean;
  /** App root passed to Electron (defaults to the repo root). */
  appRoot?: string;
  /** Loopback port for the app's own base (`LOAM_PORT`). */
  port?: number;
  /** Loopback port the mock backend listens on. Default 8787. */
  apiPort?: number;
  /** Messages to render in the fixture. Default 2000. */
  fixtureMessages?: number;
  /** Isolated user-data dir (default: a fresh temp dir). */
  userDataDir?: string;
  /** Isolated data dir (default: a fresh temp dir). */
  dataDir?: string;
  /** Override the Electron launcher (tests inject a fake harness). */
  launchImpl?: (opts: LaunchOptions) => Promise<ElectronHarness>;
  /**
   * How long to let the released DOM settle before the AFTER reading, in ms.
   * Default 2500; tests pass 0 so the suite does not sleep.
   */
  settleMs?: number;
  /** Readings taken per phase; the median is reported. Default 3. */
  sampleCount?: number;
  /** Delay between readings within a phase, in ms. Default 700. */
  sampleIntervalMs?: number;
  /** How long to wait for the view to attach its hook. Default 90000. */
  hookTimeoutMs?: number;
  /** Where to write the JSON report. */
  jsonOut?: string;
}

/**
 * Run the renderer-hibernation measurement.
 *
 * A flat result is reported as flat: `released` is only true when the renderer
 * working set actually dropped, and `unavailable` carries the reason when it
 * could not be measured at all.
 */
export async function runRendererBench(options: RendererBenchOptions = {}): Promise<RendererBenchReport> {
  const fixtureMessages = Math.max(1, Math.floor(options.fixtureMessages ?? DEFAULT_FIXTURE_MESSAGES));
  const settleMs = Math.max(0, options.settleMs ?? 2500);
  const sampleCount = Math.max(1, Math.floor(options.sampleCount ?? 3));
  const sampleIntervalMs = Math.max(0, options.sampleIntervalMs ?? 700);
  const hookTimeoutMs = Math.max(1000, options.hookTimeoutMs ?? 90_000);
  const mainPath = options.mainPath ?? path.join(ROOT, "electron", "main.cjs");
  const port = options.port ?? DEFAULT_APP_PORT;
  const apiPort = options.apiPort ?? DEFAULT_API_PORT;
  const userDataDir = options.userDataDir ?? benchUserDataDir();
  const dataDir = options.dataDir ?? benchDataDir();
  const notes: string[] = [];
  const started = Date.now();
  const samples: RendererSample[] = [];
  const beforeSamplesMB: number[] = [];
  const afterSamplesMB: number[] = [];
  const base = `http://127.0.0.1:${apiPort}`;
  let sampleSource: SampleSource = "debug:memory";
  let gcAvailable = false;
  const forceGc = options.forceGc !== false;
  if (forceGc) notes.push("garbage collected before each reading (--expose-gc)");
  const withAttachments = options.withAttachments === true;
  if (withAttachments) notes.push("fixture includes image attachments");

  // The main process reads its session token once at startup, so the seed has to
  // be on disk before the app launches.
  seedLocalStorage(userDataDir);

  let server: http.Server | null = null;
  let unavailableReason: string | undefined;
  try {
    server = await startMockApi(apiPort, BENCH_SESSION_UID);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    unavailableReason = `could not listen on the mock backend port ${apiPort} (${detail})`;
    notes.push(unavailableReason);
  }

  let harness: ElectronHarness | null = null;
  if (!unavailableReason) {
    try {
      harness = await (options.launchImpl ?? launchElectronHarness)({
        mainPath,
        appRoot: options.appRoot ?? ROOT,
        port,
        apiPort,
        userDataDir,
        dataDir,
        sessionUid: BENCH_SESSION_UID,
        rendererEnv: rendererEnvScript(base, base),
        // `expose-gc` is always passed when the sweep is on; `--no-force-gc`
        // leaves Electron's defaults so the raw heap effect can be observed.
        ...(forceGc ? { switches: ["--js-flags=--expose-gc"] } : {}),
      });
    } catch (err) {
      unavailableReason = `could not launch the app: ${err instanceof Error ? err.message : String(err)}`;
      notes.push(unavailableReason);
    }
  }

  let beforeMB = 0;
  let afterMB = 0;
  const reading: RendererHookReading = {
    rendered: false, domReleased: false, eventCount: 0, draft: null, hookAvailable: false,
  };
  let countedPids: number[] = [];

  /**
   * One reading. Prefers J6's `debug:memory` surface; falls back to the main
   * process and records which one produced the number.
   */
  const takeSample = async (): Promise<RendererSample | null> => {
    if (!harness) return null;
    const page = await harness.evaluateInPage<PageSample>(renderSampleScript(forceGc)).catch(() => null);
    if (page?.ok && Number(page.rendererRssMb) > 0) {
      sampleSource = "debug:memory";
      if (page.gcAvailable) gcAvailable = true;
      return {
        at: Date.now(),
        totalMB: Number(page.rendererRssMb),
        processCount: Number(page.matched) || 0,
        pids: page.pids ?? [],
        source: "debug:memory",
      };
    }
    const metrics = await harness.sampleMainMetrics().catch(() => []);
    const summed = sumRendererMetricsMB(metrics);
    if (summed.matched === 0) return null;
    sampleSource = "app-metrics";
    return { at: Date.now(), totalMB: summed.mb, processCount: summed.matched, pids: rendererPids(metrics), source: "app-metrics" };
  };

  if (harness) {
    try {
      // Navigate to the chat view and wait for the mounted view's hook.
      await harness.navigate(`/app/${BENCH_SESSION_UID}`);
      const attached = await harness.waitForHook(hookTimeoutMs);
      if (!attached) {
        unavailableReason = "the chat view did not expose its hibernation test hook (the window may have redirected to /login)";
        notes.push(unavailableReason);
      } else {
        // Phase 1: render the fixture in the real view.
        const injected = await harness.evaluateInPage<{ hookAvailable: boolean; rows: number }>(
          injectFixtureScript(BENCH_SESSION_UID, fixtureEvents(fixtureMessages, { withAttachments })),
        );
        reading.hookAvailable = injected.hookAvailable;
        reading.rendered = injected.rows > 1;
        if (!reading.rendered) {
          notes.push(`the view mounted only ${injected.rows} message row(s) after injection`);
        }

        // BEFORE: read the renderer while the full transcript is resident.
        for (let i = 0; i < sampleCount; i++) {
          const sample = await takeSample();
          if (sample) {
            samples.push(sample);
            beforeSamplesMB.push(round1(sample.totalMB));
            countedPids = sample.pids ?? countedPids;
          }
          if (i < sampleCount - 1) await delay(sampleIntervalMs);
        }
        beforeMB = median(beforeSamplesMB);

        // Phase 2: type a draft and release the derived render state.
        const hibernated = await harness.evaluateInPage<{
          domReleased: boolean; eventCount: number; rows: number; released: { entries?: number } | null; error: string | null;
        }>(hibernateScript(BENCH_SESSION_UID));
        reading.domReleased = hibernated.domReleased;
        reading.eventCount = hibernated.eventCount;
        if (hibernated.error) notes.push(`hibernate reported: ${hibernated.error}`);
        if (hibernated.eventCount > 0) {
          notes.push(`view reports ${hibernated.eventCount} canonical events while hibernated`);
        }

        // Let the released DOM settle before the reading, so the number is not
        // taken mid-teardown.
        if (settleMs > 0) await delay(settleMs);

        // AFTER: same readings, with the derived render state released.
        for (let i = 0; i < sampleCount; i++) {
          const sample = await takeSample();
          if (sample) {
            samples.push(sample);
            afterSamplesMB.push(round1(sample.totalMB));
          }
          if (i < sampleCount - 1) await delay(sampleIntervalMs);
        }
        afterMB = median(afterSamplesMB);

        // Phase 3: wake and confirm the typed draft survived.
        const woken = await harness.evaluateInPage<{ draft: string | null; rows: number }>(
          wakeScript(BENCH_SESSION_UID),
        );
        reading.draft = woken.draft;

        if (beforeSamplesMB.length === 0 || afterSamplesMB.length === 0) {
          unavailableReason = "the renderer working set could not be read (debug:memory and app.getAppMetrics both returned nothing)";
          notes.push(unavailableReason);
        }
      }
    } catch (err) {
      unavailableReason = `could not measure the renderer: ${err instanceof Error ? err.message : String(err)}`;
      notes.push(unavailableReason);
    }
  }

  if (harness) {
    try { await harness.close(); } catch { /* ignore */ }
  }
  if (server) await closeMockApi(server).catch(() => undefined);
  for (const dir of [userDataDir, dataDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* disposable */ }
  }

  const deltaMB = round1(afterMB - beforeMB);
  const unavailable = Boolean(unavailableReason) || beforeMB === 0 || afterMB === 0;
  const released = !unavailable && deltaMB < 0;

  const report: RendererBenchReport = {
    kind: "renderer-hibernation",
    fixtureMessages,
    beforeMB: round1(beforeMB),
    afterMB: round1(afterMB),
    deltaMB,
    released,
    unavailable,
    unavailableReason,
    rendered: reading.rendered,
    domReleased: reading.domReleased,
    draftPreserved: reading.draft,
    hibernatedEventCount: reading.eventCount,
    countedPids,
    sampleSource,
    gcAvailable,
    forcedGc: forceGc,
    withAttachments,
    beforeSamplesMB,
    afterSamplesMB,
    attribution: sampleSource === "debug:memory"
      ? "J6 debug:memory refresh (app.getAppMetrics Tab rows matched to owned webContents)"
      : "app.getAppMetrics() Tab rows (main process fallback)",
    sourceCommit: readSourceCommit(),
    platform: process.platform,
    notes,
    durationMs: Date.now() - started,
    samples,
  };

  if (options.jsonOut) {
    try {
      fs.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
      fs.writeFileSync(options.jsonOut, JSON.stringify(report, null, 2), "utf8");
    } catch (err) {
      notes.push(`could not write ${options.jsonOut}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}

export const HELP_TEXT = `Loam J7 renderer-hibernation RSS benchmark (offline, local app only)

Usage: npm run bench:ram:renderer -- [options]

Options:
  --port <n>            App loopback port (default 3971)
  --api-port <n>        Mock backend port (default 8787, where the renderer looks)
  --messages <n>        Fixture messages to render (default 2000)
  --samples <n>         Readings per phase, median reported (default 3)
  --settle-ms <n>       Settle time before the AFTER reading (default 2500)
  --force-gc            Collect before each reading (the default)
  --no-force-gc         Do not sweep, to see the raw uncollected heap effect
  --with-attachments    Include image attachments in the fixture
  --json-out <path>     Also write the JSON report here
  -h, --help            Show this help

The report records the renderer working set before and after a real hibernation
of the open chat view, read through J6's debug:memory surface and driven through
the view's own test hook. A flat or unavailable reading is reported as such: it is
never presented as a saving.
`;

interface CliArgs {
  port?: number;
  apiPort?: number;
  fixtureMessages?: number;
  sampleCount?: number;
  settleMs?: number;
  forceGc?: boolean;
  withAttachments?: boolean;
  jsonOut?: string;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const next = () => argv[++i];
    switch (token) {
      case "--port":
        args.port = Number(next());
        break;
      case "--api-port":
        args.apiPort = Number(next());
        break;
      case "--messages":
        args.fixtureMessages = Number(next());
        break;
      case "--samples":
        args.sampleCount = Number(next());
        break;
      case "--settle-ms":
        args.settleMs = Number(next());
        break;
      case "--force-gc":
        args.forceGc = true;
        break;
      case "--no-force-gc":
        args.forceGc = false;
        break;
      case "--with-attachments":
        args.withAttachments = true;
        break;
      case "--json-out":
        args.jsonOut = next();
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (token.startsWith("--")) throw new Error(`unknown flag ${token}`);
        break;
    }
  }
  return args;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${HELP_TEXT}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const report = await runRendererBench({
    port: args.port,
    apiPort: args.apiPort,
    fixtureMessages: args.fixtureMessages,
    sampleCount: args.sampleCount,
    settleMs: args.settleMs,
    forceGc: args.forceGc,
    withAttachments: args.withAttachments,
    jsonOut: args.jsonOut,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.unavailable) {
    process.stdout.write(`measurement unavailable: ${report.unavailableReason ?? "no reading"}\n`);
    return 1;
  }
  if (!report.released) {
    process.stdout.write(`flat result: renderer RSS did not drop (${report.beforeMB} -> ${report.afterMB} MB)\n`);
    return 0;
  }
  process.stdout.write(`renderer RSS ${report.beforeMB} -> ${report.afterMB} MB (delta ${report.deltaMB} MB)\n`);
  return 0;
}

// Run only when invoked directly (node --import tsx bench/rendererHibernationBench.ts ...).
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`bench:ram:renderer failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
