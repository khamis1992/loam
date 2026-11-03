import fs from "node:fs";
import path from "node:path";

/** Tool output longer than this leaves the prompt and stays on disk.
 *  Matches the master-prompt spill_threshold placeholder. */
export const SPILL_CHARS = 80_000;
const EXCERPT_CHARS = 2_000;

/** Keep a short excerpt in the prompt and write the full tool output beside the workspace. */
export function spillToolOutput(workspace: string, name: string, content: string, taskId?: string): string {
  if (content.length <= SPILL_CHARS) return content;
  const excerpt = content.slice(0, EXCERPT_CHARS);
  try {
    const dir = path.join(workspace, ".loam", "spills");
    fs.mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 40) || "tool";
    const prefix = taskId ? `${taskId.replace(/[^\w.-]+/g, "_")}-` : "";
    const file = path.join(dir, `${prefix}${safe}-${Date.now()}.txt`);
    fs.writeFileSync(file, content, "utf8");
    return `${excerpt}\n\n[Full tool output (${content.length} characters) saved at ${file}. Read that file for the rest.]`;
  } catch {
    return `${excerpt}\n\n[Tool output truncated at ${EXCERPT_CHARS} characters.]`;
  }
}
