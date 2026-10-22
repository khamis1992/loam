import "./mute.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Curator, DEFAULT_CURATOR_CONFIG, type CuratorConfig } from "./curator.js";
import { openDatabase } from "./db.js";
import { Embedder } from "./embed.js";
import { Episodes } from "./episodes.js";
import { Facts } from "./facts.js";
import { SessionSearch } from "./session_search.js";
import { Skills } from "./skills.js";
import { createTools } from "./tools.js";
import { envValue, resolvePaths } from "./util.js";

const INSTRUCTIONS = [
  "Persistent memory + self-improving skill library for long-running agents. The server keeps:",
  "- episodic memory: one record per finished task (goal / outcome / summary / lessons),",
  "- semantic memory: durable facts and preferences,",
  "- procedural memory: skills as SKILL.md files with usage stats and revision history.",
  "",
  "Protocol:",
  "1. Before a task: call `recall` with the goal; use what it returns.",
  "2. After a task: call `episode_record` (goal, outcome, summary, lessons, tools).",
  "3. Durable facts -> `fact_remember`; look them up with `fact_search`.",
  "4. Reusable procedures -> `skill_record`; find existing ones with `skill_search` (before writing a new one).",
  "5. After using a skill: `skill_report` with success/failure/partial and notes.",
  "6. After a failure: `skill_improve` to fold the notes back into the skill; `skill_review` lists what needs attention.",
  "7. To plan a multi-step job from known procedures: `skill_compose`; to convert a recorded browser session into a draft skill: `skill_from_trace`.",
  "8. For a UI/report snapshot (stats, recent episodes, facts, skills, review queue): `dashboard`.",
  "9. To find how a similar past task was handled (goals, summaries, tool traces): `session_search`.",
].join("\n");

function intEnv(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Scheduled-job skill slugs can be declared by the host (comma-separated). */
function scheduledSlugsFromEnv(): Set<string> {
  const raw = envValue("MEMSKILLS_SCHEDULED_SKILLS");
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

function curatorConfigFromEnv(): CuratorConfig {
  return {
    ...DEFAULT_CURATOR_CONFIG,
    staleDays: intEnv("MEMSKILLS_CURATOR_STALE_DAYS", DEFAULT_CURATOR_CONFIG.staleDays),
    archivedDays: intEnv("MEMSKILLS_CURATOR_ARCHIVED_DAYS", DEFAULT_CURATOR_CONFIG.archivedDays),
    inactivityIdleHours: intEnv("MEMSKILLS_CURATOR_IDLE_HOURS", DEFAULT_CURATOR_CONFIG.inactivityIdleHours),
    inactivityLastRunDays: intEnv("MEMSKILLS_CURATOR_LAST_RUN_DAYS", DEFAULT_CURATOR_CONFIG.inactivityLastRunDays),
    minToolCallsForProposal: intEnv("MEMSKILLS_MIN_TOOL_CALLS", DEFAULT_CURATOR_CONFIG.minToolCallsForProposal),
    consolidate: envValue("MEMSKILLS_CURATOR_CONSOLIDATE") === "1",
  };
}

async function main(): Promise<void> {
  const paths = resolvePaths();
  const db = openDatabase(paths.dbFile);
  const embedder = new Embedder();
  const episodes = new Episodes(db, embedder);
  const facts = new Facts(db, embedder);
  const skills = new Skills(db, embedder, paths.skillsDir);
  const tools = createTools({ episodes, facts, skills, db });

  const curator = new Curator(db, curatorConfigFromEnv(), {
    skills,
    exemptScheduledSlugs: scheduledSlugsFromEnv,
  });

  try {
    const res = await skills.sync(true);
    if (envValue("MEMSKILLS_DEBUG") === "1") {
      console.error(`[memory-skills] synced skills dir (${res.indexed} indexed, ${res.removed} removed)`);
    }
  } catch (err) {
    console.error(`[memory-skills] initial skills sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Keep the optional trigram index warm for substring (Arabic/CJK) search.
  try {
    new SessionSearch(db).syncIndexIfStale();
  } catch {
    /* trigram is best-effort */
  }

  // Inactivity-driven curator: only acts when the system has been quiet.
  try {
    const { ran, result } = await curator.maybeRun();
    if (ran && envValue("MEMSKILLS_DEBUG") === "1") {
      console.error(`[memory-skills] curator ran (${result?.updated ?? 0} updated, ${result?.skipped ?? 0} skipped)`);
    }
  } catch (err) {
    console.error(`[memory-skills] curator run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const server = new Server(
    { name: "memory-skills", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `unknown tool: ${request.params.name}` }], isError: true };
    }
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const outcome = await tool.handler(args);
      return {
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.isError ? { isError: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `${tool.name} failed: ${message}` }], isError: true };
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  };
  process.on("SIGINT", () => {
    closeDb();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeDb();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (envValue("MEMSKILLS_DEBUG") === "1") {
    console.error(
      `[memory-skills] ready: db=${paths.dbFile} skills=${paths.skillsDir} embeddings=${embedder.configured ? "on" : "off"} tools=${tools.length}`,
    );
  }
}

main().catch((err) => {
  console.error(`[memory-skills] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
