/**
 * `memory_add` — quick-add one durable project note to a rules file.
 *
 * The project-rules loader (`src/agent/projectMemory.ts`) injects LOAM.md /
 * AGENTS.md / CLAUDE.md and their `@path` imports into the system prompt and on
 * file reads. This tool is the write side: it appends a single atomic note under
 * a `## <section>` heading, creating the file and the section when they do not
 * exist yet. It never rewrites existing content and never escapes the workspace.
 */
import path from "node:path";
import { appendMemoryEntry } from "../agent/projectMemory.js";
import type { Tool, ToolResult } from "./registry.js";
import { str } from "./registry.js";

export const MEMORY_ADD_TOOL_NAME = "memory_add";

export const projectMemoryTools: Tool[] = [
  {
    name: MEMORY_ADD_TOOL_NAME,
    description:
      "Append one durable project note to a project rules file (LOAM.md by default) so it is loaded into future sessions. " +
      "Use it for build/test/lint commands, conventions, architecture decisions and other facts that must outlive this task. " +
      "Keep the note atomic and self-contained: one fact per call, phrased so it is useful out of context. " +
      "The note is filed under a `## <section>` heading (created at the end of the file when absent); prefer a meaningful section such as Build, Tests, Conventions or Decisions over the default. " +
      "When NOT to use: do not store secrets, credentials or personal data; do not dump large code, logs or file contents; do not record something already covered by the existing note in the same section; do not use it to edit or delete an existing note (use file_read then file_edit for that). " +
      "The target must stay inside the current workspace; an absolute or relative path that escapes it is rejected.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The note to remember, as one self-contained sentence or a short imperative (e.g. \"Run `npm run build:server` before e2e tests\").",
        },
        file: {
          type: "string",
          description: "Rules file to write to, relative to the workspace or absolute (default LOAM.md). AGENTS.md and CLAUDE.md are accepted compatibility names.",
        },
        section: {
          type: "string",
          description: "Heading under which to file the note (default \"Memory\"). Created when absent.",
        },
      },
      required: ["text"],
    },
    async run(args: Record<string, unknown>, ctx): Promise<ToolResult> {
      const text = str(args, "text").trim();
      if (!text) return { ok: false, content: "memory_add requires a non-empty text note" };
      const file = str(args, "file", "LOAM.md").trim() || "LOAM.md";
      const section = str(args, "section", "Memory").trim() || "Memory";
      try {
        const { file: target, entry } = appendMemoryEntry(text, ctx.workspace, file, section);
        const rel = path.relative(ctx.workspace, target) || path.basename(target);
        return {
          ok: true,
          content: `added to ${rel} under "## ${section}":\n${entry}\nThe file is loaded into the system prompt on the next session and when a file in that directory is read.`,
        };
      } catch (err) {
        return { ok: false, content: `memory_add failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
];
