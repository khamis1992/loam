import fs from "node:fs";
import { getLoamMode, getLoamModesUi, LOAM_MODES } from "../modes/catalog.js";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../config.js";
import type { PreviewService } from "../preview/serve.js";
import { createCraftOfficeTool } from "./craftOffice.js";
import { bool, num, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";
import { DEFAULT_BASE_NAME, ingestContent } from "../knowledge/ingest.js";
import { fromFile, fromText, resolveImportPath } from "../knowledge/importers.js";
import { runKnowledgeSearch, type KnowledgeToolOptions } from "./knowledge.js";

/**
 * Resolves the sibling `manus.im/manus-local/core` directory containing the 145+ Frontier ESM modules.
 */
export function resolveFrontierCoreDir(): string | null {
  const candidates: string[] = [];
  if (process.env.MANUS_FRONTIER_CORE_DIR) {
    candidates.push(process.env.MANUS_FRONTIER_CORE_DIR);
  }
  candidates.push(
    path.resolve(ROOT, "core"),
    path.resolve(ROOT, "..", "manus.im", "manus-local", "core"),
    path.resolve(process.cwd(), "manus-local", "core"),
    path.resolve(process.cwd(), "core"),
  );

  for (const startDir of [ROOT, process.cwd()]) {
    let cur = path.resolve(startDir);
    for (let depth = 0; depth < 6; depth++) {
      candidates.push(path.join(cur, "manus.im", "manus-local", "core"));
      candidates.push(path.join(cur, "manus-local", "core"));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const home = os.homedir();
  if (home) {
    candidates.push(
      path.join(home, "Desktop", "manus.im", "manus-local", "core"),
      path.join(home, "manus.im", "manus-local", "core"),
    );
  }

  for (const dir of candidates) {
    if (dir && fs.existsSync(dir) && fs.existsSync(path.join(dir, "modes.mjs"))) {
      return dir;
    }
  }
  return null;
}

async function importFrontierModule<T = Record<string, unknown>>(relPath: string): Promise<T> {
  const coreDir = resolveFrontierCoreDir();
  if (!coreDir) {
    throw new Error("Frontier core directory (manus.im/manus-local/core) not found");
  }
  const fullPath = path.join(coreDir, relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Frontier module not found: ${fullPath}`);
  }
  return (await import(pathToFileURL(fullPath).href)) as T;
}

export async function getFrontierBridgeStatus(workspace: string): Promise<{
  available: boolean;
  coreDir: string | null;
  modesCount: number;
  modes: Array<{ id: string; label: string; labelAr: string }>;
  workspace: string;
}> {
  const coreDir = resolveFrontierCoreDir();
  if (!coreDir) {
    return { available: false, coreDir: null, modesCount: 0, modes: [], workspace };
  }
  try {
    const modesMod = await importFrontierModule<{
      MODES_CATALOG: Record<string, { id: string; label: string; labelAr: string }>;
    }>("modes.mjs");
    const modes = Object.values(modesMod.MODES_CATALOG ?? {}).map((m) => ({
      id: m.id,
      label: m.label,
      labelAr: m.labelAr,
    }));
    return {
      available: true,
      coreDir,
      modesCount: modes.length,
      modes,
      workspace,
    };
  } catch {
    return { available: false, coreDir, modesCount: 0, modes: [], workspace };
  }
}

// ============================================================================
// Per-Mode UI identity (icon + oklch hue + Arabic tagline) — powers the
// clickable Modes panel and the per-mode theme in the desktop/web UI.
// ============================================================================

export interface ModeUi {
  icon: string;
  hue: number;
  hue2: number;
  tagline: string;
}

export const MODE_UI: Record<string, ModeUi> = Object.fromEntries(LOAM_MODES.map((mode) => [mode.id, { icon: mode.icon, hue: mode.hue, hue2: mode.hue2, tagline: mode.tagline }]));

/** Lists all frontier modes merged with their UI identity (icon/hue/tagline). */
export async function getFrontierModesUi(_workspace: string, registeredNames: string[] = []) {
  return { ...getLoamModesUi(registeredNames), activeMode: lastActiveMode };
}

// ============================================================================
// Frontier Mode Switching — actually switches the shared 27-mode engine
// (the same service that gates the mode* tools) into the requested mode.
// ============================================================================

/** Tracks the app-wide active frontier mode (createModeService boots in "full"). */
let lastActiveMode = "build";

export interface FrontierSwitchResult {
  ok: boolean;
  mode?: string;
  label?: string;
  labelAr?: string;
  activeTools?: string[];
  activeToolCount?: number;
  totalRegisteredTools?: number;
  error?: string;
}

/** Switches the shared frontier mode service into `modeId` and returns its status. */
export async function switchFrontierMode(_workspace: string, modeId: string, _reason = "ui switch"): Promise<FrontierSwitchResult> {
  try {
    const mode = getLoamMode(modeId);
    lastActiveMode = mode.id;
    return { ok: true, mode: mode.id, label: mode.label, labelAr: mode.labelAr, activeTools: mode.tools, activeToolCount: mode.tools.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createFrontierBridgeTools(preview?: PreviewService, knowledge: KnowledgeToolOptions = {}): Tool[] {
  // Phase-2 W2 «تحدث مع ملفاتك»: the rag_* redirectors rank through the same
  // garden wiring (embedder/model) as the kb_* tools, so one store, one ranking.
  const knowledgeSearchDefaults = {
    ...(knowledge.embedder ? { embedder: knowledge.embedder } : {}),
    ...(knowledge.model ? { model: knowledge.model } : {}),
  };
  return [
    {
      name: "super_swarm",
      description:
        "Run the 4-Agent Frontier App Engineering Swarm (Architect -> Backend SQLite/RLS -> Frontend oklch() UI -> 4-Pillar Zero-Defect Verifier) to synthesize, verify, and certify a complete full-stack application in the workspace.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Application specification or user goal (Arabic or English)." },
          hybridPolicy: {
            type: "string",
            enum: ["local-first", "balanced", "frontier-first"],
            description: "Routing policy across local Ollama and frontier models.",
          },
          subDir: { type: "string", description: "Optional subfolder inside workspace (default: workspace root)." },
        },
        required: ["prompt"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const prompt = str(args, "prompt").trim();
        if (!prompt) return { ok: false, content: "prompt is required" };
        const subDir = str(args, "subDir").trim();
        const targetDir = subDir ? path.resolve(ctx.workspace, subDir) : ctx.workspace;
        const swarmMod = await importFrontierModule<{
          runAppEngineeringSwarm: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
        }>("super/swarm.mjs");
        const res = await swarmMod.runAppEngineeringSwarm({
          prompt,
          workspaceDir: targetDir,
          hybridPolicy: str(args, "hybridPolicy", "local-first"),
          useCdp: false,
        });
        if (preview && fs.existsSync(path.join(targetDir, "index.html"))) {
          try {
            await preview.start(targetDir);
          } catch {
            /* ignore preview error */
          }
        }
        return { ok: true, content: JSON.stringify(res, null, 2) };
      },
    },

    {
      name: "super_quality_gate",
      description:
        "Run the 4-Pillar Zero-Defect Delivery Gate (U1 Semantic Code Graph + U2 Live SQLite RLS + U3 Multi-Viewport Visual Polish + U4 Autonomous SecOps), auto-heal defects, and issue a SHA-256 Zero-Defect Certificate.",
      parameters: {
        type: "object",
        properties: {
          autoFix: { type: "boolean", description: "Automatically heal detected code/RLS/visual/security issues (default: true)." },
          subDir: { type: "string", description: "Optional subfolder inside workspace." },
        },
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const subDir = str(args, "subDir").trim();
        const targetDir = subDir ? path.resolve(ctx.workspace, subDir) : ctx.workspace;
        const gateMod = await importFrontierModule<{
          runZeroDefectGate: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
        }>("super/quality-gate.mjs");
        const cert = await gateMod.runZeroDefectGate({
          workspaceDir: targetDir,
          autoFix: bool(args, "autoFix", true),
          useCdp: false,
        });
        return { ok: true, content: JSON.stringify(cert, null, 2) };
      },
    },

    {
      name: "super_time_travel",
      description:
        "Full-Stack Time-Travel Debugger (Z5): snapshots both workspace source files and all SQLite database rows, lists checkpoints, diffs two checkpoints, or rewinds the workspace + database to any prior state.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["capture", "list", "rewind", "diff"],
            description: "Time-travel operation to perform.",
          },
          label: { type: "string", description: "Checkpoint label when action='capture'." },
          checkpointId: { type: "string", description: "Target checkpoint ID when action='rewind'." },
          fromCheckpointId: { type: "string", description: "Base checkpoint ID when action='diff'." },
          toCheckpointId: { type: "string", description: "Target checkpoint ID when action='diff'." },
        },
        required: ["action"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const action = str(args, "action", "list");
        const svcMod = await importFrontierModule<{
          createSuperService: (opts: { workspaceDir: string }) => {
            call: (name: string, a: Record<string, unknown>) => Promise<Record<string, unknown>>;
            close: () => Promise<void>;
          };
        }>("super/service.mjs");
        const svc = svcMod.createSuperService({ workspaceDir: ctx.workspace });
        try {
          const out = await svc.call("super_time_travel", {
            action,
            label: str(args, "label", "agent-checkpoint"),
            checkpointId: str(args, "checkpointId"),
            fromCheckpointId: str(args, "fromCheckpointId"),
            toCheckpointId: str(args, "toCheckpointId"),
          });
          return { ok: Boolean(out.ok ?? true), content: JSON.stringify(out, null, 2) };
        } finally {
          await svc.close();
        }
      },
    },

    // cr-05: `office_craft` is now the agent driver of the five vendored Craft
    // apps (Loam Docs / Sheets / Slides / Photo / Design) over the cr-04
    // workspace relay. `src/tools/craftOffice.ts` owns the app/action surface;
    // this factory supplies the two things that module must not own itself: the
    // untouched `war_room` engine, and the existing built-in Loam implementation
    // that runs when a Craft app is missing or the caller asks for it.
    createCraftOfficeTool({
      warRoom: async (args, ctx) => {
        const title = str(args, "title", "وثيقة استديو الأوفيس التنفيذية");
        const outDir = str(args, "outDir", "office-out");
        const frontierOffice = await importFrontierModule<{
          runCSuiteWarRoom: (opts: Record<string, unknown>) => Record<string, unknown>;
        }>("office/frontier-suite.mjs");
        const officeStudioMod = await importFrontierModule<{
          buildOfficeStudioHtml: (opts: Record<string, unknown>) => string;
        }>("office/office-studio.mjs");
        const warRes = frontierOffice.runCSuiteWarRoom({
          projectTitle: title,
          outDir,
          workspace: ctx.workspace,
        });
        const absOutDir = path.join(ctx.workspace, outDir);
        fs.mkdirSync(absOutDir, { recursive: true });
        const studioHtml = officeStudioMod.buildOfficeStudioHtml({
          activeTab: "deck",
          wordDoc: warRes.wordDoc,
          gridWorkbook: warRes.workbook,
          deckPresentation: warRes.presentation,
        });
        fs.writeFileSync(path.join(absOutDir, "index.html"), studioHtml, "utf8");
        let previewUrl: string | null = null;
        if (preview) {
          try {
            const inst = await preview.start(absOutDir);
            previewUrl = inst.url;
          } catch {
            /* ignore */
          }
        }
        return {
          ok: true,
          content: JSON.stringify(
            {
              consensus: warRes.consensus,
              agentCount: warRes.agentCount,
              files: {
                ...(warRes.files as Record<string, unknown>),
                studioHtml: `${outDir}/index.html`,
              },
              previewUrl,
              transcript: warRes.transcript,
            },
            null,
            2,
          ),
        };
      },
      fallback: async (app, args, ctx) => {
        const title = str(args, "title", "وثيقة استديو الأوفيس التنفيذية");
        const instruction = str(args, "instruction");
        const outDir = str(args, "outDir", "office-out");
        // The legacy `engine: "studio"` generator built all three office files
        // plus the live studio page through the single `office_studio` entry
        // point; the per-app Craft fallback uses the matching `*_craft` one.
        const legacyStudio = str(args, "engine").trim().toLowerCase() === "studio";
        const officeMod = await importFrontierModule<{
          createOfficeCraftService: (opts: { workspace: string }) => {
            call: (name: string, a: Record<string, unknown>) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
          };
        }>("office/office-studio.mjs");
        const svc = officeMod.createOfficeCraftService({ workspace: ctx.workspace });
        const toolName = legacyStudio
          ? "office_studio"
          : app === "docs"
            ? "word_craft"
            : app === "sheets"
              ? "grid_craft"
              : app === "slides"
                ? "deck_craft"
                : "office_studio";
        const res = await svc.call(toolName, {
          action: instruction ? "ai_edit" : legacyStudio ? "build_studio" : "create",
          title,
          instruction: instruction || undefined,
          outDir,
        });
        if (preview && fs.existsSync(path.join(ctx.workspace, outDir, "index.html"))) {
          try {
            await preview.start(path.join(ctx.workspace, outDir));
          } catch {
            /* ignore */
          }
        }
        return { ok: res.ok, content: JSON.stringify(res.result, null, 2) };
      },
    }),

    {
      name: "lovable_studio",
      description:
        "Lovable.dev-equivalent OkLCh Design System & Multi-Route App Builder: builds apps with 8 oklch() archetypes, 4 official brand kits (nutrio, glam, fleetify, alaraf), 21 Bento components, data-tsd-source DOM tagging, and self-healing WCAG contrast.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project folder name inside workspace (e.g. 'lovable-app')." },
          prompt: { type: "string", description: "Description of the web app or UI to build." },
          brandKitId: { type: "string", description: "Optional brand kit (nutrio, glam, fleetify, alaraf)." },
          mode: { type: "string", enum: ["build", "chat", "plan"], description: "Interaction mode (default: build)." },
        },
        required: ["projectId", "prompt"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const lovMod = await importFrontierModule<{
          createLovableService: (opts: { workspaceDir: string }) => {
            call: (name: string, a: Record<string, unknown>) => Promise<Record<string, unknown>>;
          };
        }>("lovable/service.mjs");
        const svc = lovMod.createLovableService({ workspaceDir: ctx.workspace });
        const projectId = str(args, "projectId", "lovable-app");
        const res = await svc.call("lovable_build", {
          projectId,
          prompt: str(args, "prompt"),
          mode: str(args, "mode", "build"),
          brandKitId: str(args, "brandKitId") || undefined,
        });
        const projDir = path.join(ctx.workspace, projectId);
        if (preview && fs.existsSync(path.join(projDir, "index.html"))) {
          try {
            await preview.start(projDir);
          } catch {
            /* ignore */
          }
        }
        return { ok: true, content: JSON.stringify(res, null, 2) };
      },
    },

    {
      name: "metagpt_company",
      description:
        "MetaGPT Multi-Agent Software Company (Mike TeamLeader, Alice PM, Bob Architect, Eve ProjectManager, Alex Engineer, Edward QA) & Golden Bridge Pipeline (MiroFish Swarm + MetaGPT SOP + Super Zero-Defect Gate).",
      parameters: {
        type: "object",
        properties: {
          idea: { type: "string", description: "Software product requirement or idea (Arabic or English)." },
          projectName: { type: "string", description: "Optional snake_case project name." },
          goldenBridge: {
            type: "boolean",
            description: "If true, runs the full Golden Bridge Pipeline (MiroFish Swarm + MetaGPT SOP + SQLite/RLS + Zero-Defect Certificate).",
          },
        },
        required: ["idea"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const idea = str(args, "idea").trim();
        if (!idea) return { ok: false, content: "idea is required" };
        if (bool(args, "goldenBridge", false)) {
          const extMod = await importFrontierModule<{
            runGoldenBridgePipeline: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
          }>("metagpt/extensions.mjs");
          const out = await extMod.runGoldenBridgePipeline({
            idea,
            workspaceDir: ctx.workspace,
          });
          return { ok: true, content: JSON.stringify(out, null, 2) };
        }
        const mgMod = await importFrontierModule<{
          runSoftwareCompany: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
        }>("metagpt/software-company.mjs");
        const out = await mgMod.runSoftwareCompany({
          idea,
          projectName: str(args, "projectName") || undefined,
          workspaceDir: ctx.workspace,
        });
        return { ok: true, content: JSON.stringify(out, null, 2) };
      },
    },

    // ---- Frontier Mode-Engine domain tools (27-mode service, auto-escalating) ----
    modeTool("studio_blender", "Build a 3D model via the Blender studio engine: generates .obj/.mtl, .gltf, a runnable .blender.py script, and an interactive HTML viewer. Use for ANY 3D model/scene request.", {
      type: "object",
      properties: {
        name: { type: "string", description: "Model name, e.g. 'guardian-robot'." },
        shape: { type: "string", description: "Optional shape hint: robot, building, vase, spaceship, drone, cylinder." },
        prompt: { type: "string", description: "Optional free-form description of the desired model." },
        outDir: { type: "string", description: "Output subfolder inside workspace (default 'blender-out')." },
      },
      required: ["name"],
    }),
    modeTool("studio_scene_3d", "Compose a 3D scene from multiple objects with AABB collision detection, auto-resolution, and auto camera/light framing.", {
      type: "object",
      properties: {
        title: { type: "string" },
        objects: { type: "array", items: { type: "object" }, description: "Objects: [{ name, shape, location:[x,y,z] }]." },
        outDir: { type: "string" },
      },
    }),
    modeTool("game_build", "Generate a complete playable HTML5 Canvas + WebAudio game (templates: space-shooter, platformer, tower-defense, puzzle, 3d-runner) with a 60-FPS readiness audit.", {
      type: "object",
      properties: {
        title: { type: "string" },
        template: { type: "string", description: "space-shooter | platformer | tower-defense | puzzle | 3d-runner" },
        theme: { type: "string" },
        outDir: { type: "string" },
      },
    }),
    modeTool("presentation_build", "Build a rich interactive HTML5 slide deck (index.html) with SVG bar/line charts, KPI metrics, timelines, speaker notes, RTL support, plus slides.md export.", {
      type: "object",
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        theme: { type: "string" },
        slides: { type: "array", items: { type: "object" }, description: "Slides: [{ title, subtitle?, layout: title|metrics|chart|timeline|two-col, metrics?, chart?, timeline?, notes? }]." },
        outDir: { type: "string" },
      },
      required: ["title"],
    }),
    modeTool("data_analyze_suite", "Statistical analysis engine: descriptive stats, IQR/Z-score outliers, Pearson correlation matrix, and grouping for tabular data.", {
      type: "object",
      properties: {
        data: { type: "array", items: { type: "object" }, description: "Array of row objects." },
        groupBy: { type: "string", description: "Optional column name to group by." },
      },
      required: ["data"],
    }),
    modeTool("data_bi_dashboard", "Generate an interactive BI executive dashboard (index.html), Markdown report, and cleaned CSV from tabular data.", {
      type: "object",
      properties: {
        title: { type: "string" },
        data: { type: "array", items: { type: "object" } },
        outDir: { type: "string" },
      },
      required: ["data"],
    }),
    modeTool("ecommerce_scaffold", "E-commerce storefront scaffold: cart/coupon/VAT engine, HMAC-SHA256 webhook verifier, and RLS order schema.", {
      type: "object",
      properties: {
        storeName: { type: "string" },
        currency: { type: "string", description: "Default 'SAR'." },
        outDir: { type: "string" },
      },
    }),
    modeTool("invoice_zatca", "Generate a ZATCA Phase-2 compliant TLV Base64 QR e-invoice with line items and VAT computation.", {
      type: "object",
      properties: {
        sellerName: { type: "string" },
        vatNumber: { type: "string" },
        items: { type: "array", items: { type: "object" }, description: "[{ name, qty, unitPrice }]" },
        vatRate: { type: "number", description: "e.g. 0.15" },
        outDir: { type: "string" },
      },
      required: ["sellerName", "vatNumber"],
    }),
    modeTool("devops_scaffold", "Production DevOps scaffold: hardened multi-stage Dockerfile (non-root, HEALTHCHECK), docker-compose, GitHub Actions CI/CD, and hardened Nginx reverse proxy.", {
      type: "object",
      properties: {
        appName: { type: "string" },
        port: { type: "number" },
        outDir: { type: "string" },
      },
    }),
    modeTool("web3_contract_studio", "Solidity smart contract studio: scaffold (ERC-20, ERC-721, Escrow, Staking), ABI JSON + 4-byte selectors, and reentrancy/tx.origin audit.", {
      type: "object",
      properties: {
        contractName: { type: "string" },
        template: { type: "string", description: "erc20 | erc721 | escrow | staking" },
        customSolidity: { type: "string", description: "Optional full Solidity source to audit instead of a template." },
        outDir: { type: "string" },
      },
      required: ["contractName"],
    }),
    // Phase-2 W2 «تحدث مع ملفاتك»: rag_index/rag_query were bridges to the
    // external Frontier core's hybrid BM25+vector store, a core that does not
    // exist on this machine. They are now thin redirectors over the LOCAL
    // Knowledge Garden (src/knowledge, the same store behind kb_*), and no
    // execution path may call the absent external core anymore.
    {
      name: "rag_index",
      description:
        "Indexed into the local Knowledge Garden: each document becomes retrievable, citable [seed:ID] seeds (deterministic chunking). Accepts inline content or workspace file paths. To index every text file of the current task workspace use task_files_ingest; for a single pdf/docx/xlsx/pptx/url use kb_ingest.",
      parameters: {
        type: "object",
        properties: {
          documents: { type: "array", items: { type: "object" }, description: "[{ id, path, content }] — content (string) or path (workspace-relative file)." },
          chunkLines: { type: "number", description: "Ignored (kept for compatibility): the garden chunks by characters, not lines." },
        },
        required: ["documents"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const docs = Array.isArray(args.documents) ? args.documents : [];
        if (docs.length === 0) {
          return {
            ok: false,
            content: "rag_index requires documents. لتكشيف كل ملفات هذه المهمة استخدم task_files_ingest، ولمستند واحد استخدم kb_ingest.",
          };
        }
        const CAP = 20;
        const seedIds: string[] = [];
        const seedSummaries: Array<{ id: string; title: string; tags: string[]; preview: string }> = [];
        const skipped: string[] = [];
        for (const raw of docs.slice(0, CAP)) {
          const doc = (raw ?? {}) as { id?: unknown; path?: unknown; content?: unknown };
          const content = typeof doc.content === "string" ? doc.content : "";
          const relPath = typeof doc.path === "string" ? doc.path.trim() : "";
          const ref = relPath || (typeof doc.id === "string" && doc.id ? doc.id : "inline");
          if (!content && !relPath) {
            skipped.push(ref);
            continue;
          }
          try {
            const extracted = content ? fromText(content) : await fromFile(resolveImportPath(ctx.workspace, relPath));
            if (!extracted.text.trim()) {
              skipped.push(ref);
              continue;
            }
            const result = await ingestContent(extracted.text, {
              baseName: DEFAULT_BASE_NAME,
              tags: ["rag-index"],
              split: "fixed",
              provenance: { source: relPath ? "file" : "user_text", ref, ...(ctx.taskId ? { runId: ctx.taskId } : {}) },
            });
            seedIds.push(...result.seeds.map((s) => s.id));
            seedSummaries.push(...result.seeds.slice(0, 2).map((s) => ({ id: s.id, title: s.title, tags: s.tags, preview: s.body.slice(0, 160) })));
          } catch {
            skipped.push(ref);
          }
        }
        const head =
          `rag_index redirects to the local Knowledge Garden: ${seedIds.length} seed(s) indexed (base "${DEFAULT_BASE_NAME}")` +
          (docs.length > CAP ? `; only the first ${CAP} documents were processed` : "") +
          (skipped.length > 0 ? `; skipped: ${skipped.join(", ")}` : "");
        return {
          ok: seedIds.length > 0,
          content: `${head}\nCite the seeds as [seed:ID]; retrieve them with rag_query or kb_search. لتكشيف كل ملفات المهمة دفعة واحدة: task_files_ingest.`,
          kbSeedIds: seedIds,
          kbSeeds: seedSummaries,
        };
      },
    },
    {
      name: "rag_query",
      description:
        "Retrieval over the local Knowledge Garden (the same engine as kb_search): ranked seeds for a query, each citable as [seed:ID]. Redirected from the removed external hybrid store; answers are grounded in what task_files_ingest / kb_ingest / rag_index indexed.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
          generateUi: { type: "boolean", description: "Ignored (kept for compatibility)." },
        },
        required: ["query"],
      },
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        return runKnowledgeSearch({ query: str(args, "query"), k: num(args, "topK", 5) }, knowledgeSearchDefaults);
      },
    },
    modeTool("vision_to_fullstack", "Vision-to-Fullstack engine: extract a component tree + RLS SQL schema + API routes from a described UI and synthesize a full-stack app with 100% visual parity.", {
      type: "object",
      properties: {
        title: { type: "string" },
        entities: { type: "array", items: { type: "string" }, description: "Domain entity names, e.g. ['orders']." },
        outDir: { type: "string" },
      },
    }),
    modeTool("voice_turn_pipeline", "Bidirectional voice pipeline: route spoken text to the right mode and synthesize a playable RIFF/WAVE .wav reply.", {
      type: "object",
      properties: {
        transcriptText: { type: "string" },
        outDir: { type: "string" },
      },
      required: ["transcriptText"],
    }),
    modeTool("legal_compliance_studio", "Legal & compliance studio: Saudi PDPL / EU GDPR privacy policies, SLAs, and contract risk auditing (unlimited liability, unilateral termination, missing 72h breach notice).", {
      type: "object",
      properties: {
        organizationName: { type: "string" },
        frameworks: { type: "array", items: { type: "string" }, description: "e.g. ['PDPL','GDPR']" },
        contractText: { type: "string", description: "Optional contract text to audit." },
        outDir: { type: "string" },
      },
    }),
    modeTool("har_to_openapi_sdk", "Synthesize OpenAPI 3.1.0 + typed TypeScript SDK + mock server from HAR network captures.", {
      type: "object",
      properties: {
        title: { type: "string" },
        entries: { type: "array", items: { type: "object" }, description: "HAR entries: [{ request: { method, url }, response: { status } }]" },
        outDir: { type: "string" },
      },
    }),
    modeTool("digital_twin_build", "Real-time 3D digital twin: bind live IoT telemetry (temperature, vibration, RPM, pressure) to a 3D mesh with threshold CRITICAL alerts.", {
      type: "object",
      properties: {
        twinName: { type: "string" },
        shape: { type: "string" },
        telemetry: { type: "object", description: "{ temperatureC, vibrationMmS, rpm, pressureBar }" },
        thresholds: { type: "object", description: "{ maxTempC, maxVibrationMmS }" },
        outDir: { type: "string" },
      },
    }),
  ];
}

// ============================================================================
// Frontier Mode Auto-Detection (27-mode bilingual router from manus.im core)
// ============================================================================

export interface FrontierModeInfo {
  mode: string;
  label: string;
  labelAr: string;
  reason: string;
}

/** A suggestion only. Execution always uses the user's persisted explicit mode. */
export async function detectFrontierMode(prompt: string): Promise<FrontierModeInfo | null> {
  if (!prompt.trim()) return null;
  const matches: Array<[string, RegExp]> = [
    ["data", /csv|spreadsheet|dataset|بيانات|إحصاء|احصاء/i],
    ["media", /svg|poster|illustration|ملصق|شعار|تصميم بصري/i],
    ["research", /research|sources|ابحث|مصادر|بحث/i],
    ["write", /document|report|article|اكتب|مستند|رسالة|مقال/i],
    ["automate", /browser|automation|متصفح|أتمتة/i],
    ["ask", /explain|اشرح|ما هو|ما هي/i],
  ];
  const mode = getLoamMode(matches.find(([, pattern]) => pattern.test(prompt))?.[0] ?? "build");
  return { mode: mode.id, label: mode.label, labelAr: mode.labelAr, reason: "اقتراح بناءً على وصف المهمة؛ اختيارك هو المعتمد" };
}
export function modeSystemGuidance(mode: FrontierModeInfo): string {
  const selected = getLoamMode(mode.mode);
  return `Loam — ${selected.labelAr}: ${selected.description}`;
}

// ============================================================================
// Frontier Mode-Service bridge (backs the mode* tools above)
// ============================================================================

let modeServicePromise: Promise<{
  call: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown }>;
  switchMode: (mode: string, reason?: string) => unknown;
  getStatus: () => {
    activeMode: string;
    labelAr: string;
    activeTools: string[];
    activeToolCount: number;
    totalRegisteredTools: number;
  };
  close?: () => Promise<void>;
}> | null = null;
let modeServiceWorkspace = "";

async function getFrontierModeService(workspace: string) {
  if (modeServicePromise && modeServiceWorkspace === workspace) return modeServicePromise;
  modeServiceWorkspace = workspace;
  modeServicePromise = (async () => {
    const modesMod = await importFrontierModule<{
      createModeService: (opts: Record<string, unknown>) => {
        call: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown }>;
        switchMode: (mode: string, reason?: string) => unknown;
        getStatus: () => {
          activeMode: string;
          labelAr: string;
          activeTools: string[];
          activeToolCount: number;
          totalRegisteredTools: number;
        };
        close?: () => Promise<void>;
      };
    }>("modes.mjs");
    return modesMod.createModeService({ workspace, initialMode: "full" });
  })();
  return modeServicePromise;
}

function modeTool(name: string, description: string, parameters: Record<string, unknown>): Tool {
  return {
    name,
    description,
    parameters,
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const svc = await getFrontierModeService(ctx.workspace);
      const res = await svc.call(name, args);
      const ok = Boolean(res?.ok);
      const payload = (res as { result?: unknown })?.result ?? res;
      return {
        ok,
        content: ok
          ? JSON.stringify(payload, null, 2)
          : `frontier tool "${name}" failed: ${JSON.stringify(res ?? {}).slice(0, 400)}`,
      };
    },
  };
}
