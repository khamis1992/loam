import path from "node:path";
import type { ToolRegistry } from "../tools/registry.js";
import { getPackManifest } from "./registry.js";
import { packErrorResult, withPackTimeout } from "./timeout.js";
import type { PackId } from "./types.js";

export function assertPackWriteAllowed(input: unknown): void {
  const value = String(input ?? "").replace(/\\/g, "/");
  const directManifest = path.posix.basename(value) === "manifest.json" || /(?:^|\/)\.loam\/packs\/[a-z0-9-]+\/project\.json$/i.test(value);
  const shellManifest = /(?:manifest\.json|\.loam\/packs\/[a-z0-9-]+\/project\.json)(?:$|[\s"'`;|&<>])/i.test(value);
  if (directManifest || shellManifest) throw new Error("pack manifests are tool-owned and cannot be edited directly");
}

function assertToolArgsAllowed(args: Record<string, unknown>, name: string): void {
  if (["file_write", "file_edit", "file_multi_edit", "file_move", "file_delete"].includes(name)) {
    assertPackWriteAllowed(args.path ?? args.from ?? args.to);
  }
  if (name === "shell_run" || name === "shell_start" || name === "pty_start") {
    assertPackWriteAllowed(args.command);
  }
}

export function withPackGuard(tools: ToolRegistry, packId?: PackId, timeoutMs?: number): ToolRegistry {
  const guarded = tools.cloneFiltered({});
  const timeout = timeoutMs ?? (packId ? getPackManifest(packId).gate.timeoutMs : undefined);
  for (const tool of guarded.all()) {
    const original = tool.run;
    tool.run = async (args, ctx) => {
      assertToolArgsAllowed(args, tool.name);
      if (!timeout) return original(args, ctx);
      try {
        return await withPackTimeout(original(args, ctx), timeout);
      } catch (error) {
        return packErrorResult(error);
      }
    };
  }
  return guarded;
}
