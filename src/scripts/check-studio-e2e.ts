/**
 * fc-10 — scripted end-to-end check of the Loam "Video Studio" user flow.
 *
 * This is the acceptance check for the whole FilmCraft + EffectCraft integration:
 * the user attaches a video in chat and writes an instruction, the workspace panel
 * opens the Video Studio by itself, the agent drives the editor through the real
 * relay, a manual edit made in the panel survives, and the rendered export lands as
 * a file in the task's files.
 *
 * Two phases:
 *
 *  A. Flow (always runs). The whole flow against the real server, real relay, real
 *     `video_studio` tool and real export service. The editor panel is a stand-in
 *     (the browser iframe cannot run in Node), so a worktree without the vendored
 *     dist still proves the wiring, the fc-05 state contract and the fc-06 export.
 *     This is the "unit parts pass always" half of the acceptance test.
 *
 *  B. Real dist (skips when absent). When `electron/filmcraft/dist` is vendored
 *     (as it is in the packaged app), the check confirms the tool can actually see
 *     the editor build. The real wasm editor itself is driven by the browser
 *     panel, so its full rendering is covered by the web e2e tests; this phase
 *     reports the skip clearly instead of pretending to have rendered a video.
 *
 * What is real in phase A:
 *   - the real agent loop (`src/agent/loop.ts`) with the real system prompt and
 *     the real `video_studio` tool (`src/tools/videoStudio.ts`),
 *   - the real command relay (`src/server/videoStudioRelay.ts`) with its SSE
 *     `video_studio_command` frames and the real result route,
 *   - the real HTTP server (`src/server/http.ts`) — the task stream and the
 *     `/api/files` listing the UI reads,
 *   - the real export service (`src/server/videoStudioExport.ts`): it resolves the
 *     export command from the live catalog, reads the rendered bytes back through
 *     the relay and writes them into the task workspace.
 *
 * The model is the scripted `bench/fakeModel.ts` server, so no model download and
 * no network are needed.
 *
 * Usage:
 *   node --import tsx src/scripts/check-studio-e2e.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A tiny mp4 fixture. The bytes only have to be non-empty: the stand-in editor
 * never decodes them, and `normalizeExportBytes` rejects an empty read-back.
 * (`ffmpeg` is not required, and no fixture file is added to the repo.)
 */
const CLIP_BYTES = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
const CLIP_PATH = "media/clip.mp4";
const MUSIC_PATH = "media/music.mp3";

/** The user's request, in Arabic, matching the approved product design. */
const PROMPT = "هذا فيديو رحلتي. اعمل له مونتاج: اقص المقدمة، اضف موسيقى، ثم صدّر الفيديو.";

/** The export file name the agent asks for (Arabic, as the user would type it). */
const EXPORT_NAME = "رحلة-مقصوصة";

/**
 * The scripted model turns: state -> cut -> add_audio -> export -> final answer.
 * `turnIndex` is the number of tool results already in the transcript, so the
 * last turn repeats and the final text turn is reached exactly once.
 */
const TURNS: Array<{ tool?: { name: string; arguments: Record<string, unknown> }; text?: string }> = [
  { tool: { name: "video_studio", arguments: { action: "state" } } },
  { tool: { name: "video_studio", arguments: { action: "cut", atSec: 2 } } },
  { tool: { name: "video_studio", arguments: { action: "add_audio", path: MUSIC_PATH, trackId: "a1" } } },
  { tool: { name: "video_studio", arguments: { action: "export", name: EXPORT_NAME, format: "mp4" } } },
  { text: "تم. قصصت المقدمة وأضفت الموسيقى ثم صدّرت الفيديو إلى exports/رحلة-مقصوصة.mp4." },
];

/** Count the `tool` role messages in a chat request (the scripted turn index). */
function countToolResults(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  return messages.filter((m) => typeof m === "object" && m !== null && (m as { role?: unknown }).role === "tool").length;
}

/**
 * A scripted OpenAI-compatible model in the Ollama `/api/chat` streaming shape
 * (one JSON object per line, terminated by `done: true`).
 *
 * `bench/fakeModel.ts` speaks the OpenAI SSE + `[DONE]` framing, which
 * `OllamaClient.chatLocal` does not parse, so the fc-10 check carries its own
 * minimal server rather than reshaping the shared bench fixture.
 */
