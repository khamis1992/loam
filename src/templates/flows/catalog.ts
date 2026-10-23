/**
 * Neo N15 — Case Playbook catalog.
 *
 * Loads the 12 flow templates. The landing gallery and the
 * `/api/flow-templates` HTTP route both read from this catalog, so the JSON
 * files are the single source of truth.
 *
 * Two loaders, because the server runs from two shapes:
 *   - `tsx src/index.ts` (dev): the JSON files are read from `src/templates/flows`.
 *   - `dist/server.cjs` (packaged app): esbuild bundles the JSON contents into
 *     the bundle, and `src/` is not shipped. `import.meta` is also unavailable
 *     in a CJS bundle, so the file loader cannot even locate the directory.
 *
 * The bundled copy is attached to `globalThis` by the build plugin in
 * `scripts/build-server.cjs`, which prepends a single assignment statement to
 * this file. Reading it lazily (rather than at module scope) keeps the loader
 * correct no matter where esbuild hoists declarations in the emitted bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLOW_TEMPLATE_FILE_NAMES,
  validateFlowTemplates,
  type FlowTemplate,
  type FlowTemplateId,
} from "./schema.js";

/** Key the build plugin stashes the bundled flow JSON under. */
const BUNDLED_FLOWS_KEY = "__LOAM_FLOW_TEMPLATES__";

/** The inlined flow JSON, or `{}` when running from source. */
function bundledFlows(): Partial<Record<FlowTemplateId, unknown>> {
  const holder = globalThis as unknown as Record<string, unknown>;
  const value = holder[BUNDLED_FLOWS_KEY];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Partial<Record<FlowTemplateId, unknown>>;
  }
  return {};
}

function fromDisk(id: FlowTemplateId): FlowTemplate | null {
  let dir: string | null = null;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null; // CJS bundle: import.meta is unavailable
  }
  try {
    const raw = fs.readFileSync(path.join(dir, FLOW_TEMPLATE_FILE_NAMES[id]), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as FlowTemplate;
  } catch {
    /* fall through to the bundled copy */
  }
  return null;
}

function loadFlowFile(id: FlowTemplateId): FlowTemplate | null {
  const parsed = bundledFlows()[id] ?? fromDisk(id);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as FlowTemplate;
}

/** All 12 flow templates, in catalog order. */
export const FLOW_TEMPLATES: FlowTemplate[] = (() => {
  const ids = Object.keys(FLOW_TEMPLATE_FILE_NAMES) as FlowTemplateId[];
  const loaded = ids.map((id) => loadFlowFile(id)).filter((t): t is FlowTemplate => t !== null);
  return validateFlowTemplates(loaded);
})();

/** Lookup a flow template by its slug. */
export function getFlowTemplate(id: string): FlowTemplate | undefined {
  return FLOW_TEMPLATES.find((t) => t.id === id);
}
