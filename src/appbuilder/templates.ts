/**
 * Cap G template loader (minimal Wave-1 slice): reads templates/web-app files
 * from disk. The full manifest/composer (features, overlays) lands with G2 per
 * the wave split; depsCache only needs package.json today.
 */
import fs from "node:fs";
import path from "node:path";
import type { TemplateFeatureId, TemplateId } from "./types.js";

export interface TemplateFile { path: string; content: string }

export interface ComposedTemplate {
  id: TemplateId;
  features: TemplateFeatureId[];
  files: TemplateFile[];
}

const ROOT = () => path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "templates");

/** Walk the base template dir (skip node_modules, dist, .git, binaries). */
function walk(dir: string, base: string, out: TemplateFile[]): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === ".git" || ent.name === ".vite-cache") continue;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (ent.isDirectory()) walk(abs, base, out);
    else if (ent.isFile() && rel) out.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
  }
}

export function loadTemplate(id: TemplateId, features: TemplateFeatureId[] = []): ComposedTemplate {
  if (id !== "web-app") throw new Error(`unknown template ${id}`);
  const files: TemplateFile[] = [];
  walk(path.join(ROOT(), id), path.join(ROOT(), id), files);
  // Overlays land with G2; features are recorded but not composed yet.
  return { id, features, files };
}
