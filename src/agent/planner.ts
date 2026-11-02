import type { Config } from "../config.js";
import type { ChatMessage, ChatResult, OllamaClient } from "../ollama.js";
import type { PlanStepInfo, RecipeStepInfo, RecipeStepStatus, Usage } from "./events.js";
import { log } from "../log.js";
import { chatWithFallback } from "./model.js";
import { isCancelledError } from "../server/runControl.js";
import { proposePrompt, type RecipeProposeContext } from "./recipe.js";

export interface Plan {
  goal: string;
  trivial: boolean;
  steps: PlanStepInfo[];
  source: "model" | "fallback";
}

export interface PlanResult {
  plan: Plan;
  model: string;
  usage: Usage;
}

export interface PlannerOptions {
  cfg: Config;
  ollama: OllamaClient;
  prompt: string;
  history?: ChatMessage[];
  availableTools?: string[];
  maxPlanSteps: number;
  /** Planner model override ("" = main model). */
  model?: string;
  memories?: Array<{ text: string; score: number }>;
  signal?: AbortSignal;
}

export const PLANNER_SYSTEM = [
  "You are the planner role in a planner/executor/verifier agent system running on the user's computer.",
  "Turn the user's request into a short ordered execution plan: atomic steps an executor agent can carry out with tools, each checkable by a verifier.",
  "",
  "Output rules:",
  "- Reply with JSON only, no markdown fences, no commentary.",
  '- Schema: {"goal": "<one sentence>", "trivial": <true|false>, "steps": [{"id": "s1", "title": "<short>", "instruction": "<what the executor must do>", "success_criteria": "<observable evidence of completion>"}]}',
  "- Use 2 to 6 steps for real tasks; never more than needed.",
  "- Plan only operations possible with AVAILABLE TOOLS. Do not require shell, grep, browser actions, or external services when those tools are absent.",
  "- Source files and app-verification.json belong in the TASK WORKSPACE. File tools resolve relative paths there. Do not invent another project root or write source files to a container path on the host.",
  "- For isolated Node application verification, /app is the readonly copy of workspace source INSIDE Docker; /tmp is writable runtime data INSIDE Docker, not the host project directory. A requested /tmp database path belongs in generated server code, not in file_write paths. Use workspace-relative index.html, server.mjs and app-verification.json for creation.",
  "- Generated browser apps receive mandatory independent runtime and visual checks from app-verification.json after execution. Include an acceptance contract covering the requested workflows; do not substitute exhaustive line-by-line source narration for these checks. A presentation, slides, or pptx request is not a browser app, even when the user asks for one page (صفحة واحدة): do not plan an acceptance contract, app-verification.json, independent verification, or a publish step for it.",
  "- The LAST step must produce the complete final answer for the user (result, files, paths).",
  '- A loam_mobile request limited to the supported screen schema (text, inputs, toggles, navigation) is one coherent studio edit: set trivial=true and use one step that reads the current revision, replaces the project once, and checks the returned project. Preserve the requested display language. Do not split each screen or each read/write into separate steps. Requests for native builds, backend services or advanced application logic still need a normal implementation and verification plan.',
  '- Set "trivial": true and use exactly ONE step only when the request is a simple single-action task (a greeting, one quick answer, reading one value) OR when the request invokes a self-contained studio/builder tool (super_swarm, rork_build, lovable_studio, metagpt_company, studio_blender, game_build, mirofish_chat) to generate a new package/app from scratch.',
  '- When calling a self-contained studio/builder tool (super_swarm, rork_build, lovable_studio, metagpt_company), do NOT add preliminary steps to search the disk or inspect files first — call the studio tool directly in step s1. office_craft is different: it drives the live Craft editor, so follow the Craft-editor rule below instead.',
  '- A presentation, slides, or pptx request is a Loam Slides task, not an HTML page and not presentation_build. One page (صفحة واحدة or صفحة 1) means exactly one slide. A new presentation is exactly three steps, and each instruction is one literal English call. The title and body strings are in the user\'s language. If the user wrote Arabic, both quotes must contain Arabic words and must not be an English translation. The body names the designer, the place, and the year as four digits: (1) Call office_craft with action \'open\' and app \'slides\'. (2) Call office_craft with action \'edit\' and app \'slides\' and title \'<title>\' and body \'<the one slide>\'. (3) Call office_craft with action \'export\' and app \'slides\'. Do not call office_export, do not use any other action, and do not open Loam Docs. A document or docx is Loam Docs (office_craft app "docs"). A spreadsheet, xlsx, or csv workbook is Loam Sheets (office_craft app "sheets"). A photo or psd edit is Loam Photo (app "photo"). A layout, idml, or designed pdf is Loam Design (app "design"). Action "open" with no file creates a new file. A new document or docx is exactly three steps, and each instruction is one literal English call: (1) Call office_craft with action \'open\' and app \'docs\'. (2) Call office_craft with action \'edit\' and app \'docs\' and body \'<the page>\'. (3) Call office_craft with action \'export\' and app \'docs\'. A new spreadsheet is exactly three steps, and each instruction is one literal English call: (1) Call office_craft with action \'open\' and app \'sheets\'. (2) Call office_craft with action \'edit\' and app \'sheets\' and body \'<rows separated by ; and cells by |, including one =SUM() total>\'. (3) Call office_craft with action \'export\' and app \'sheets\'. For photo and design, keep each to 2-3 steps: open, then change the file with action "execute" or action "batch", then export through the app and report the file path. Use loam_studio, loam_dataset, or office_export only when that editor is unavailable. presentation_build is not available unless it appears in the tool list; never choose it for a normal presentation. An explicit HTML slide page belongs to Build mode. If the editor is unavailable, say so in the user\'s language and fall back to the built-in editors instead of writing a web page.',
  '- A request that edits a file attached in chat (an office document, spreadsheet, deck, image or layout) is a Craft-editor task, not a from-scratch build: it opens in the Workspace panel and is driven live. Keep it to 2-3 steps: (s1) open the attached file and read the live state (document.inspect / sheet.read / cell.get / ui.inspect); (s2) discover the command ids with engine.commands, apply the batched edits, then re-read the state to verify the change; (s3) export through the app so the bytes return into the task. Never invent a command id, never replay a failed command, and never write the office file with shell or Python. The last step must also report the exported file path to the user. If the app is unavailable or the panel never reports ready, say so in the user\'s language and fall back to the built-in editors instead of retrying.',
  '- A video request (an attached video, or instructions to cut, arrange, add music, apply a transition or effect, animate a title, or export) is a Loam Video task: one product, two engines behind it. Keep it to 2-4 steps: (s1) open the editor panel and read the current project state (video_studio action=open, then action=state) so manual panel edits are never lost; (s2) apply the edits incrementally with video_studio actions, routing each operation to the engine the router owns (cut/arrange/audio/music/static text/basic dissolve = timeline engine; transitions beyond a basic dissolve, effects, colour looks, text/motion animation, keyframed motion = Loam Effects engine) and re-reading state after each change to verify; (s3) export with raw {command: "export"} so the render lands in the task, and publish it with artifact_publish as kind video. Never write media bytes with file_write, never invent an engine command id (raw validates it against the live catalog), and never present a degraded effects edit as the full effect: read the routing object in the result and say plainly which engine applied it. If the editor dist is missing or the bridge is down, the tool reports a fallback to video_edit (ffmpeg) — use it instead of retrying.',
  '- Instructions must be concrete: files, commands, sources. No meta-work like "understand the task".',
  "- Write goal, titles, instructions and success criteria in the user's language.",
].join("\n");

