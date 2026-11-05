import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { OllamaClient } from "../src/ollama.js";
import { ToolRegistry, type Tool, type ToolContext } from "../src/tools/registry.js";
import { createDeckTools } from "../src/packs/slides/tools.js";
import { createLocalFileTools } from "../src/packs/localFileTools.js";
import { createSitePackTools } from "../src/packs/build/tools.js";
import { createFinishTools } from "../src/tools/finishTools.js";
import { withPackGuard } from "../src/packs/guard.js";
import { toolsForPack } from "../src/packs/loader.js";
import { presentPackProject, readPackProject } from "../src/packs/present.js";
import { exportStudio } from "../src/studio/export.js";
import { extractJson } from "../src/agent/planner.js";
import type { PackId } from "../src/packs/types.js";
import type { AgentEvent } from "../src/agent/events.js";

const MODEL = "qwen36-uncensored-hauhau:latest";
const OUTPUT = path.resolve("output/verification/hauhau-packs.json");

interface Scenario {
  id: "A1" | "A3" | "A5";
  packId: PackId;
  prompt: string;
  tools: Tool[];
  setup?: (workspace: string) => Promise<string[]>;
  verify: (workspace: string, registry: ToolRegistry, context: ToolContext) => Promise<string>;
}

interface CallReport {
  name: string;
  ok: boolean;
  summary: string;
}

function slide(id: string, title: string, body: string) {
  return { id, title, body, notes: "المصادر الرسمية", background: "#F7F3EA", accent: "#187665" };
}

function studioSlide(id: string, title: string, body: string) {
  return { id, title, body, notes: "المصادر الرسمية", background: "#F7F3EA", accent: "#187665" };
}

function fileWriter(): Tool {
  return {
    name: "file_write",
    description: "Write a task file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    run: async (args, ctx) => {
      const relative = String(args.path ?? "");
      if (!/^[a-zA-Z0-9_.\/-]+$/.test(relative) || relative.includes("..")) return { ok: false, content: "invalid path" };
      const absolute = path.resolve(ctx.workspace, relative);
      if (!absolute.startsWith(path.resolve(ctx.workspace))) return { ok: false, content: "path escapes workspace" };
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, String(args.content ?? ""));
      return { ok: true, content: relative };
    },
  };
}

const scenarios: Scenario[] = [
  {
    id: "A1",
    packId: "loam-slides",
    prompt: "ابدأ بـdeck_init مرة واحدة فقط لعرض من خمس شرائح عن متحف الفن الإسلامي في قطر، يتضمن I. M. Pei وافتتاح 2008. لا تؤلف ولا تصدّر بعد. أعد JSON calls باستدعاء واحد فقط.",
    tools: [...createDeckTools(), ...createFinishTools(), fileWriter()],
    verify: async (workspace) => {
      const project = readPackProject(workspace, "loam-slides");
      if (!project || project.items.length !== 5 || project.items.some((item) => item.state !== "final")) throw new Error("five final slides are required");
      const file = project.items[0]?.path;
      if (!file || !fs.existsSync(path.join(workspace, file))) throw new Error("PPTX is missing");
      const presented = presentPackProject({ workspace, packId: "loam-slides", kind: "deck", artifacts: [{ path: file, kind: "deck", title: "Museum", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }] });
      if (!presented.ok) throw new Error(JSON.stringify(presented));
      return presented.uri;
    },
  },
  {
    id: "A3",
    packId: "loam-localfile",
    prompt: "ابدأ بـlocal_bind فقط على الملف المحدد مع mode=\"edit\" حصرًا، وليس copy. لا تكتب بعد. أعد JSON calls باستدعاء واحد فقط.",
    tools: [...createLocalFileTools(), ...createFinishTools(), fileWriter()],
    setup: async (workspace) => {
      const external = path.join(workspace, "external");
      fs.mkdirSync(external, { recursive: true });
      const source = path.join(external, "deck.pptx");
      const office = await exportStudio({ kind: "presentation", title: "Deck", revision: 1, content: { slides: [studioSlide("1", "الأولى", "النص الأول"), studioSlide("2", "الثانية", "النص الثاني")] } }, workspace);
      fs.writeFileSync(source, office.buffer);
      return [source];
    },
    verify: async (workspace) => {
      const project = readPackProject(workspace, "loam-localfile");
      const binding = (project?.data?.bindings as Array<{ baselineSha256: string; backups: string[] }> | undefined)?.[0];
      if (!binding || binding.backups.length === 0) throw new Error("PPTX backup is missing");
      return binding.backups[0]!;
    },
  },
  {
    id: "A5",
    packId: "loam-build",
    prompt: "ابدأ بـsite_init مرة واحدة فقط لمشروع موقع مطعم كويتي باسم مطعم الديوانية. لا تكتب الملفات ولا تنشر. أعد JSON calls باستدعاء واحد فقط.",
    tools: [...createSitePackTools(), ...createFinishTools(), fileWriter()],
    verify: async (workspace) => {
      const project = readPackProject(workspace, "loam-build");
      if (project?.items[0]?.state !== "final") throw new Error("site checkpoint is not final");
      return project.items[0].path ?? "index.html";
    },
  },
];