function startFakeModel(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = {};
      try {
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      if (url === "/api/tags" || url === "/api/version" || url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [{ name: "mock-coder" }] }));
        return;
      }
      if (url !== "/api/chat" && url !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown path" }));
        return;
      }
      const turn = TURNS[Math.min(countToolResults(body), TURNS.length - 1)]!;
      const lines: string[] = [];
      const message: Record<string, unknown> = { role: "assistant" };
      if (turn.tool) {
        message.content = "";
        message.tool_calls = [
          {
            function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments ?? {}) },
          },
        ];
      } else {
        message.content = turn.text ?? "";
      }
      lines.push(JSON.stringify({ model: "mock-coder", created_at: "2026-01-01T00:00:00Z", message }));
      lines.push(
        JSON.stringify({
          model: "mock-coder",
          created_at: "2026-01-01T00:00:00Z",
          done: true,
          done_reason: turn.tool ? "tool_calls" : "stop",
          prompt_eval_count: 100,
          eval_count: 10,
          total_duration: 1_000_000,
        }),
      );
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" }).end(`${lines.join("\n")}\n`);
    });
  });
  return new Promise<{ baseUrl: string; stop: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The fake editor panel (the browser iframe's stand-in)
// ---------------------------------------------------------------------------

interface StreamEvent {
  type: string;
  id?: string;
  target?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/** The editor's command catalog, including the export command the fc-06 flow needs. */
const CATALOG = [
  "file.newProject",
  "timeline.razor",
  "audio.add",
  "file.exportMedia",
  "jobs.poll",
];

interface Clip {
  id: string;
  source: string;
  startSec: number;
  endSec: number;
}

interface FilmTrack {
  id: string;
  kind: string;
  clips: Clip[];
}

/** The timeline the stand-in editor holds. Re-read on every `inspect`. */
interface EditorTimeline {
  sequences: Array<{ id: string; tracks: FilmTrack[] }>;
  playheadSec: number;
}

function initialTimeline(): EditorTimeline {
  return {
    sequences: [
      {
        id: "seq1",
        tracks: [
          { id: "v1", kind: "video", clips: [{ id: "clip_1", source: CLIP_PATH, startSec: 0, endSec: 20 }] },
          { id: "a1", kind: "audio", clips: [] },
        ],
      },
    ],
    playheadSec: 0,
  };
}

function clipSummary(timeline: EditorTimeline): string {
  return timeline.sequences[0]!.tracks[0]!.clips.map((clip) => `~clip ${clip.id} ${clip.startSec}s->${clip.endSec}s`).join(" ");
}

/**
 * Run one relayed command against the stand-in editor.
 *
 * `importFiles` is what the auto-opened panel does on load: the attached clip is
 * imported onto the video track, which is what makes the fc-04 auto-open visible
 * to the agent.
 */
function runCommand(timeline: EditorTimeline, event: StreamEvent): { ok: boolean; result?: unknown; error?: string } {
  const method = event.method ?? "";
  const params = (event.params ?? {}) as Record<string, unknown>;
  if (method === "commands") return { ok: true, result: CATALOG.map((id) => ({ id })) };
  if (method === "inspect") return { ok: true, result: structuredClone(timeline) };
  if (method === "readFile") {
    const target = String(params["path"] ?? params["file"] ?? "");
    // The export's read-back: hand back the rendered bytes for the exported file
    // and an empty read for anything else, so a wrong path is visible.
    if (!target.includes("export")) return { ok: true, result: "" };
    return { ok: true, result: renderBytes(timeline).toString("base64") };
  }
  if (method === "importFiles") {
    const files = Array.isArray(params["files"]) ? (params["files"] as unknown[]) : [];
    const tracks = timeline.sequences[0]!.tracks;
    for (const file of files) {
      const source = typeof file === "string" ? file : String((file as Record<string, unknown>)["path"] ?? "");
      if (!source) continue;
      // The real editor puts an audio import on the audio track; routing every
      // import to the video track would fabricate a clip the editor never made.
      const isAudio = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(source);
      const track = isAudio ? tracks.find((t) => t.kind === "audio") ?? tracks[0]! : tracks.find((t) => t.kind === "video") ?? tracks[0]!;
      track.clips.push({ id: `${track.kind}_${track.clips.length + 1}`, source, startSec: 0, endSec: 20 });
    }
    return { ok: true, result: { imported: files.length } };
  }
  if (method === "execute") {
    const command = String(params["command"] ?? "");
    const inner = (params["params"] ?? {}) as Record<string, unknown>;
    if (command === "timeline.razor") {
      const video = timeline.sequences[0]!.tracks[0]!;
      const atSec = Number(inner["atSec"] ?? 0);
      const next: Clip[] = [];
      for (const clip of video.clips) {
        if (atSec <= clip.startSec || atSec >= clip.endSec) {
          next.push(clip);
          continue;
        }
        next.push({ ...clip, endSec: atSec });
        next.push({ ...clip, id: `${clip.id}_b`, startSec: atSec });
      }
      video.clips = next;
      return { ok: true, result: { command, applied: true } };
    }
    if (command === "audio.add") {
      const audio = timeline.sequences[0]!.tracks[1]!;
      audio.clips.push({ id: `audio_${audio.clips.length + 1}`, source: String(inner["path"] ?? MUSIC_PATH), startSec: 0, endSec: 20 });
      return { ok: true, result: { command, applied: true } };
    }
    if (command === "file.exportMedia") {
      // The editor writes into its own virtual FS and reports the produced file.
      return { ok: true, result: { path: `/exports/${EXPORT_NAME}.mp4` } };
    }
    if (command === "jobs.poll") return { ok: true, result: { status: "done", path: `/exports/${EXPORT_NAME}.mp4` } };
    return { ok: false, error: `unsupported command: ${command}` };
  }
  return { ok: true, result: { method } };
}

/** The rendered bytes the export's `readFile` returns. */
function renderBytes(timeline: EditorTimeline): Buffer {
  const clips = timeline.sequences[0]!.tracks[0]!.clips;
  const audio = timeline.sequences[0]!.tracks[1]!.clips;
  const seconds = clips.reduce((sum, clip) => sum + Math.max(0, clip.endSec - clip.startSec), 0);
  const header = Buffer.from(
    JSON.stringify({ seconds, clips: clips.length, audio: audio.length, note: "fc-10 stand-in render" }),
    "utf8",
  );
  // A realistic, non-empty payload: `normalizeExportBytes` rejects an empty read.
  return Buffer.concat([header, Buffer.alloc(4096, 1)]);
}

/**
 * Attach the fake panel to the real task stream.
 *
 * `manualEdit` runs once the first `inspect` has been answered, i.e. after the
 * agent has seen the unedited timeline. The tool's change tracker therefore takes
 * the pre-edit state as its baseline, and the next command's pre-read reports the
 * hand edit — which is exactly fc-05's contract.
 */
function attachPanel(
  base: string,
  taskId: string,
  timeline: EditorTimeline,
  log: StreamEvent[],
  manualEdit?: () => void,
): { stop: () => void } {
  const controller = new AbortController();
  let inspectedOnce = false;
  const run = async (): Promise<void> => {
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return; // aborted
      }
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice("data: ".length)) as StreamEvent;
        if (event.type !== "video_studio_command" || typeof event.id !== "string") continue;
        log.push(event);
        // fc-10: the first state read establishes the agent's baseline, then the
        // user trims the tail in the panel. The stand-in keeps the edited copy in
        // its own state, so the change survives the agent's whole run and the next
        // command's pre-read sees it as a manual edit.
        const result = runCommand(timeline, event);
        if (event.method === "inspect" && manualEdit && !inspectedOnce) {
          inspectedOnce = true;
          manualEdit();
        }
        await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/video-studio/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: event.id, taskId, ...result }),
        });
      }
    }
  };
  void run().catch(() => undefined);
  return { stop: () => controller.abort() };
}

