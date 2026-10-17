import type { Episodes } from "./episodes.js";
import { toEpisodeInput } from "./episodes.js";
import type { Facts } from "./facts.js";
import { toFactInput } from "./facts.js";
import { buildRecall } from "./recall.js";
import type { Skills } from "./skills.js";
import { clamp, num, str, stringArray } from "./util.js";

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<ToolOutcome>;
}

export interface Stores {
  episodes: Episodes;
  facts: Facts;
  skills: Skills;
}

const outcomeSchema = { type: "string", enum: ["success", "partial", "failed"] };
const reportOutcomeSchema = { type: "string", enum: ["success", "failure", "partial"] };

export function createTools(stores: Stores): ToolDef[] {
  const { episodes, facts, skills } = stores;

  return [
    {
      name: "recall",
      description:
        "One-shot recall before starting a task: returns the most relevant past episodes, durable facts and reusable skills for a goal. Call this first and use what it returns.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What you are about to do (the task prompt or a short goal)." },
          k: { type: "number", description: "Max items per section (default 3)." },
        },
        required: ["goal"],
      },
      async handler(args) {
        const goal = str(args, "goal").trim();
        if (!goal) return { text: "recall requires a goal", isError: true };
        const text = await buildRecall(episodes, facts, skills, goal, num(args, "k", 3));
        return { text };
      },
    },
    {
      name: "episode_record",
      description:
        "Record one finished task as an episodic memory (goal, outcome, summary, lessons, tools, artifacts). Call it when a task ends so the system stops forgetting — future runs recall it via recall/episode_search.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What the task was trying to achieve." },
          outcome: outcomeSchema,
          summary: { type: "string", description: "What actually happened and what the result was (2-4 sentences)." },
          lessons: { type: "array", items: { type: "string" }, description: "Durable lessons worth reusing (pitfalls, fixes, tricks)." },
          tools: { type: "array", items: { type: "string" }, description: "Main tools used, e.g. browser_act, shell." },
          artifacts: { type: "array", items: { type: "string" }, description: "Files/URLs produced or changed." },
          tags: { type: "array", items: { type: "string" } },
          project: { type: "string", description: "Optional project name." },
          task_id: { type: "string", description: "Optional id tying back to the task store." },
          duration_ms: { type: "number" },
        },
        required: ["goal", "outcome", "summary"],
      },
      async handler(args) {
        const input = toEpisodeInput(args);
        const res = await episodes.record(input);
        if (res.deduped) return { text: `episode already recorded for this task (${res.id}); duplicate ignored` };
        return { text: `recorded episode ${res.id} (${input.outcome}) at ${res.createdAt}` };
      },
    },
    {
      name: "episode_search",
      description:
        "Full-text + optional semantic search over past task episodes (what was done, how it ended, what was learned). Use before re-solving a problem you may have handled before.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords (empty = most recent episodes)." },
          k: { type: "number", description: "Max results (default 5)." },
          outcome: outcomeSchema,
          tag: { type: "string" },
          since: { type: "string", description: "ISO date lower bound, e.g. 2026-10-01." },
        },
      },
      async handler(args) {
        const hits = await episodes.search(str(args, "query"), {
          k: num(args, "k", 5),
          ...(typeof args["outcome"] === "string" ? { outcome: args["outcome"] } : {}),
          ...(typeof args["tag"] === "string" ? { tag: args["tag"] } : {}),
          ...(typeof args["since"] === "string" ? { since: args["since"] } : {}),
        });
        if (hits.length === 0) return { text: "(no matching episodes)" };
        return {
          text: hits
            .map((h) => {
              const e = h.episode;
              return `[${e.createdAt.slice(0, 10)} · ${e.outcome} · ${h.score.toFixed(2)}] ${e.goal} — ${e.summary} (${e.id})`;
            })
            .join("\n"),
        };
      },
    },
    {
      name: "episode_get",
      description: "Read one full episode by id (as returned by episode_search / recall).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async handler(args) {
        const ep = episodes.get(str(args, "id"));
        if (!ep) return { text: `episode not found: ${str(args, "id")}`, isError: true };
        return { text: JSON.stringify(ep, null, 2) };
      },
    },
    {
      name: "episode_stats",
      description: "Overview of episodic memory: totals, outcomes, recent activity, top tags and tools.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        const s = episodes.stats();
        const lines = [
          `episodes: ${s.total} total, ${s.last7d} in the last 7 days`,
          `outcomes: ${Object.entries(s.byOutcome).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
          `top tags: ${s.topTags.map((t) => `${t.tag}(${t.count})`).join(", ") || "(none)"}`,
          `top tools: ${s.topTools.map((t) => `${t.tool}(${t.count})`).join(", ") || "(none)"}`,
          s.latest ? `latest: ${s.latest.createdAt.slice(0, 16)} — ${s.latest.goal} (${s.latest.id})` : "latest: (none)",
        ];
        return { text: lines.join("\n") };
      },
    },
    {
      name: "fact_remember",
      description:
        "Store a durable fact/preference about the user, machine, project or workflow (semantic memory). Near-duplicates are merged automatically; pass a stable `key` to make it a true upsert.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Self-contained fact, one or two sentences." },
          kind: { type: "string", description: "Category, e.g. fact, preference, decision, env." },
          tags: { type: "array", items: { type: "string" } },
          key: { type: "string", description: "Optional stable key (e.g. 'editor.default') for upserts." },
        },
        required: ["text"],
      },
      async handler(args) {
        const res = await facts.remember(toFactInput(args));
        const note = res.action === "merged" ? " (merged with a near-duplicate)" : res.action === "updated" ? " (replaced existing entry)" : "";
        return { text: `stored fact ${res.id}${note}` };
      },
    },
    {
      name: "fact_search",
      description: "Search durable facts/preferences (semantic memory). Empty query lists the most recent.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, k: { type: "number", description: "Max results (default 5)." } },
      },
      async handler(args) {
        const hits = await facts.search(str(args, "query"), { k: num(args, "k", 5) });
        if (hits.length === 0) return { text: "(no matching facts)" };
        return { text: hits.map((h) => `(${h.score.toFixed(2)}) [${h.fact.kind}] ${h.fact.text} (${h.fact.id})`).join("\n") };
      },
    },
    {
      name: "fact_forget",
      description: "Delete facts by id, key or exact text.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" }, text: { type: "string" } } },
      async handler(args) {
        const removed = facts.forget({
          ...(typeof args["id"] === "string" ? { id: args["id"] } : {}),
          ...(typeof args["key"] === "string" ? { key: args["key"] } : {}),
          ...(typeof args["text"] === "string" ? { text: args["text"] } : {}),
        });
        return { text: `forgot ${removed} fact(s)` };
      },
    },
    {
      name: "skill_record",
      description:
        "Create or revise a skill (procedural memory): a reusable multi-step procedure as skills/<slug>/SKILL.md, with 'When to Use / Procedure / Pitfalls / Verification' sections. Revising keeps the old revision under history/.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short kebab-case name." },
          description: { type: "string", description: "One line: WHEN to use this skill." },
          body: { type: "string", description: "Markdown body with numbered Procedure steps." },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["name", "description", "body"],
      },
      async handler(args) {
        const res = await skills.record({
          name: str(args, "name"),
          description: str(args, "description"),
          body: str(args, "body"),
          tags: stringArray(args["tags"]),
          source: "agent",
        });
        return { text: `${res.action} skill "${res.slug}" v${res.version} → ${res.path}${res.action === "updated" ? " (previous revision kept in history/)" : ""}` };
      },
    },
    {
      name: "skill_search",
      description:
        "Retrieve the most relevant skills for a task (ranked by match quality × past success rate). Call it before inventing a procedure; then load the winner with skill_get.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, k: { type: "number", description: "Max results (default 5)." } },
        required: ["query"],
      },
      async handler(args) {
        const hits = await skills.search(str(args, "query"), { k: num(args, "k", 5) });
        if (hits.length === 0) return { text: "(no matching skills — record one with skill_record after this task if you work out a reusable procedure)" };
        return {
          text: hits
            .map((h) => {
              const rate = h.stats.uses > 0 ? `${Math.round(h.stats.successRate * 100)}% over ${h.stats.uses}` : "untried";
              return `- ${h.slug} [v${h.version} · ${rate} · ${h.score.toFixed(2)}]: ${h.description || "(no description)"}`;
            })
            .join("\n"),
        };
      },
    },
    {
      name: "skill_get",
      description: "Load one skill: full SKILL.md, version, usage stats, pending outcome notes and revision history.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async handler(args) {
        const detail = await skills.get(str(args, "name"));
        if (!detail) return { text: `skill not found: ${str(args, "name")}`, isError: true };
        const header = [
          `# ${detail.name} (${detail.slug}) v${detail.version}`,
          `path: ${detail.path}`,
          `uses=${detail.stats.uses} success=${detail.stats.successes} failure=${detail.stats.failures} partial=${detail.stats.partials} (${Math.round(detail.stats.successRate * 100)}%)`,
          `last used: ${detail.lastUsed ?? "never"} · updated: ${detail.updatedAt} · source: ${detail.source}`,
          detail.pendingNotes.length > 0 ? `pending notes (${detail.pendingNotes.length}): ${detail.pendingNotes.map((n) => n.note).join(" | ")}` : "",
          detail.history.length > 0 ? `history: ${detail.history.join(", ")}` : "",
        ].filter((l) => l.length > 0);
        return { text: `${header.join("\n")}\n\n---\n${detail.content}` };
      },
    },
    {
      name: "skill_report",
      description:
        "Report the outcome of using a skill (success/failure/partial) so its track record stays truthful and self-improvement can kick in. Add notes whenever something went wrong.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          outcome: reportOutcomeSchema,
          notes: { type: "string", description: "What went wrong / what you had to fix (kept for skill_improve)." },
          duration_ms: { type: "number" },
        },
        required: ["name", "outcome"],
      },
      async handler(args) {
        const outcome = str(args, "outcome") as "success" | "failure" | "partial";
        if (!["success", "failure", "partial"].includes(outcome)) return { text: "outcome must be success, failure or partial", isError: true };
        const res = await skills.report(str(args, "name"), outcome, typeof args["notes"] === "string" ? args["notes"] : undefined, num(args, "duration_ms", 0));
        return { text: `reported ${outcome} for "${res.name}": uses=${res.stats.uses} successRate=${Math.round(res.stats.successRate * 100)}% — ${res.hint}` };
      },
    },
    {
      name: "skill_improve",
      description:
        "Self-improvement pass: fold pending outcome notes (and optional new lessons) into the skill's 'Lessons & Fixes' section, bump the version and keep the old revision under history/.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          lessons: { type: "array", items: { type: "string" }, description: "Extra one-line lessons to merge (optional)." },
        },
        required: ["name"],
      },
      async handler(args) {
        const res = await skills.improve(str(args, "name"), stringArray(args["lessons"]));
        const added = res.added.length > 0 ? `\nadded:\n${res.added.map((a) => `- ${a}`).join("\n")}` : "";
        return { text: `${res.message} (${res.slug} v${res.version}, consumed ${res.consumedNotes} note(s))${added}` };
      },
    },
    {
      name: "skill_review",
      description:
        "List skills that need attention: unreviewed failure notes, low success rates, never-used or stale skills. Run it periodically and act on the reasons returned.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      async handler(args) {
        const items = await skills.review({ limit: num(args, "limit", 20) });
        if (items.length === 0) return { text: "all skills are healthy (no pending notes, no low success rates)" };
        return {
          text: items
            .map(
              (i) =>
                `- ${i.slug} [priority ${i.priority} · uses=${i.uses} success=${i.successes} fail=${i.failures}]: ${i.reasons.join("; ")}`,
            )
            .join("\n"),
        };
      },
    },
    {
      name: "skill_compose",
      description:
        "Compose skills into one ordered plan: selects the best-matching skills for a goal (or the ones you name), merges their Procedure steps (deduped, each annotated with its source skill) and flags missing tools.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string" },
          skills: { type: "array", items: { type: "string" }, description: "Explicit skill names/slugs (optional; default = best matches)." },
          k: { type: "number", description: "How many skills to use when none are named (default 3)." },
          available_tools: { type: "array", items: { type: "string" }, description: "Current tool names to validate mentions against (optional)." },
        },
        required: ["goal"],
      },
      async handler(args) {
        const res = await skills.compose(str(args, "goal"), {
          ...(Array.isArray(args["skills"]) ? { skills: stringArray(args["skills"]) } : {}),
          k: num(args, "k", 3),
          ...(Array.isArray(args["available_tools"]) ? { availableTools: stringArray(args["available_tools"]) } : {}),
        });
        return { text: res.plan };
      },
    },
    {
      name: "skill_from_trace",
      description:
        "Turn a recorded browser session into a draft skill: pass trace_path (a .browser-recordings/<name>.json action trace) or inline steps. The draft is created with the usual revision history — review it before relying on it.",
      inputSchema: {
        type: "object",
        properties: {
          trace_path: { type: "string", description: "Path to the trace JSON (absolute, or relative to the workspace / .browser-recordings)." },
          steps: { type: "array", items: { type: "string" }, description: "Alternative: inline ordered steps." },
          name: { type: "string", description: "Skill name (default: the recording's name)." },
          description: { type: "string", description: "One line: when to use it." },
        },
      },
      async handler(args) {
        const res = await skills.fromTrace({
          ...(typeof args["trace_path"] === "string" ? { tracePath: args["trace_path"] } : {}),
          ...(Array.isArray(args["steps"]) ? { steps: stringArray(args["steps"], 100) } : {}),
          ...(typeof args["name"] === "string" ? { name: args["name"] } : {}),
          ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
        });
        return {
          text: `${res.action} draft skill "${res.slug}" v${res.version} (${res.capturedSteps} steps) → ${res.path}\nReview it (skill_get) and refine wording before relying on it.\n\npreview:\n${res.draftPreview}`,
        };
      },
    },
    {
      name: "dashboard",
      description:
        "Machine-readable snapshot for UIs and reports (JSON text): episode stats, recent episodes, recent facts, skills with track records, and the review queue (what needs attention).",
      inputSchema: {
        type: "object",
        properties: {
          episodes: { type: "number", description: "Recent episodes to include (default 10)." },
          facts: { type: "number", description: "Recent facts to include (default 10)." },
          skills: { type: "number", description: "Skills to include (default 20)." },
        },
      },
      async handler(args) {
        const epLimit = clamp(Math.round(num(args, "episodes", 10)), 1, 50);
        const faLimit = clamp(Math.round(num(args, "facts", 10)), 1, 50);
        const skLimit = clamp(Math.round(num(args, "skills", 20)), 1, 100);
        const [stats, epHits, faHits, skHits, review] = await Promise.all([
          Promise.resolve(episodes.stats()),
          episodes.search("", { k: epLimit }),
          facts.search("", { k: faLimit }),
          skills.search("", { k: skLimit }),
          skills.review({ limit: 20 }),
        ]);
        const payload = {
          generatedAt: new Date().toISOString(),
          stats,
          episodes: epHits.map((h) => ({
            id: h.episode.id,
            createdAt: h.episode.createdAt,
            outcome: h.episode.outcome,
            goal: h.episode.goal,
            summary: h.episode.summary,
            lessons: h.episode.lessons,
            tools: h.episode.tools,
            tags: h.episode.tags,
          })),
          facts: faHits.map((h) => ({
            id: h.fact.id,
            kind: h.fact.kind,
            text: h.fact.text,
            tags: h.fact.tags,
            updatedAt: h.fact.updatedAt,
          })),
          skills: skHits.map((h) => ({
            slug: h.slug,
            name: h.name,
            description: h.description,
            version: h.version,
            uses: h.stats.uses,
            successes: h.stats.successes,
            failures: h.stats.failures,
            partials: h.stats.partials,
            successRate: h.stats.successRate,
            lastUsed: h.lastUsed,
            updatedAt: h.updatedAt,
            tags: h.tags,
          })),
          review,
        };
        return { text: JSON.stringify(payload, null, 1) };
      },
    },
  ];
}