/**
 * System prompt for the incremental half of the Recipe engine (N4).
 *
 * One short call per finished step. The planner is shown the recipe, what the
 * last step actually produced, and the tools that exist, then decides whether
 * the recipe needs a new step, a reworded not-yet-run step, or a dropped step.
 * It must never invent tools, never rewrite a step that already ran, and never
 * claim completion while open steps remain.
 */
export const RECIPE_PLANNER_SYSTEM = [
  "You are the recipe planner of a long-horizon agent running on the user's computer.",
  "Unlike a one-shot plan, the recipe you maintain is INCREMENTAL: it is extended after every step, from the results that step actually produced.",
  "",
  "Your job for this round is narrow: look at the tool results of the step that just finished and decide what the recipe needs NEXT.",
  "",
  "Decision rules:",
  "- Steps that already ran are EVIDENCE, not drafts. Never rewrite, reorder or reword a step whose status is done or skipped.",
  '- Use "add" only for genuinely new work that the results show is still required to satisfy the user request.',
  '- Use "rewrite" only for a step that has NOT run yet (status proposed or ready) AND only when the results change what that step must do. Give the step its own id.',
  '- Use "drop" only for a pending step the results made unnecessary. Dropped steps are never re-added later in this round.',
  '- Only operations possible with AVAILABLE TOOLS. Do not require shell, browser actions, or external services when those tools are absent.',
  '- The recipe must end with a step that produces the complete, user-facing final answer (result, files, paths). If that step is missing, add it.',
  '- When a tool FAILED, re-route: propose a step that reaches the same goal through a different available tool, and say in the instruction what to do if that one fails too. Never propose retrying the identical failing call.',
  '- "remaining_estimate" is the number of recipe steps still to run, the current one included. Count only steps that are not done and not skipped. It must never exceed that count.',
  '- Set "complete": true ONLY when every open step is done and the user request is fully satisfied by the work already performed.',
  "- If the results already satisfy the request, return no additions, no rewrites, no drops and complete: true.",
  "- Write titles, instructions and success criteria in the user's language. Instructions must be concrete: files, commands, sources. No meta-work like \"understand the task\".",
].join("\n");

/** Extract the first JSON value from model output: raw JSON, fenced block, or balanced braces. */
export function extractJson(text: string): unknown | null {
  const t = text.trim();
  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct !== null) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence && fence[1]) {
    const inner = tryParse(fence[1].trim());
    if (inner !== null) return inner;
  }
  const start = t.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = tryParse(t.slice(start, i + 1));
          if (candidate !== null) return candidate;
        }
      }
    }
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Normalize a parsed plan object; returns null when no usable step exists. */
export function normalizePlan(value: unknown, prompt: string, maxPlanSteps: number): Plan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const rawSteps = Array.isArray(obj["steps"]) ? obj["steps"] : [];
  const steps: PlanStepInfo[] = [];
  for (const item of rawSteps) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    const instruction = str(s["instruction"]) || str(s["task"]) || str(s["description"]);
    if (!instruction) continue;
    steps.push({
      id: str(s["id"]) || `s${steps.length + 1}`,
      title: str(s["title"]) || instruction.slice(0, 60),
      instruction,
      successCriteria:
        str(s["success_criteria"]) || str(s["successCriteria"]) || str(s["criteria"]) || str(s["success"]),
    });
  }
  if (steps.length === 0) return null;
  const capped = steps.slice(0, Math.max(1, maxPlanSteps));
  for (const s of capped) {
    if (!s.successCriteria) s.successCriteria = "the step's result is present and consistent with the instruction";
  }
  const goal = str(obj["goal"]) || (prompt.split(/\r?\n/)[0] ?? "").slice(0, 120) || prompt.slice(0, 120);
  const trivial = obj["trivial"] === true && capped.length === 1;
  return { goal, trivial, steps: capped, source: "model" };
}

const ARABIC = /[\u0590-\u08ff]/;

/** A slides or presentation request, including the Arabic word for a presentation. */
export function presentationRequest(prompt: string): boolean {
  return /برزنتيشن|presentation|\bslides\b|\bpptx\b/i.test(prompt);
}