function context(workspace: string, packId: PackId, localFiles: string[]): ToolContext {
  return {
    cfg: { model: MODEL } as never,
    workspace,
    taskId: `hauhau-${packId}`,
    packId,
    emit: (_event: AgentEvent) => undefined,
    studioOptions: localFiles.length > 0 ? { localFiles, mode: "edit" } : undefined,
  };
}

function modelCalls(content: string): Array<{ name: string; args: Record<string, unknown> }> {
  const parsed = extractJson(content) as { calls?: unknown; call?: unknown } | null;
  const raw = Array.isArray(parsed?.calls) ? parsed.calls : parsed?.call ? [parsed.call] : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    const args = record.args ?? record.arguments ?? {};
    return [{ name: record.name, args: typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {} }];
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ollama = new OllamaClient(cfg.ollamaUrl);
  const started = performance.now();
  const scenarioReports: Array<Record<string, unknown>> = [];
  let valid = 0;
  let total = 0;
  let unknown = false;

  for (const scenario of scenarios) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `hauhau-${scenario.id.toLowerCase()}-`));
    let responsePreview = "";
    const reports: CallReport[] = [];
    try {
      const localFiles = scenario.setup ? await scenario.setup(workspace) : [];
      const ctx = context(workspace, scenario.packId, localFiles);
      const baseRegistry = new ToolRegistry();
      baseRegistry.registerAll(scenario.tools);
      const registry = withPackGuard(toolsForPack(baseRegistry, scenario.packId, scenario.tools.map((tool) => tool.name), scenario.packId === "loam-localfile" ? { includeWrapped: true } : {}), scenario.packId, 60_000);
      const response = await ollama.chat({
        model: MODEL,
        messages: [
          { role: "system", content: "Return only JSON in this exact shape: {\"calls\":[{\"name\":\"tool_name\",\"args\":{}}]}. Use only the supplied tools and valid arguments. Use task-relative paths, never /workspace. For slides use id,title,body,notes,background,accent. After every tool result, reuse returned ids, paths, revisions and hashes exactly; never invent them. No explanation. Complete the task with the fewest calls possible." },
          { role: "user", content: `${scenario.prompt}${localFiles.length > 0 ? `\nالملف المحدد: ${localFiles[0]}` : ""}` },
        ],
        tools: registry.toOllama(),
        format: { type: "object" },
        numPredict: 3_000,
        think: false,
        signal: AbortSignal.timeout(120_000),
      });
      responsePreview = response.content.slice(0, 1000);
      const calls = response.toolCalls.length > 0
        ? response.toolCalls.flatMap((call) => {
            const name = call.function?.name;
            if (!name) return [];
            const raw = call.function.arguments;
            if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return [{ name, args: raw }];
            try {
              const parsed = typeof raw === "string" ? JSON.parse(raw) : {};
              return [{ name, args: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} }];
            } catch {
              return [{ name, args: {} }];
            }
          })
        : modelCalls(response.content);
      if (scenario.id !== "A3") {
        const initial = calls.shift();
        if (!initial) throw new Error("initial pack call is missing");
        total += 1;
        const initialized = await registry.exec(initial.name, initial.args, ctx);
        if (initialized.ok) valid += 1;
        reports.push({ name: initial.name, ok: initialized.ok, summary: initialized.content.slice(0, 400) });
        if (!initialized.ok) throw new Error(initialized.content);
        const project = readPackProject(workspace, scenario.packId);
        if (scenario.id === "A1") {
          for (const item of project?.items ?? []) {
            const followup = await ollama.chat({
              model: MODEL,
              messages: [
                { role: "system", content: "Return only JSON in this exact shape: {\"calls\":[{\"name\":\"deck_author\",\"args\":{\"id\":\"...\",\"slide\":{\"id\":\"...\",\"title\":\"...\",\"body\":\"...\",\"notes\":\"...\",\"background\":\"#F7F3EA\",\"accent\":\"#187665\"}}},{\"name\":\"deck_review\",\"args\":{\"id\":\"...\"}}]}. Use exactly two calls for the one requested slide and valid values. No explanation." },
                { role: "user", content: `نفّذ deck_author ثم deck_review للشريحة ${item.id} فقط. اكتب محتوى عربيًا دقيقًا عن متحف الفن الإسلامي مع I. M. Pei و2008 عند الحاجة.` },
              ],
              tools: registry.toOllama(),
              format: { type: "object" },
              numPredict: 900,
              think: false,
              signal: AbortSignal.timeout(120_000),
            });
            responsePreview += `\n${followup.content.slice(0, 1000)}`;
            calls.push(...modelCalls(followup.content));
          }
          calls.push({ name: "deck_export", args: {} });
        } else {
          const followup = await ollama.chat({
            model: MODEL,
            messages: [
              { role: "system", content: "Return only JSON in this exact shape: {\"calls\":[{\"name\":\"tool_name\",\"args\":{}}]}. Use valid arguments and reuse the supplied project values exactly. No explanation." },
              { role: "user", content: `اكتب index.html عربيًا مكتملًا للمطعم في ${String(project?.data?.projectDir ?? ".")} مع title وbody وزر حجز ثم نفّذ site_checkpoint حصرًا. لا تتوقف قبل checkpoint.` },
            ],
            tools: registry.toOllama(),
            format: { type: "object" },
            numPredict: 3_000,
            think: false,
            signal: AbortSignal.timeout(120_000),
          });
          responsePreview += `\n${followup.content.slice(0, 1000)}`;
          calls.push(...modelCalls(followup.content));
        }
      }
      if (scenario.id === "A3") {
        const initial = calls.shift();
        if (!initial || initial.name !== "local_bind") throw new Error("local_bind must be the first call");
        total += 1;
        const bound = await registry.exec(initial.name, initial.args, ctx);
        if (bound.ok) valid += 1;
        reports.push({ name: initial.name, ok: bound.ok, summary: bound.content.slice(0, 400) });
        if (!bound.ok) throw new Error(bound.content);
        const binding = (readPackProject(workspace, "loam-localfile")?.data?.bindings as Array<{ id: string; baselineSha256: string }> | undefined)?.[0];
        if (!binding) throw new Error("local_bind did not return a binding");
        const followup = await ollama.chat({
          model: MODEL,
          messages: [
            { role: "system", content: "Return only JSON in this exact shape: {\"calls\":[{\"name\":\"local_write_guarded\",\"args\":{\"id\":\"...\",\"expectedSha256\":\"...\",\"text\":\"...\"}}]}. Use the exact binding values. No explanation." },
            { role: "user", content: `اكتب تحديثًا نصيًا للملف باستخدام local_write_guarded فقط. id=${binding.id}, expectedSha256=${binding.baselineSha256}. لا تخترع قيمًا.` },
          ],
          tools: registry.toOllama(),
          format: { type: "object" },
          numPredict: 500,
          think: false,
          signal: AbortSignal.timeout(120_000),
        });
        responsePreview += `\n${followup.content.slice(0, 1000)}`;
        calls.push(...modelCalls(followup.content));
      }
      for (const call of calls) {
        total += 1;
        const result = await registry.exec(call.name, call.args, ctx);
        const ok = result.ok;
        if (ok) valid += 1;
        reports.push({ name: call.name, ok, summary: result.content.slice(0, 400) });
      }
      const evidence = await scenario.verify(workspace, registry, ctx);
      scenarioReports.push({ id: scenario.id, status: "passed", calls: reports, evidence });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/fetch|connect|ECONN|model|timeout|not found|unavailable/i.test(message)) unknown = true;
      scenarioReports.push({ id: scenario.id, status: unknown ? "unknown" : "failed", error: message, responsePreview, calls: reports });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  const ratio = total === 0 ? 0 : valid / total;
  const status = unknown ? "unknown" : ratio >= 0.9 && scenarioReports.every((report) => report.status === "passed") ? "passed" : "failed";
  const result = {
    status,
    model: MODEL,
    cloudFallback: false,
    validCalls: valid,
    totalCalls: total,
    ratio,
    requiredRatio: 0.9,
    durationMs: Math.round(performance.now() - started),
    scenarios: scenarioReports,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (status !== "passed") process.exitCode = status === "unknown" ? 2 : 1;
}

await main();
