// src/appbuilder/roles.ts
import type { AppRoleId } from "./types.js";
import type { Tool } from "../tools/registry.js";
import { globToRegExp } from "../tools/findAndEdit.js";

export type ModelClass = "fast" | "coding" | "reasoning";

export interface AppRoleSpec {
  id: AppRoleId;
  label: string;
  labelAr: string;
  /** Tools the role may call (intersected with the Build mode tool list at run time). */
  tools: readonly string[];
  /** Default model class per step kind; stepRouting may escalate. */
  modelClass: { plan: ModelClass; act: ModelClass; recover: ModelClass };
  /** Files this role may write, as POSIX globs relative to the workspace. */
  writeScope: readonly string[];
  /** Hard cap on tool calls per assignment. */
  maxToolCalls: number;
}

const READ = ["file_read", "file_list", "file_search", "grep", "glob", "code_symbols", "code_outline", "semantic_search"] as const;
const WRITE = ["file_write", "file_edit", "file_multi_edit", "find_and_edit", "file_mkdir", "file_move", "file_delete"] as const;

export const APP_ROLES: Record<AppRoleId, AppRoleSpec> = {
  lead: {
    id: "lead", label: "Lead", labelAr: "القائد",
    tools: [...READ, "think", "app_task_create", "app_task_finish", "app_context_write", "wiki_read", "message"],
    modelClass: { plan: "reasoning", act: "fast", recover: "reasoning" },
    writeScope: [".loam/context/**"],
    maxToolCalls: 16,
  },
  engineer: {
    id: "engineer", label: "Engineer", labelAr: "المهندس",
    tools: [...READ, ...WRITE, "shell_run", "app_verify", "app_context_write", "app_version_note", "app_db_query", "app_add_dependency", "preview_screenshot", "design_lint", "docs_lookup", "think", "finish"],
    modelClass: { plan: "coding", act: "coding", recover: "reasoning" },
    writeScope: ["app/**", "DESIGN.md", ".loam/context/**"],
    maxToolCalls: 48,
  },
  product: {
    id: "product", label: "Product", labelAr: "المنتج",
    tools: [...READ, "file_write", "file_edit", "web_search", "web_fetch", "think", "finish"],
    modelClass: { plan: "reasoning", act: "fast", recover: "reasoning" },
    writeScope: [".loam/context/PROJECT.md", ".loam/context/PROGRESS.md"],
    maxToolCalls: 14,
  },
  architect: {
    id: "architect", label: "Architect", labelAr: "المعماري",
    tools: [...READ, "file_write", "file_edit", "think", "finish"],
    modelClass: { plan: "reasoning", act: "reasoning", recover: "reasoning" },
    writeScope: [".loam/context/ARCHITECTURE.md"],
    maxToolCalls: 14,
  },
  data: {
    id: "data", label: "Data", labelAr: "البيانات",
    tools: [...READ, ...WRITE, "shell_run", "loam_dataset", "app_db_query", "app_add_dependency", "think", "finish"],
    modelClass: { plan: "coding", act: "coding", recover: "reasoning" },
    writeScope: ["app/src/lib/**", "app/server/**", "app/tests/**", "app/scripts/**"],
    maxToolCalls: 30,
  },
  research: {
    id: "research", label: "Research", labelAr: "البحث",
    tools: [...READ, "web_search", "web_fetch", "deep_research", "file_write", "think", "finish"],
    modelClass: { plan: "reasoning", act: "fast", recover: "reasoning" },
    writeScope: [".loam/context/research/**"],
    maxToolCalls: 24,
  },
  seo: {
    id: "seo", label: "SEO", labelAr: "تحسين البحث",
    tools: [...READ, "file_write", "file_edit", "shell_run", "web_fetch", "think", "finish"],
    modelClass: { plan: "fast", act: "fast", recover: "coding" },
    writeScope: ["app/content/**", "app/index.html", "app/public/robots.txt", "app/site.config.json"],
    maxToolCalls: 20,
  },
};

/**
 * Roles the Lead may assign for a plan. Mirrors the observed Atoms rule
 * (SEO/Ads only for business templates) with Loam's own conditions.
 */
export function assignableRoles(features: readonly string[], taskCount: number, hasBackend: boolean): AppRoleId[] {
  const roles: AppRoleId[] = ["engineer"];
  if (taskCount > 6) roles.push("product");
  if (hasBackend || taskCount > 6) roles.push("architect");
  if (hasBackend) roles.push("data");
  roles.push("research");
  if (features.includes("seo-blog")) roles.push("seo");
  return roles;
}

// ---------- write-scope gate (MISSING §4.2.3) ----------

/** The registry surface the role gate needs (a `ToolRegistry` or a filtered sub). */
export interface RoleGateRegistry {
  names(): string[];
  get(name: string): Tool | undefined;
  replaceTool(tool: Tool): void;
}

/** Tools whose file targets are checked against the active role's writeScope. */
const GATED_WRITE_TOOLS = new Set(["file_write", "file_edit", "file_multi_edit", "find_and_edit", "file_move", "file_delete"]);

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

/** Workspace-relative POSIX targets a gated tool call wants to touch. */
function targetsForTool(name: string, args: Record<string, unknown>): string[] {
  const str = (key: string): string => (typeof args[key] === "string" ? args[key] as string : "");
  if (name === "file_move") return [str("from"), str("to")].filter(Boolean);
  if (name === "find_and_edit") return [str("dir") || "."];
  return [str("path")].filter(Boolean);
}

/** True when the workspace-relative path matches at least one glob of the role's writeScope. */
export function pathInWriteScope(role: AppRoleSpec, relPath: string): boolean {
  const rel = toPosix(relPath).replace(/^\.\//, "");
  return role.writeScope.some((glob) => globToRegExp(glob).test(rel));
}

/**
 * Wrap the mutating file tools so a role cannot write outside its writeScope
 * (MISSING §4.2.3). Written the same way as `applyPlanApprovalGate`
 * (`src/tools/planTools.ts`); the refusal is the spec's exact text:
 * `Role <label> may not write <path>. Hand this to the Engineer.`
 */
export function applyRoleScopeGate(registry: RoleGateRegistry, getActiveRole: () => AppRoleId): void {
  for (const name of registry.names()) {
    if (!GATED_WRITE_TOOLS.has(name)) continue;
    const original = registry.get(name);
    if (!original) continue;
    registry.replaceTool({
      ...original,
      async run(args, ctx) {
        const roleId = getActiveRole();
        const spec = APP_ROLES[roleId];
        if (spec) {
          for (const target of targetsForTool(name, args)) {
            const rel = toPosix(target);
            if (!pathInWriteScope(spec, rel)) {
              return { ok: false, content: `Role ${spec.label} may not write ${rel}. Hand this to the Engineer.` };
            }
          }
        }
        return original.run(args, ctx);
      },
    });
  }
}
