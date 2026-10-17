import { listTasks } from "../server/db.js";
import type { Task, TaskMessage } from "../server/db.js";
import type { Tool, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

function snippet(s: string, n = 400): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** session_search = recall from the agent's own past tasks (stored in SQLite). */
export const sessionTools: Tool[] = [
  {
    name: "session_search",
    description:
      "Search your own past tasks (prompts, answers, steps) stored locally. Use it to recall what you did or decided in earlier tasks — full-text search, no summarization.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for (case-insensitive). Empty lists the most recent tasks." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const query = str(args, "query").trim().toLowerCase();
      const limit = Math.min(Math.max(num(args, "limit", 5), 1), 20);
      const hits: Array<{ task: Task; answer?: TaskMessage }> = [];
      for (const task of listTasks()) {
        if (query) {
          const hay = [task.prompt, ...task.messages.map((m) => m.content)].join("\n").toLowerCase();
          if (!hay.includes(query)) continue;
        }
        const answer = [...task.messages].reverse().find((m) => m.role === "assistant");
        hits.push({ task, answer });
        if (hits.length >= limit) break;
      }
      if (hits.length === 0) {
        return { ok: true, content: query ? `(no past tasks matching "${query}")` : "(no past tasks)" };
      }
      const text = hits
        .map(({ task, answer }) => {
          const head = `[${task.status}] ${task.id} — ${task.title}`;
          const ans = answer ? `\n   A: ${snippet(answer.content)}` : "";
          return `${head}\n   Q: ${snippet(task.prompt)}${ans}`;
        })
        .join("\n");
      return { ok: true, content: text };
    },
  },
];