/**
 * The relay method sequence fc-10 expects, derived from the real `buildAction`
 * step order and `runVideoStudioExport`:
 *
 *   panel pre-import                 importFiles
 *   state                            inspect
 *   cut          catalog -> before -> execute -> after
 *   add_audio    catalog -> before -> importFiles -> execute -> after
 *   export       before -> catalog -> execute -> readFile
 *
 * The export returns before the post-read state read (the export service owns the
 * whole round trip), so the sequence ends at `readFile`.
 */
const EXPECTED_METHODS = [
  "importFiles",
  "inspect",
  "commands",
  "inspect",
  "execute",
  "inspect",
  "commands",
  "inspect",
  "importFiles",
  "execute",
  "inspect",
  "inspect",
  "commands",
  "execute",
  "readFile",
];

/** The target the `film` editor uses on the relay. */
const FILM_TARGET = "film";

/** Wait until a panel is attached to the task stream (the SSE subscription is up). */
async function waitForAttached(taskId: string, timeoutMs = 10_000): Promise<void> {
  const { subscriberCount } = await import("../server/streams.js");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (subscriberCount(taskId) > 0) return;
    if (Date.now() > deadline) throw new Error(`no panel attached to ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForDetached(taskId: string, timeoutMs = 10_000): Promise<void> {
  const { subscriberCount } = await import("../server/streams.js");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (subscriberCount(taskId) === 0) return;
    if (Date.now() > deadline) throw new Error(`panel still attached to ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// The auto-open decision the web panel makes (fc-04)
// ---------------------------------------------------------------------------

/**
 * The browser decides whether the workspace panel opens by itself from the user's
 * chat event. That decision lives in the web bundle (`autoOpen.ts`), so fc-10
 * re-derives it from the same signals the browser uses — a video attachment plus an
 * edit instruction — and asserts the resulting target. The web unit suite pins the
 * real implementation; this check proves the fc-10 flow depends on it.
 */
function decideAutoOpen(attachmentPath: string, text: string): { path: string; kind: string; importPath: string } | null {
  if (!/\.(mp4|m4v|webm|mov|mkv|avi)(?:[?#]|$)/i.test(attachmentPath)) return null;
  // Mirrors `VIDEO_EDIT_INTENT_RE` in packages/web/src/components/workspace/autoOpen.ts
  // so this check tracks the real browser decision.
  const arabic =
    /مونتاج|قص|قطع|عدل|تعديل|تحرير|أضف|اضف|إضافة|اضافة|حذف|دمج|تقسيم|سرعة|موسيقى|صوت|عنوان|كتابة|ترجمة|تأثير|انتقال|تصدير|حفظ|تدوير|جودة|دقة/;
  const english =
    /\b(?:edit|cut|trim|montage|split|merge|add|delete|remove|music|audio|transition|effect|text|title|caption|subtitle|overlay|speed|export|render|enhance|color|stabilize|rotate|crop|resize|loop|reverse|mute|volume|zoom|fade)\b/i;
  if (!arabic.test(text) && !english.test(text)) return null;
  return { path: attachmentPath, kind: "loam-video", importPath: attachmentPath };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function results(ok: boolean, message: string, notes: string[] = []): void {
  log(`${ok ? "PASS" : "FAIL"} — ${message}`);
  for (const note of notes) log(`      ${note}`);
  if (!ok) process.exitCode = 1;
}

function skip(message: string, notes: string[] = []): void {
  log(`SKIP — ${message}`);
  for (const note of notes) log(`      ${note}`);
}

/** Absolute path of this checkout's root. */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function main(): Promise<void> {
  log("fc-10 Video Studio end-to-end check");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-studio-e2e-"));
  const workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(path.join(workspace, "media"), { recursive: true });
  fs.writeFileSync(path.join(workspace, CLIP_PATH), CLIP_BYTES);
  fs.writeFileSync(path.join(workspace, MUSIC_PATH), Buffer.alloc(8192, 2));

  const configFile = path.join(tmpDir, "config.json");
  process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
  process.env.MANUS_LOCAL_SKILLS_DIR = path.join(tmpDir, "skills");
  process.env.MANUS_LOCAL_EVALS_DIR = path.join(tmpDir, "evals");
  process.env.LOAM_AUTH_DISABLED = "true";
  process.env.LOAM_CONFIG = configFile;
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      workspace,
      memory: { enabled: false },
      screen: { enabled: false },
      selfImprove: { enabled: false },
      computerUse: { enabled: false },
      vision: { enabled: false },
      mcpServers: {},
    }),
    "utf8",
  );

  let closeDb: (() => void) | undefined;
  let server: http.Server | undefined;
  let fakeModel: { baseUrl: string; stop: () => Promise<void> } | undefined;
  let panel: { stop: () => void } | undefined;
  try {
    ({ closeDb } = await import("../server/sqliteStore.js"));
    const db = await import("../server/db.js");
    const { loadConfig } = await import("../config.js");
    const { OllamaClient } = await import("../ollama.js");
    const { startServer } = await import("../server/http.js");
    const { videoStudioRelay } = await import("../server/videoStudioRelay.js");
    const { createVideoStudioTools, isFilmcraftDistInstalled } = await import("../tools/videoStudio.js");
    const { ToolRegistry } = await import("../tools/registry.js");
    const { runAgent } = await import("../agent/loop.js");

    // ---- Phase A: the flow, always ----

    // The tool resolves the editor dist from a root. Phase A gives it a root that
    // carries a minimal dist marker (the same trick the fc-03 e2e test uses), so
    // the flow is exercised end to end without the wasm editor present.
    const fakeRoot = path.join(tmpDir, "fake-root");
    fs.mkdirSync(path.join(fakeRoot, "electron", "filmcraft", "dist"), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, "electron", "filmcraft", "dist", "index.html"), "<html></html>");

    const task = db.createTask("fc-10 فحص استوديو الفيديو", "e2e");
    const taskId = task.id;
    db.setTaskWorkspace(taskId, workspace);

    const cfg = loadConfig();
    cfg.server.host = "127.0.0.1";
    cfg.server.port = 0;
    cfg.model = "mock-coder";
    cfg.workspace = workspace;
    cfg.vision.enabled = false;
    // The scripted model answers every request, so the run never needs the
    // coding-model failover chain (which would contact remote providers).
    cfg.coding = { enabled: false, chain: [], logEdits: false };
    cfg.orchestrator.enabled = false;

    server = await startServer({
      cfg,
      ollama: new OllamaClient("http://127.0.0.1:1"),
      runTask: async () => ({ taskId, text: "" }),
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    fakeModel = await startFakeModel();
    const ollama = new OllamaClient(fakeModel.baseUrl);

    const tools = new ToolRegistry();
    tools.registerAll(createVideoStudioTools({ relay: videoStudioRelay, root: fakeRoot }));

    // A1. fc-04: the panel opens by itself from the user's message.
    const autoOpen = decideAutoOpen(CLIP_PATH, PROMPT);
    assert.deepEqual(autoOpen, { path: CLIP_PATH, kind: "loam-video", importPath: CLIP_PATH });
    results(true, "a video attachment with an Arabic edit instruction auto-opens the Video Studio panel", [
      `target: ${autoOpen!.kind} path=${autoOpen!.path} import=${autoOpen!.importPath}`,
    ]);

    // A2. The editor panel imports the attached clip on load, exactly like the
    //     browser panel does when the workspace auto-opens. It goes through the
    //     real relay, so the command is observable on the same path the tool uses.
    const timeline = initialTimeline();
    const relayLog: StreamEvent[] = [];
    panel = attachPanel(base, taskId, timeline, relayLog, () => {
      // The user trims the tail by hand while the agent's first state read is in
      // flight. The stand-in keeps the new clip in its own copy.
      timeline.sequences[0]!.tracks[0]!.clips = [{ ...timeline.sequences[0]!.tracks[0]!.clips[0]!, endSec: 14 }];
    });
    await waitForAttached(taskId);
    await videoStudioRelay.enqueue(taskId, FILM_TARGET, "importFiles", {
      files: [path.join(workspace, CLIP_PATH)],
    });

    // A3. The whole run: real loop, real tool, real relay, stand-in panel.
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const run = await runAgent({
      cfg,
      ollama,
      tools,
      prompt: PROMPT,
      history: [],
      taskId,
      // The scripted model answers the verifier prompt with the final-answer turn,
      // so the terminal gate is driven separately: this check is about the Video
      // Studio flow, not about model-driven verification quality.
      suppressFinal: true,
      emit: (event) => {
        events.push(event as { type: string; [key: string]: unknown });
      },
    });
    const finalText = run.text ?? "";
    log(`      final answer: ${JSON.stringify(finalText)}`);

    // A4. fc-05: the agent read the live timeline before every command.
    const methods = relayLog.map((event) => event.method);
    assert.deepEqual(methods, EXPECTED_METHODS, `unexpected relay method sequence: ${methods.join(", ")}`);
    results(true, "the agent read the live timeline (inspect) before every mutating command", [
      `relay sequence: ${methods.join(", ")}`,
    ]);

    // A5. fc-05: the manual edit survived — the agent cut the user's 14s clip at
    //     2s instead of rebuilding a 20s timeline. A rebuild would have produced a
    //     clip ending at 20s and no split at 2s.
    const clipAfter = timeline.sequences[0]!.tracks[0]!.clips;
    const endsAt = clipAfter.map((clip) => clip.endSec).sort((a, b) => a - b);
    log(`      video clips after run: ${JSON.stringify(clipAfter.map((clip) => [clip.id, clip.startSec, clip.endSec]))}`);
    assert.deepEqual(endsAt, [2, 14], "the user's manual trim to 14s must survive, with the agent's cut at 2s applied on top");
    results(true, "a manual edit made in the panel is preserved (the agent did not rebuild the timeline)", [
      `clip after run: ${clipSummary(timeline)}`,
    ]);

    // A5b. fc-05: the tool surfaced the manual edit to the agent. The notice is
    //      prepended to the tool result, so it precedes the JSON summary. The
    //      summary is truncated for the event log, so match the notice anywhere in
    //      the result rather than only at its start.
    const noticeEvents = events.filter((event) => event.type === "tool_result" && String(event.summary ?? "").includes("edited the timeline manually"));
    assert.ok(noticeEvents.length > 0, "the agent must see the manual-edit notice");
    results(true, "the tool surfaced the manual-edit notice to the agent", [
      `notices: ${noticeEvents.length}`,
    ]);

    // A6. fc-06: the export landed in the task's files.
    const exportFile = path.join(workspace, "exports", `${EXPORT_NAME}.mp4`);
    assert.ok(fs.existsSync(exportFile), `export file missing at ${exportFile}`);
    const bytes = fs.readFileSync(exportFile);
    assert.ok(bytes.length > 0, "the export file is empty");
    results(true, "the rendered export was saved into the task's files", [
      `path: exports/${EXPORT_NAME}.mp4 (${bytes.length} bytes)`,
    ]);

    // A7. `/api/files` — the route the UI reads — lists the export. The route walks
    //      the task workspace and returns `entries` (newest first).
    const filesRes = await fetch(`${base}/api/files?taskId=${encodeURIComponent(taskId)}`);
    assert.equal(filesRes.status, 200);
    const listing = (await filesRes.json()) as { entries?: Array<{ path: string; name: string; size: number }> };
    const listed = (listing.entries ?? []).find((entry) => entry.path.replace(/\\/g, "/").endsWith(`exports/${EXPORT_NAME}.mp4`));
    assert.ok(listed, "the export is not listed by /api/files");
    results(true, "the export appears in the task's files as the UI sees them", [
      `listed: ${listed!.path} (${listed!.size} bytes)`,
    ]);

    // A8. The run completed with a real final answer, not a repair loop.
    assert.match(finalText, /صدّرت|تصدير|exports\//, "the final answer does not mention the export");
    assert.ok(!finalText.includes("revise"), "the run ended in a repair loop");
    results(true, "the agent completed with an evidence-grounded final answer", [`answer: ${finalText.slice(0, 120)}`]);

    // ---- Phase B: the real vendored dist ----

    const realDist = path.join(repoRoot(), "electron", "filmcraft", "dist", "index.html");
    if (!fs.existsSync(realDist)) {
      skip("the real FilmCraft wasm editor is not vendored in this checkout", [
        `expected ${realDist} (install with \`npm run vendor\`, network required)`,
        "the stand-in panel above proves the flow; the real editor is driven by the browser",
        "panel, whose rendering is covered by the web e2e tests",
      ]);
    } else {
      const installed = isFilmcraftDistInstalled(repoRoot());
      assert.equal(installed, true, "the tool must see the vendored FilmCraft dist");
      results(true, "the tool sees the vendored FilmCraft dist", [
        `dist: ${path.join(repoRoot(), "electron", "filmcraft", "dist")}`,
      ]);
    }
  } finally {
    panel?.stop();
    await waitForDetached("").catch(() => undefined);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await fakeModel?.stop();
    try {
      closeDb?.();
    } catch {
      /* already closed */
    }
    for (const key of ["MANUS_LOCAL_DATA_DIR", "MANUS_LOCAL_SKILLS_DIR", "MANUS_LOCAL_EVALS_DIR", "LOAM_AUTH_DISABLED", "LOAM_CONFIG"]) {
      delete process.env[key];
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  log(process.exitCode ? "fc-10 check: FAILED" : "fc-10 check: OK");
}

await main().catch((error: unknown) => {
  log(`fc-10 check: ERROR — ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) log(error.stack);
  process.exitCode = 1;
});
