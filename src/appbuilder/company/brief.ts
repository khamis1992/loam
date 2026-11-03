import fs from "node:fs";
import path from "node:path";
import type { OllamaClient } from "../../ollama.js";
import type { AppScenario } from "../types.js";
import type { ProductBrief } from "./types.js";

const SCENARIOS = new Set<AppScenario>(["web_app", "landing_page", "data_dashboard", "content_site", "game", "tool", "fullstack_app"]);

function scenarioOf(idea: string): AppScenario {
  const value = idea.toLowerCase();
  if (/game|لعبة|ألعاب/.test(value)) return "game";
  if (/fullstack|database|auth|login|متجر|حجز|قاعدة بيانات|تسجيل/.test(value)) return "fullstack_app";
  if (/dashboard|analytics|لوحة|تحليلات|بيانات/.test(value)) return "data_dashboard";
  if (/blog|news|content|مدونة|مقالات/.test(value)) return "content_site";
  if (/landing|صفحة هبوط|تعريفية|تسويق/.test(value)) return "landing_page";
  if (/tool|utility|أداة|محول|محرر/.test(value)) return "tool";
  return "web_app";
}

function lines(values: unknown[], max = 20): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text && !out.includes(text)) out.push(text.slice(0, 500));
    if (out.length >= max) break;
  }
  return out;
}

function normalize(idea: string, value: Partial<ProductBrief>): ProductBrief {
  const scenario = SCENARIOS.has(value.scenario as AppScenario) ? value.scenario as AppScenario : scenarioOf(idea);
  const requirements = lines(value.requirements?.length ? value.requirements : [idea]);
  const acceptance = lines(value.acceptance?.length ? value.acceptance : requirements.map((text) => `التحقق من: ${text}`));
  return {
    idea,
    scenario,
    features: value.features?.includes("fullstack") || scenario === "fullstack_app" ? ["fullstack"] : [],
    users: lines(value.users?.length ? value.users : ["المستخدم الأساسي"], 5),
    requirements,
    constraints: lines(value.constraints ?? [], 10),
    userStories: lines(value.userStories?.length ? value.userStories : requirements.map((text) => `بصفتي مستخدمًا، أريد ${text}`), 12),
    acceptance,
    questions: lines(value.questions ?? [], 5),
  };
}

export async function analyzeProductIdea(idea: string, ollama?: OllamaClient, model = ""): Promise<ProductBrief> {
  const text = idea.trim();
  if (text.length < 12) return normalize(text, { questions: ["صف فكرة التطبيق والمستخدم الأساسي بالتفصيل."] });
  if (ollama && model) {
    try {
      const result = await ollama.chat({
        model,
        temperature: 0.1,
        format: { type: "object" },
        messages: [
          { role: "system", content: "Convert product ideas to one JSON object. Never invent requirements. Use scenario values web_app, landing_page, data_dashboard, content_site, game, tool, fullstack_app. Fields: scenario, features, users, requirements, constraints, userStories, acceptance, questions. features may contain fullstack only. questions only for essential ambiguity." },
          { role: "user", content: text },
        ],
      });
      return normalize(text, JSON.parse(result.content) as Partial<ProductBrief>);
    } catch {
      // Local analysis remains available when the model is absent or returns invalid JSON.
    }
  }
  const generic = /^(build|create|make|بناء|إنشاء|اصنع|طور)\s*(a|an|app|application|تطبيق|برنامج)?\s*$/i.test(text) || text.length < 30;
  return normalize(text, { questions: generic ? ["ما نوع التطبيق والمستخدم الأساسي؟"] : [] });
}

export function writeProductDocuments(workspace: string, brief: ProductBrief): void {
  const spec = [
    `# Product specification`, "", brief.idea, "",
    `Scenario: ${brief.scenario}`, "",
    "## Users", ...brief.users.map((x) => `- ${x}`), "",
    "## Requirements", ...brief.requirements.map((x) => `- ${x}`), "",
    "## User stories", ...brief.userStories.map((x) => `- ${x}`), "",
    "## Acceptance criteria", ...brief.acceptance.map((x) => `- ${x}`), "",
    "## Constraints", ...brief.constraints.map((x) => `- ${x}`),
  ].join("\n");
  const design = [
    "# Design", "",
    "## Direction & Layout",
    `The home screen prioritizes the primary workflow for ${brief.scenario}. Arabic is RTL and English is LTR; mobile remains usable at 375px.`,
    "",
    "## Tokens",
    "- Primary: oklch(0.52 0.16 255)",
    "- Background: oklch(0.98 0.01 95)",
    "- Body: 16px; spacing: 8px; radius: 12px",
    "Theme: Neutral",
    "",
    "## Patterns & States",
    "- Loading, empty, error, success, disabled, focus-visible",
    "",
    "## Media",
    "- 375px: single column",
    "- 768px: two columns where useful",
    "- 1440px: bounded content width",
  ].join("\n");
  const architecture = [
    "# Architecture", "",
    `Application type: ${brief.scenario}`, "",
    "## Boundaries",
    "- UI and interaction in app/src",
    brief.features.includes("fullstack") ? "- API and persistence in app/server and app/data" : "- Static application state in the client",
    "- Verification artifacts in .loam/verify",
    "",
    "## Quality gates",
    ...brief.acceptance.map((x) => `- ${x}`),
    "- lint, typecheck, production build, mobile and desktop visual review",
    "",
    "## Security and privacy",
    "- No secrets in source or browser storage",
    "- Validate all external input and keep server state per project",
    "- No external deployment without explicit approval",
  ].join("\n");
  fs.writeFileSync(path.join(workspace, "SPEC.md"), spec, "utf8");
  fs.writeFileSync(path.join(workspace, "DESIGN.md"), design, "utf8");
  fs.writeFileSync(path.join(workspace, "ARCHITECTURE.md"), architecture, "utf8");
}

export function buildPrompt(brief: ProductBrief): string {
  return [
    "Implement the approved product inside app/. Do not modify files outside app/. Follow SPEC.md, DESIGN.md and ARCHITECTURE.md exactly.",
    "Use the existing project toolchain. Implement real behavior, validation, loading/empty/error states and tests for the primary workflow. Do not leave placeholders or describe work without doing it.",
    "Run relevant checks before finishing. The acceptance criteria are:",
    ...brief.acceptance.map((x) => `- ${x}`),
  ].join("\n");
}