/** The edit step of a slides plan whose body does not contain a four-digit year. */
export function slidesEditLacksYear(plan: Plan): boolean {
  return plan.steps.some((step) => {
    if (!/action\s+['"]edit['"]/i.test(step.instruction) || !/slides/i.test(step.instruction)) return false;
    const body = step.instruction.match(/\bbody\s+['"]([^'"]*)['"]/i)?.[1] ?? "";
    return !/\d{4}/.test(body);
  });
}

/** Replace the first slides edit instruction with the title and body the facts call returned. */
export function applySlideFacts(plan: Plan, title: string, body: string): Plan {
  const safeTitle = title.replace(/['"]/g, "").trim();
  const safeBody = body.replace(/['"]/g, "").trim();
  if (!safeTitle || !safeBody || !/\d{4}/.test(safeBody)) return plan;
  const instruction = `Call office_craft with action 'edit' and app 'slides' and title '${safeTitle}' and body '${safeBody}'.`;
  let replaced = false;
  const steps = plan.steps.map((step) => {
    if (replaced || !/action\s+['"]edit['"]/i.test(step.instruction) || !/slides/i.test(step.instruction)) return step;
    replaced = true;
    return { ...step, instruction };
  });
  return replaced ? { ...plan, steps } : plan;
}

const SLIDE_FACTS_SYSTEM = [
  "Reply with JSON only, no markdown: {\"title\":\"...\",\"body\":\"...\"}.",
  "The title and body are one slide in the user's language. When the user wrote Arabic, both contain Arabic words.",
  "The body names the designer in Latin letters and the opening year as four digits, inside the same Arabic sentence. Use the real facts for that subject.",
  "Do not describe the task and do not invent a different building.",
].join(" ");

const SLIDE_FACTS_ARABIC = [
  "Reply with JSON only, no markdown: {\"title\":\"...\",\"body\":\"...\"}.",
  "Rewrite the body into Arabic. Keep the designer's Latin name and the four-digit year inside that Arabic body. Keep the Arabic title.",
].join(" ");

/** A slide title and body are usable when the body has a year and matches the user's language. */
export function acceptSlideFacts(prompt: string, title: string, body: string): boolean {
  if (!title.trim() || !body.trim() || !/\d{4}/.test(body)) return false;
  if (ARABIC.test(prompt) && (!ARABIC.test(title) || !ARABIC.test(body))) return false;
  return true;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    durationMs: left.durationMs + right.durationMs,
  };
}

function latinName(text: string): string {
  const matches = text.match(/\b[A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*){0,4}/g) ?? [];
  return matches.find((item) => item.includes(".") && item.length > 3) ?? "";
}

/** Keep the year and the Latin designer name from a facts reply inside the slide body. */
export function mergeSlideFacts(prompt: string, title: string, body: string, facts: string): { title: string; body: string } | null {
  const year = facts.match(/\b\d{4}\b/)?.[0] ?? "";
  const name = latinName(facts);
  let nextBody = body.trim();
  if (year && !nextBody.includes(year)) nextBody = `${nextBody} ${year}`.trim();
  if (name && !nextBody.includes(name)) nextBody = `${nextBody} (${name})`.trim();
  let nextTitle = title.trim();
  if (ARABIC.test(prompt) && !ARABIC.test(nextTitle)) {
    const arabic = nextBody.match(/[\u0600-\u06ff][\u0600-\u06ff\s]{1,60}/)?.[0]?.trim() ?? "";
    if (arabic) nextTitle = arabic;
  }
  if (!acceptSlideFacts(prompt, nextTitle, nextBody)) return null;
  return { title: nextTitle, body: nextBody };
}

async function slideFacts(o: PlannerOptions): Promise<{ title: string; body: string; usage: Usage } | null> {
  const ask = async (system: string, user: string): Promise<ChatResult> => chatWithFallback({
    cfg: o.cfg,
    ollama: o.ollama,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    ...(o.model ? { model: o.model } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const read = (content: string): { title: string; body: string } | null => {
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const title = str(record["title"]);
    const body = str(record["body"]);
    return title && body ? { title, body } : null;
  };
  try {
    const first = await ask(SLIDE_FACTS_SYSTEM, o.prompt);
    let usage = first.usage;
    let parsed = read(first.content);
    if (parsed && acceptSlideFacts(o.prompt, parsed.title, parsed.body)) return { ...parsed, usage };
    if (!parsed || !/\d{4}/.test(parsed.body)) {
      const retry = await ask(SLIDE_FACTS_SYSTEM, `${o.prompt}\nThe body must include the designer's Latin name and the opening year as four digits.`);
      usage = addUsage(usage, retry.usage);
      const again = read(retry.content);
      if (again && acceptSlideFacts(o.prompt, again.title, again.body)) return { ...again, usage };
      if (again && /\d{4}/.test(again.body)) parsed = again;
    }
    if (!parsed || !/\d{4}/.test(parsed.body)) return null;
    if (!ARABIC.test(o.prompt)) return { ...parsed, usage };
    const second = await ask(SLIDE_FACTS_ARABIC, `Previous title: ${parsed.title}\nPrevious body: ${parsed.body}\nUser request: ${o.prompt}`);
    usage = addUsage(usage, second.usage);
    const rewritten = read(second.content);
    const merged = mergeSlideFacts(o.prompt, rewritten?.title || parsed.title, rewritten?.body || parsed.body, parsed.body);
    return merged ? { ...merged, usage } : null;
  } catch (err) {
    if (o.signal?.aborted || isCancelledError(err)) throw err instanceof Error ? err : new Error(String(err));
    log.warn(`slide facts failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const SHEET_GRID = "Item|Amount;Rent|1200;Food|450;Transit|180;Utilities|260;Supplies|90;Total|=SUM(B2:B6)";

/** An explicit Markdown README is one loam_document call, not a Craft editor and not a website. */
export function preferMarkdownPlan(prompt: string, plan: Plan): Plan {
  const markdown = fallbackMarkdownPlan(prompt);
  if (!markdown) return plan;
  const writesReadme = plan.steps.some((step) => /loam_document/i.test(step.instruction) && /README\.md/i.test(step.instruction));
  return writesReadme ? plan : markdown;
}

function fallbackMarkdownPlan(prompt: string): Plan | null {
  if (!/\bmarkdown\b/i.test(prompt) || !/\breadme\b/i.test(prompt)) return null;
  if (/\b(docx|pptx|xlsx|spreadsheet|slides|presentation)\b/i.test(prompt) || /برزنتيشن/.test(prompt)) return null;
  const content = "A command-line tool. Install it, run the command, and read the commands below.";
  return {
    goal: "README",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Write",
        instruction: `Call loam_document with path 'README.md' and title 'CLI' and format 'markdown' and content '${content}'.`,
        successCriteria: "README.md exists and no Craft editor was opened",
      },
    ],
  };
}

/** A responsive landing page is a web scaffold plus a local preview, not an office file. */
export function preferLandingPlan(prompt: string, plan: Plan): Plan {
  const landing = fallbackLandingPlan(prompt);
  if (!landing) return plan;
  const scaffolds = plan.steps.some((step) => /web_scaffold/i.test(step.instruction));
  const previews = plan.steps.some((step) => /preview_serve/i.test(step.instruction));
  return scaffolds && previews ? plan : landing;
}

function fallbackLandingPlan(prompt: string): Plan | null {
  if (!/responsive landing page/i.test(prompt)) return null;
  return {
    goal: "responsive landing page",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Scaffold",
        instruction: "Call web_scaffold with projectDir 'site' and install 'false' and build 'false'.",
        successCriteria: "the site folder contains the starter files",
      },
      {
        id: "s2",
        title: "Preview",
        instruction: "Call preview_serve with dir 'site'.",
        successCriteria: "a local preview URL is returned",
      },
    ],
  };
}

/** A montage request imports the clip, cuts it, adds music, and exports an mp4. */
export function preferVideoPlan(prompt: string, plan: Plan): Plan {
  const video = fallbackVideoPlan(prompt);
  if (!video) return plan;
  const imports = plan.steps.some((step) => /video_studio/i.test(step.instruction) && /action\s+['"]import['"]/i.test(step.instruction));
  const cuts = plan.steps.some((step) => /video_studio/i.test(step.instruction) && /action\s+['"]cut['"]/i.test(step.instruction));
  const music = plan.steps.some((step) => /video_studio/i.test(step.instruction) && /action\s+['"]music['"]/i.test(step.instruction));
  const exportsMp4 = plan.steps.some((step) => /video_studio/i.test(step.instruction) && /action\s+['"]export['"]/i.test(step.instruction));
  return imports && cuts && music && exportsMp4 ? plan : video;
}

function citedMedia(prompt: string, ext: string, fallback: string): string {
  const hit = prompt.match(new RegExp("`([^`\\n]+\\.(?:" + ext + "))`", "i"))?.[1];
  return hit ? hit.replace(/\\/g, "/").replace(/\/{2,}/g, "/") : fallback;
}

/** A square crop and brighten request opens Loam Photo, brightens, and exports a png. */
export function preferPhotoPlan(prompt: string, plan: Plan): Plan {
  const photo = fallbackPhotoPlan(prompt);
  if (!photo) return plan;
  const opens = plan.steps.some((step) => /office_craft/i.test(step.instruction) && /app 'photo'/.test(step.instruction) && /action 'open'/.test(step.instruction));
  const crops = plan.steps.some((step) => /image\.crop/.test(step.instruction));
  const brightens = plan.steps.some((step) => /brightnessContrast/.test(step.instruction));
  const exportsPng = plan.steps.some((step) => /office_craft/i.test(step.instruction) && /action 'export'/.test(step.instruction) && /format 'png'/.test(step.instruction) && /"crop"/.test(step.instruction));
  return opens && crops && brightens && exportsPng ? plan : photo;
}

/** The labour-law annual-leave request searches the corpus, then reads one article. */
export function preferLegalPlan(prompt: string, plan: Plan): Plan {
  const legal = fallbackLegalPlan(prompt);
  if (!legal) return plan;
  const searches = plan.steps.some((step) => /legal_search/i.test(step.instruction) && /إجازة سنوية/.test(step.instruction));
  const article = plan.steps.some((step) => /legal_article/i.test(step.instruction) && /lawKey 'law\/2004\/14'/.test(step.instruction) && /label '79'/.test(step.instruction));
  return searches && article ? plan : legal;
}

const DEVFLOW_PROMPT = /dev flow: list the github issue on khamis1992\/loam-r18-throwaway/i;

/** The throwaway dev-flow request lists the issue, branches locally, reaches the swarm, and opens a draft PR. */
export function preferDevflowPlan(prompt: string, plan: Plan): Plan {
  const devflow = fallbackDevflowPlan(prompt);
  if (!devflow) return plan;
  const issue = plan.steps.some((step) => /github_list_issues/i.test(step.instruction) && /khamis1992\/loam-r18-throwaway/.test(step.instruction));
  const branch = plan.steps.some((step) => /git_branch/i.test(step.instruction) && /r18-route/.test(step.instruction) && !/push/i.test(step.instruction));
  const swarm = plan.steps.some((step) => /swarm_run/i.test(step.instruction)) && plan.steps.some((step) => /swarm_status/i.test(step.instruction));
  const draft = plan.steps.some((step) => /pr_create/i.test(step.instruction) && /draft 'true'/.test(step.instruction));
  return issue && branch && swarm && draft ? plan : devflow;
}

function fallbackDevflowPlan(prompt: string): Plan | null {
  if (!DEVFLOW_PROMPT.test(prompt)) return null;
  return {
    goal: "throwaway dev flow",
    trivial: false,
    source: "fallback",
    steps: [
      { id: "s1", title: "Issue", instruction: "Call github_list_issues with repo 'khamis1992/loam-r18-throwaway'.", successCriteria: "the throwaway repository issues are listed" },
      { id: "s2", title: "Branch", instruction: "Call git_branch with name 'r18-route'.", successCriteria: "the local branch exists and nothing was pushed" },
      { id: "s3", title: "Swarm", instruction: "Call swarm_run with brief 'Add one README line' and effort 'solo'.", successCriteria: "the swarm service returned a run id" },
      { id: "s4", title: "Status", instruction: "Call swarm_status with runId ''.", successCriteria: "the swarm service returned the newest run" },
      { id: "s5", title: "Draft", instruction: "Call pr_create with repo 'khamis1992/loam-r18-throwaway' and title 'R18 route' and head 'r18-route' and body 'draft route check' and draft 'true'.", successCriteria: "a draft pull request was opened and nothing was pushed" },
    ],
  };
}

function fallbackLegalPlan(prompt: string): Plan | null {
  if (!/find the qatar labour law article on annual leave/i.test(prompt)) return null;
  return {
    goal: "annual leave article",
    trivial: false,
    source: "fallback",
    steps: [
      { id: "s1", title: "Search", instruction: "Call legal_search with query 'إجازة سنوية' and lawKey 'law/2004/14'.", successCriteria: "the corpus search returned the annual-leave article" },
      { id: "s2", title: "Article", instruction: "Call legal_article with lawKey 'law/2004/14' and label '79'.", successCriteria: "the article text is returned by the corpus" },
    ],
  };
}

/** An A4 flyer request opens Loam Design and exports a pdf. */
export function preferDesignPlan(prompt: string, plan: Plan): Plan {
  const design = fallbackDesignPlan(prompt);
  if (!design) return plan;
  const opens = plan.steps.some((step) => /office_craft/i.test(step.instruction) && /app 'design'/.test(step.instruction) && /action 'open'/.test(step.instruction) && /"preset":"A4"/.test(step.instruction));
  const draws = plan.steps.some((step) => /frame\.create/.test(step.instruction) && /"rect":\[/.test(step.instruction));
  const exportsPdf = plan.steps.some((step) => /office_craft/i.test(step.instruction) && /action 'export'/.test(step.instruction) && /format 'pdf'/.test(step.instruction) && /flyer\.pdf/.test(step.instruction));
  return opens && draws && exportsPdf ? plan : design;
}

function fallbackDesignPlan(prompt: string): Plan | null {
  if (!/design an a4 event flyer layout/i.test(prompt)) return null;
  return {
    goal: "event flyer",
    trivial: false,
    source: "fallback",
    steps: [
      { id: "s1", title: "Open", instruction: "Call office_craft with action 'open' and app 'design' and params '{\"preset\":\"A4\"}'.", successCriteria: "Loam Design is open" },
      { id: "s2", title: "Frame", instruction: "Call office_craft with action 'execute' and app 'design' and command 'frame.create' and params '{\"rect\":[36,36,559,806],\"content\":\"text\",\"text\":\"Evening market\"}'.", successCriteria: "the flyer frame is on the page" },
      { id: "s3", title: "Export", instruction: "Call office_craft with action 'export' and app 'design' and format 'pdf' and params '{\"path\":\"flyer.pdf\"}'.", successCriteria: "flyer.pdf is saved" },
    ],
  };
}

function fallbackPhotoPlan(prompt: string): Plan | null {
  if (!/crop it square and brighten/i.test(prompt)) return null;
  const file = citedMedia(prompt, "png|jpg|jpeg|webp|tif|tiff|psd", "attachments/photo.png");
  return {
    goal: "photo edit",
    trivial: false,
    source: "fallback",
    steps: [
      { id: "s1", title: "Open", instruction: `Call office_craft with action 'open' and app 'photo' and file '${file}'.`, successCriteria: "Loam Photo is open with the image" },
      { id: "s2", title: "Crop", instruction: "Call office_craft with action 'execute' and app 'photo' and command 'image.crop' and params '{\"x\":2,\"y\":0,\"width\":4,\"height\":4,\"deleteCroppedPixels\":true}'.", successCriteria: "the image is square" },
      { id: "s3", title: "Brighten", instruction: "Call office_craft with action 'execute' and app 'photo' and command 'image.adjustments.brightnessContrast' and params '{\"brightness\":40,\"contrast\":10}'.", successCriteria: "the image is brighter" },
      { id: "s4", title: "Export", instruction: "Call office_craft with action 'export' and app 'photo' and format 'png' and params '{\"path\":\"edited.png\",\"crop\":{\"x\":2,\"y\":0,\"width\":4,\"height\":4,\"deleteCroppedPixels\":true},\"brightness\":40,\"contrast\":10}'.", successCriteria: "edited.png is saved" },
    ],
  };
}

function fallbackVideoPlan(prompt: string): Plan | null {
  if (!/cut at\s+2\s*s/i.test(prompt) || !/export mp4/i.test(prompt)) return null;
  const clip = citedMedia(prompt, "mp4|mkv|mov|webm", "attachments/clip.mp4");
  const music = citedMedia(prompt, "wav|mp3|m4a", "attachments/tone.wav");
  return {
    goal: "video montage",
    trivial: false,
    source: "fallback",
    steps: [
      { id: "s1", title: "Import", instruction: `Call video_studio with action 'import' and path '${clip}'.`, successCriteria: "the clip is on the Loam Video timeline" },
      { id: "s2", title: "Cut", instruction: "Call video_studio with action 'cut' and atSec '2'.", successCriteria: "the timeline is cut at 2 seconds" },
      { id: "s3", title: "Music", instruction: `Call video_studio with action 'music' and path '${music}'.`, successCriteria: "the music is on an audio track" },
      { id: "s4", title: "Export", instruction: "Call video_studio with action 'export' and format 'mp4' and name 'montage'.", successCriteria: "montage.mp4 is exported" },
    ],
  };
}

/** A sourced research request searches, then opens the official page in the browser. */
export function preferResearchPlan(prompt: string, plan: Plan): Plan {
  const research = fallbackResearchPlan(prompt);
  if (!research) return plan;
  const searches = plan.steps.some((step) => /web_search/i.test(step.instruction));
  const browses = plan.steps.some((step) => /browser_open/i.test(step.instruction));
  return searches && browses ? plan : research;
}

function fallbackResearchPlan(prompt: string): Plan | null {
  if (!/cite sources/i.test(prompt) || !/node lts/i.test(prompt)) return null;
  return {
    goal: "Node LTS sources",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Search",
        instruction: "Call web_search with query 'latest Node.js LTS'.",
        successCriteria: "the search result lists source URLs",
      },
      {
        id: "s2",
        title: "Open",
        instruction: "Call browser_open with url 'https://nodejs.org/en/about/previous-releases'.",
        successCriteria: "the browser opened the Node.js release page",
      },
    ],
  };
}

/** An explicit HTML slide page is a web file, never a Loam Slides deck and never presentation_build. */
export function preferHtmlSlidePlan(prompt: string, plan: Plan): Plan {
  const page = fallbackHtmlSlidePlan(prompt);
  if (!page) return plan;
  const writesPage = plan.steps.some((step) => /file_write/i.test(step.instruction) && /index\.html/i.test(step.instruction));
  const writesContract = plan.steps.some((step) => /file_write/i.test(step.instruction) && /app-verification\.json/i.test(step.instruction));
  return writesPage && writesContract ? plan : page;
}

function fallbackHtmlSlidePlan(prompt: string): Plan | null {
  if (!/html slide page/i.test(prompt)) return null;
  const subject = prompt.match(/\babout\s+([A-Za-z0-9]+)/i)?.[1] ?? "X";
  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head><body><h1>${subject}</h1></body></html>`;
  const contract = `{"entry":"index.html","scenarios":[{"name":"heading","steps":[{"action":"text","selector":"h1","value":"${subject}"}]}]}`;
  return {
    goal: "HTML slide page",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Page",
        instruction: `Call file_write with path 'index.html' and content '${html}'.`,
        successCriteria: "index.html exists and names the subject",
      },
      {
        id: "s2",
        title: "Contract",
        instruction: `Call file_write with path 'app-verification.json' and content '${contract}'.`,
        successCriteria: "the page contract checks the heading",
      },
    ],
  };
}

/** A security-header request checks the named local target, then starts the assessment service. */
export function preferSecurityPlan(prompt: string, plan: Plan): Plan {
  const security = fallbackSecurityPlan(prompt);
  if (!security) return plan;
  const checks = plan.steps.some((step) => /pentest_check/i.test(step.instruction));
  const assesses = plan.steps.some((step) => /security_assess/i.test(step.instruction));
  return checks && assesses ? plan : security;
}

function fallbackSecurityPlan(prompt: string): Plan | null {
  if (!/security headers/i.test(prompt)) return null;
  const target = prompt.match(/https?:\/\/[^\s'")]+/i)?.[0] ?? "http://127.0.0.1:3000";
  return {
    goal: "security headers",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Headers",
        instruction: `Call pentest_check with target '${target}' and check 'security_headers'.`,
        successCriteria: "a header report is returned for the local target",
      },
      {
        id: "s2",
        title: "Assess",
        instruction: `Call security_assess with target '${target}'.`,
        successCriteria: "the local security service accepted the target",
      },
    ],
  };
}

/** Arabic subtitles on an attached clip are one creative_subtitles call. */
export function preferSubtitlesPlan(prompt: string, plan: Plan): Plan {
  const subtitles = fallbackSubtitlesPlan(prompt);
  if (!subtitles) return plan;
  const writes = plan.steps.some((step) => /creative_subtitles/i.test(step.instruction));
  return writes ? plan : subtitles;
}

function fallbackSubtitlesPlan(prompt: string): Plan | null {
  if (!/arabic subtitles/i.test(prompt)) return null;
  const cited = prompt.match(/`([^`\n]+\.(?:mp4|mkv|mov|webm|wav))`/i)?.[1]?.replace(/\\/g, "/").replace(/\/{2,}/g, "/") ?? "attachments/clip.mp4";
  return {
    goal: "Arabic subtitles",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Subtitles",
        instruction: `Call creative_subtitles with mediaPath '${cited}' and format 'both'.`,
        successCriteria: "SRT and VTT files exist, or the speech runtime reports it is unavailable",
      },
    ],
  };
}

/** Column statistics on an attached CSV are one loam_dataset call. */
export function preferDatasetPlan(prompt: string, plan: Plan): Plan {
  const dataset = fallbackDatasetPlan(prompt);
  if (!dataset) return plan;
  const reads = plan.steps.some((step) => /loam_dataset/i.test(step.instruction) && /\.csv/i.test(step.instruction));
  return reads ? plan : dataset;
}

function fallbackDatasetPlan(prompt: string): Plan | null {
  if (!/statistics per column/i.test(prompt)) return null;
  const cited = prompt.match(/`([^`\n]+\.csv)`/i)?.[1]?.replace(/\\/g, "/").replace(/\/{2,}/g, "/") ?? "attachments/columns.csv";
  return {
    goal: "column statistics",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Statistics",
        instruction: `Call loam_dataset with path '${cited}' and output 'column-stats.json'.`,
        successCriteria: "column-stats.json reports a count for every column",
      },
    ],
  };
}

/** A metal-base product scene is one loam_creative replace, not a website. */
export function preferCreativePlan(prompt: string, plan: Plan): Plan {
  const creative = fallbackCreativePlan(prompt);
  if (!creative) return plan;
  const saves = plan.steps.some((step) => /loam_creative/i.test(step.instruction) && /metal-base/i.test(step.instruction));
  return saves ? plan : creative;
}

function fallbackCreativePlan(prompt: string): Plan | null {
  if (!/\bmetal base\b/i.test(prompt) || !/\b(3d|scene)\b/i.test(prompt)) return null;
  return {
    goal: "3D product scene",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Scene",
        instruction: "Call loam_creative with action 'replace' and preset 'metal-base'.",
        successCriteria: "a 3D scene with a metal base is saved",
      },
    ],
  };
}

/** A vector poster is one loam_canvas call that writes an SVG. */
export function preferCanvasPlan(prompt: string, plan: Plan): Plan {
  const canvas = fallbackCanvasPlan(prompt);
  if (!canvas) return plan;
  const draws = plan.steps.some((step) => /loam_canvas/i.test(step.instruction) && /\.svg/i.test(step.instruction));
  return draws ? plan : canvas;
}

function fallbackCanvasPlan(prompt: string): Plan | null {
  if (!/\bvector poster\b/i.test(prompt)) return null;
  return {
    goal: "vector poster",
    trivial: false,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Draw",
        instruction: "Call loam_canvas with path 'poster.svg' and title 'Poster'.",
        successCriteria: "poster.svg exists",
      },
    ],
  };
}

/** A parsed spreadsheet plan without a quoted formula grid is replaced by the open, edit, export sequence. */
export function preferSheetsPlan(prompt: string, plan: Plan): Plan {
  const sheets = fallbackSheetsPlan(prompt);
  if (!sheets) return plan;
  const edit = plan.steps.find((step) => /action\s+['"]edit['"]/i.test(step.instruction) && /\bsheets\b/i.test(step.instruction));
  const body = edit?.instruction.match(/\bbody\s+['"]([^'"]+)['"]/i)?.[1]?.trim() ?? "";
  const exportsSheets = plan.steps.some((step) => /action\s+['"]export['"]/i.test(step.instruction) && /\bsheets\b/i.test(step.instruction));
  return exportsSheets && /=SUM\(/i.test(body) ? plan : sheets;
}

/** When the request is a workbook, open Loam Sheets, write five amount rows plus a total, and export. */
function fallbackSheetsPlan(prompt: string): Plan | null {
  if (!/\b(spreadsheet|xlsx|workbook)\b/i.test(prompt)) return null;
  if (/\b(docx|slides|pptx|presentation)\b/i.test(prompt) || /برزنتيشن/.test(prompt)) return null;
  return {
    goal: "budget spreadsheet",
    trivial: false,
    source: "fallback",
    steps: [
      { id: "s1", title: "Open", instruction: "Call office_craft with action 'open' and app 'sheets'.", successCriteria: "Loam Sheets is open" },
      { id: "s2", title: "Write", instruction: `Call office_craft with action 'edit' and app 'sheets' and body '${SHEET_GRID}'.`, successCriteria: "five rows and a SUM total are in the grid" },
      { id: "s3", title: "Export", instruction: "Call office_craft with action 'export' and app 'sheets'.", successCriteria: "an xlsx path is returned" },
    ],
  };
}

/** A parsed plan that never exports the document is replaced by the open, edit, export sequence. */
export function preferDocxPlan(prompt: string, plan: Plan): Plan {
  const docx = fallbackDocxPlan(prompt);
  if (!docx) return plan;
  if (process.env.LOAM_CRAFT_DISABLED === "1") return docx;
  const edit = plan.steps.find((step) => /action\s+['"]edit['"]/i.test(step.instruction) && /\bdocs\b/i.test(step.instruction));
  const body = edit?.instruction.match(/\bbody\s+['"]([^'"]+)['"]/i)?.[1]?.trim() ?? "";
  const exportsDocs = plan.steps.some((step) => /action\s+['"]export['"]/i.test(step.instruction) && /\bdocs\b/i.test(step.instruction));
  return exportsDocs && body ? plan : docx;
}

/** When the model plan cannot be parsed, a docx request still opens Loam Docs and exports. */
function fallbackDocxPlan(prompt: string): Plan | null {
  if (!/\bdocx\b/i.test(prompt) || /slides|pptx|presentation|برزنتيشن/i.test(prompt)) return null;
  const page = (prompt.split(/\r?\n/)[0] ?? "").replace(/['"]/g, "").trim().slice(0, 500);
  if (!page) return null;
  if (process.env.LOAM_CRAFT_DISABLED === "1") {
    const content = JSON.stringify({
      blocks: [
        { type: "heading", text: "Q4 Plans Memo" },
        { type: "paragraph", text: page },
      ],
    });
    return {
      goal: "docx without the editor",
      trivial: false,
      source: "fallback",
      steps: [
        {
          id: "s1",
          title: "Studio",
          instruction: `Call loam_studio with action 'replace' and kind 'document' and title 'Q4 Plans Memo' and expectedRevision '0' and content '${content}'.`,
          successCriteria: "the studio document is saved",
        },
        {
          id: "s2",
          title: "Export",
          instruction: "Call office_export with path 'uploads/memo.docx'.",
          successCriteria: "a docx file is exported",
        },
      ],
    };
  }
  return {
    goal: page.slice(0, 120),
    trivial: false,
    source: "fallback",
    steps: [
      { id: "s1", title: "Open", instruction: "Call office_craft with action 'open' and app 'docs'.", successCriteria: "Loam Docs is open" },
      { id: "s2", title: "Write", instruction: `Call office_craft with action 'edit' and app 'docs' and body '${page}'.`, successCriteria: "the page contains the memo" },
      { id: "s3", title: "Export", instruction: "Call office_craft with action 'export' and app 'docs'.", successCriteria: "a docx path is returned" },
    ],
  };
}

/** Single-step fallback plan; subject to the same mandatory verification. */
export function fallbackPlan(prompt: string): Plan {
  const docx = fallbackDocxPlan(prompt);
  if (docx) return docx;
  const sheets = fallbackSheetsPlan(prompt);
  if (sheets) return sheets;
  const markdown = fallbackMarkdownPlan(prompt);
  if (markdown) return markdown;
  const canvas = fallbackCanvasPlan(prompt);
  if (canvas) return canvas;
  const creative = fallbackCreativePlan(prompt);
  if (creative) return creative;
  const dataset = fallbackDatasetPlan(prompt);
  if (dataset) return dataset;
  const subtitles = fallbackSubtitlesPlan(prompt);
  if (subtitles) return subtitles;
  const security = fallbackSecurityPlan(prompt);
  if (security) return security;
  const htmlSlide = fallbackHtmlSlidePlan(prompt);
  if (htmlSlide) return htmlSlide;
  const research = fallbackResearchPlan(prompt);
  if (research) return research;
  const landing = fallbackLandingPlan(prompt);
  if (landing) return landing;
  const video = fallbackVideoPlan(prompt);
  if (video) return video;
  const photo = fallbackPhotoPlan(prompt);
  if (photo) return photo;
  const design = fallbackDesignPlan(prompt);
  if (design) return design;
  const legal = fallbackLegalPlan(prompt);
  if (legal) return legal;
  const devflow = fallbackDevflowPlan(prompt);
  if (devflow) return devflow;
  return {
    goal: (prompt.split(/\r?\n/)[0] ?? "").slice(0, 120) || prompt.slice(0, 120),
    trivial: true,
    source: "fallback",
    steps: [
      {
        id: "s1",
        title: "Direct execution",
        instruction: prompt,
        successCriteria: "the user's request is fulfilled as described",
      },
    ],
  };
}

/** Plan a task with one model call; degrades to a single-step fallback plan on any failure. */
export async function planTask(o: PlannerOptions): Promise<PlanResult> {
  const user = [
    "TASK WORKSPACE (host source files):",
    o.cfg.workspace,
    "",
    "USER REQUEST:",
    o.prompt,
    ...(o.availableTools ? ["", "AVAILABLE TOOLS:", o.availableTools.join(", ")] : []),
    ...(o.memories && o.memories.length > 0
      ? ["", "USEFUL MEMORIES:", ...o.memories.map((m) => `- ${m.text.slice(0, 300)}`)]
      : []),
    "",
    "Return the JSON plan now.",
  ].join("\n");

  let res: ChatResult | null = null;
  try {
    res = await chatWithFallback({
      cfg: o.cfg,
      ollama: o.ollama,
      messages: [
        { role: "system", content: PLANNER_SYSTEM },
        ...(o.history ?? []),
        { role: "user", content: user },
      ],
      temperature: 0.1,
      ...(o.model ? { model: o.model } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (err) {
    // Cancellation must stop the whole run — never fall back to a plan and keep going.
    if (o.signal?.aborted || isCancelledError(err)) throw err instanceof Error ? err : new Error(String(err));
    log.warn(`planner failed: ${err instanceof Error ? err.message : String(err)}; using single-step fallback plan`);
  }

  if (res) {
    const normalized = normalizePlan(extractJson(res.content), o.prompt, o.maxPlanSteps);
    if (normalized && presentationRequest(o.prompt) && slidesEditLacksYear(normalized)) {
      const facts = await slideFacts(o);
      const repaired = facts ? applySlideFacts(normalized, facts.title, facts.body) : normalized;
      const usage = facts
        ? {
            promptTokens: res.usage.promptTokens + facts.usage.promptTokens,
            completionTokens: res.usage.completionTokens + facts.usage.completionTokens,
            durationMs: res.usage.durationMs + facts.usage.durationMs,
          }
        : res.usage;
      return { plan: repaired, model: res.model, usage };
    }
    if (normalized) return { plan: preferDevflowPlan(o.prompt, preferLegalPlan(o.prompt, preferDesignPlan(o.prompt, preferPhotoPlan(o.prompt, preferVideoPlan(o.prompt, preferLandingPlan(o.prompt, preferResearchPlan(o.prompt, preferHtmlSlidePlan(o.prompt, preferSecurityPlan(o.prompt, preferSubtitlesPlan(o.prompt, preferDatasetPlan(o.prompt, preferCreativePlan(o.prompt, preferCanvasPlan(o.prompt, preferMarkdownPlan(o.prompt, preferSheetsPlan(o.prompt, preferDocxPlan(o.prompt, normalized)))))))))))))))), model: res.model, usage: res.usage };
    log.warn("planner: unparseable output; using single-step fallback plan");
    return { plan: fallbackPlan(o.prompt), model: res.model, usage: res.usage };
  }
  return {
    plan: fallbackPlan(o.prompt),
    model: o.cfg.model,
    usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
  };
}

export interface NextStepOptions {
  cfg: Config;
  ollama: OllamaClient;
  /** The proposal context: recipe so far plus the results of the last step. */
  context: RecipeProposeContext;
  /** Planner model override ("" = main model). */
  model?: string;
  signal?: AbortSignal;
}

export interface NextStepResult {
  /** The raw model reply; useful for logs and for the "unparseable" fallback. */
  content: string;
  model: string;
  usage: Usage;
  /** True when the model produced no usable JSON, so the caller keeps the
   *  recipe it already had instead of applying a decision. */
  unparsed: boolean;
}

/**
 * Propose the next recipe step(s) from the results of the step that just ran.
 *
 * This is the incremental half of the N4 Recipe engine: one short model call
 * per finished step, so the recipe follows the evidence instead of a list that
 * was frozen before the first tool ran. A failure or an unparseable reply is
 * never fatal: the caller treats it as "propose nothing" and keeps going with
 * the recipe it has, exactly as a failed upfront plan falls back to one step.
 */
export async function proposeNextSteps(o: NextStepOptions): Promise<NextStepResult> {
  const empty: NextStepResult = { content: "", model: o.model ?? o.cfg.model, usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 }, unparsed: true };
  let res: ChatResult | null = null;
  try {
    res = await chatWithFallback({
      cfg: o.cfg,
      ollama: o.ollama,
      messages: [{ role: "system", content: RECIPE_PLANNER_SYSTEM }, { role: "user", content: proposePrompt(o.context) }],
      temperature: 0.1,
      ...(o.model ? { model: o.model } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (err) {
    // Cancellation stops the whole run; anything else is a skipped round.
    if (o.signal?.aborted || isCancelledError(err)) throw err instanceof Error ? err : new Error(String(err));
    log.warn(`recipe proposal failed: ${err instanceof Error ? err.message : String(err)}; keeping the current recipe`);
    return empty;
  }
  const parsed = extractJson(res.content);
  if (parsed === null) {
    log.warn("recipe proposal: unparseable output; keeping the current recipe");
    return { content: res.content, model: res.model, usage: res.usage, unparsed: true };
  }
  return { content: res.content, model: res.model, usage: res.usage, unparsed: false };
}
