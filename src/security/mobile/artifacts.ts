import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type MobileArtifactKind = "apk" | "ipa" | "aab";

export interface MobileArtifact {
  path: string;
  relativePath: string;
  kind: MobileArtifactKind;
  bytes: number;
  sha256: string;
}

export interface ArtifactLimits {
  maxFiles?: number;
  maxBytes?: number;
  maxDepth?: number;
}

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export function discoverMobilePackages(rootInput: string, limits: ArtifactLimits = {}): string[] {
  const root = path.resolve(rootInput);
  const maxFiles = limits.maxFiles ?? 20;
  const maxDepth = limits.maxDepth ?? 7;
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && !["node_modules", ".git", "dist", "build", "release"].includes(entry.name)) walk(full, depth + 1);
      if (entry.isFile() && /\.(apk|ipa|aab)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

export async function inspectMobileArtifact(fileInput: string, rootInput: string, limits: ArtifactLimits = {}): Promise<MobileArtifact> {
  const root = path.resolve(rootInput);
  const file = path.resolve(fileInput);
  if (!inside(root, file)) throw new Error("mobile artifact must be inside the engagement workspace");
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("mobile artifact must be a regular file without symlinks");
  const match = /\.(apk|ipa|aab)$/i.exec(file);
  if (!match) throw new Error("unsupported mobile artifact; expected .apk, .ipa or .aab");
  const maxBytes = limits.maxBytes ?? 500 * 1024 * 1024;
  if (stat.size < 1 || stat.size > maxBytes) throw new Error(`mobile artifact size must be between 1 and ${maxBytes} bytes`);
  const hash = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return {
    path: file,
    relativePath: path.relative(root, file).replace(/\\/g, "/"),
    kind: match[1]!.toLowerCase() as MobileArtifactKind,
    bytes: stat.size,
    sha256: hash.digest("hex"),
  };
}

export async function inventoryMobileArtifacts(root: string, limits: ArtifactLimits = {}): Promise<MobileArtifact[]> {
  const files = discoverMobilePackages(root, limits);
  const artifacts: MobileArtifact[] = [];
  for (const file of files) artifacts.push(await inspectMobileArtifact(file, root, limits));
  return artifacts;
}
