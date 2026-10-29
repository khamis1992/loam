import path from "node:path";
import { requireTaskWorkspace } from "../server/taskWorkspace.js";
import type { PreviewService } from "../preview/serve.js";
import {
  createLocalDeployTarget,
  createNetlifyDeployTarget,
  createVercelDeployTarget,
  deployBuild,
  exportBuild,
  findTarget,
  targetCatalog,
  type DeployTarget,
} from "../preview/deploy.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

export interface DeployToolDeps {
  /** Base workspace root (Loam's configured workspace); each task gets its own dir under it. */
  workspace?: string;
  /** Preview service for turning the deployed dist dir into a live local URL. */
  preview?: PreviewService;
  /** Override the local dist root (defaults to <workspace>/.loam-deploy). */
  distRoot?: string;
}

/** The deploy target catalog for the tool + route layer. Local first. */
export function deployTargetCatalog(deps: DeployToolDeps): DeployTarget[] {
  const workspace = deps.workspace ?? "";
  const distRoot = deps.distRoot ?? path.join(workspace, ".loam-deploy");
  const local = createLocalDeployTarget({
    distRoot,
    ...(deps.preview
      ? {
          serve: async (dir: string) => (await deps.preview!.start(dir)).url,
        }
      : {}),
  });
  return targetCatalog(local);
}

/**
 * deploy_app {taskId, target?}: one-click deploy + export for a task's built app.
 * Runs the export (zips the build output) and pushes through the chosen target
 * (local by default). Cloud targets deploy statically when their token env is
 * present, and stay honest about missing credentials otherwise.
 */
export function createDeployTools(deps: DeployToolDeps): Tool[] {
  return [
    {
      name: "deploy_app",
      description:
        "نشر/تصدير تطبيق مبني بضغطة واحدة من مساحة المهمة: يجد مخرجات البناء (dist/build/out/www أو index.html)، ينتج أرشيف ZIP للتصدير، ثم يدفع عبر الهدف المحدد. الهدف local يكتب مجلد dist محليًا ويعيد رابطًا محليًا؛ أهداف سحابية (vercel/netlify) تنشر ثابتًا عند توفر التوكن في البيئة (VERCEL_TOKEN/NETLIFY_AUTH_TOKEN) وتفصح ببيانات الاعتماد الناقصة عند غيابه — الرفض لأي صفحة تستدعي APIs بنفس الأصل (السحابي للثابت فقط).",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task id whose workspace contains the built app." },
          target: {
            type: "string",
            description: 'Deploy target id: "local" (default), "vercel" or "netlify".',
          },
        },
        required: ["taskId"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        try {
          const taskId = str(args, "taskId").trim();
          if (!taskId) return { ok: false, content: "deploy_app: taskId مطلوب" };
          const root = requireTaskWorkspace(taskId, deps.workspace ?? ctx.workspace);
          const targets = deployTargetCatalog(deps);
          const targetId = str(args, "target", "local").trim() || "local";
          const target = findTarget(targets, targetId);
          if (!target) {
            return { ok: false, content: JSON.stringify({ ok: false, error: "unknown target", available: targets.map((t) => ({ id: t.id, kind: t.kind, requiredEnv: t.requiredEnv })) }) };
          }
          const outcome = await deployBuild(root, taskId, target);
          const zipInfo = exportBuild(root, taskId);
          return {
            ok: outcome.result.ok,
            content: JSON.stringify({
              ok: outcome.result.ok,
              target: outcome.result.target,
              url: outcome.result.url,
              distDir: outcome.result.distDir ?? null,
              zipPath: zipInfo.zipPath,
              exportBytes: zipInfo.bytes,
              files: outcome.result.files ?? zipInfo.fileCount,
              missingEnv: outcome.result.missingEnv ?? [],
              message: outcome.result.message,
            }),
          };
        } catch (err) {
          return { ok: false, content: `deploy_app failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
    {
      name: "export_build",
      description: "تصدير مخرجات البناء للمهمة كأرشيف ZIP داخل مساحة المهمة (.loam/exports). يرجع مسار الأرشيف وحجمه دون أي نشر.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Task id whose workspace contains the built app." },
        },
        required: ["taskId"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        try {
          const taskId = str(args, "taskId").trim();
          if (!taskId) return { ok: false, content: "export_build: taskId مطلوب" };
          const root = requireTaskWorkspace(taskId, deps.workspace ?? ctx.workspace);
          const info = exportBuild(root, taskId);
          return { ok: true, content: JSON.stringify({ ok: true, ...info, files: info.fileCount }) };
        } catch (err) {
          return { ok: false, content: `export_build failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  ];
}
