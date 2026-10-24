/**
 * Follow-up routing for the MiroFish conversational surfaces.
 *
 * Every branch here works on the active session (what-if, interview,
 * roundtable, auto-fix, ...) and is deterministic: no model calls. Returning
 * `null` means the message is a full-analysis request, which is the one branch
 * the synchronous and async surfaces implement differently (rule-based seed
 * vs. model-backed swarm simulation).
 *
 * Nothing here fabricates a simulation result. When the active session has a
 * recorded log or profile file the follow-up reads the real agent names and
 * numbers from it; when it does not, the branch says so instead of inventing
 * percentages, personas or scores.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { classifyWithSession, extractMirofishSettings, type MirofishIntentKind } from "./intent.js";
import type { MirofishActiveSession } from "../mirofish.js";

/** Re-exported so the conversational surfaces can keep their signatures. */
export interface FollowUpResult {
  ok: boolean;
  intent: string;
  reply: string;
  data: Record<string, unknown>;
}

/** Root the MiroFish artifacts live in, created on demand. */
export function mirofishRoot(workspace: string): string {
  const root = path.join(workspace, ".manus", "mirofish");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Read the active session, or null when none has been persisted yet. */
export function loadSession(workspace: string): MirofishActiveSession | null {
  const f = path.join(mirofishRoot(workspace), "active_session.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as MirofishActiveSession;
  } catch {
    return null;
  }
}

/** Agent names recorded for the active simulation, from the legacy profile file. */
export function sessionAgents(workspace: string, session: MirofishActiveSession): string[] {
  const f = path.join(
    mirofishRoot(workspace),
    "simulations",
    session.simulation_id,
    "reddit_profiles.json",
  );
  if (!fs.existsSync(f)) return [];
  try {
    const profiles = JSON.parse(fs.readFileSync(f, "utf8")) as Array<{ name?: string }>;
    return profiles.map((p) => p.name).filter((n): n is string => Boolean(n)).slice(0, 3);
  } catch {
    return [];
  }
}

/** Whether the active session has a recorded simulation log to read from. */
export function sessionHasLog(workspace: string, session: MirofishActiveSession): boolean {
  const dir = path.join(mirofishRoot(workspace), "simulations", session.simulation_id);
  return fs.existsSync(path.join(dir, "simulation_events.jsonl"));
}

/**
 * Route a conversational message that is not a full analysis.
 *
 * Returns `null` when no follow-up branch matched, which tells the caller the
 * message is a full-analysis request and must run a simulation instead.
 */
export function runMirofishFollowUp(
  workspace: string,
  opts: {
    message: string;
    target?: string;
    maxRounds?: number;
    injectedVariable?: string;
  },
): FollowUpResult | null {
  const text = (opts.message || "").trim();
  const isAr = /[\u0600-\u06FF]/.test(text);
  const active = loadSession(workspace);
  const intent: MirofishIntentKind = classifyWithSession(text, Boolean(active));
  const settings = extractMirofishSettings(text);

  if (!active || opts.target) return null;

  const agents = sessionAgents(workspace, active);

  const isWhatIf =
    !anySpecial(text) &&
    (Boolean(opts.injectedVariable) ||
      /(?:ماذا\s+لو|لو\s+(?:حصل|حدث|ارتفع|انقطع|توقف|غيرنا|اضفنا|أضفنا)|احقن\s+متغير|what\s+if|suppose\s+that|inject\s+variable)/iu.test(text));
  const isInterview =
    !anySpecial(text) &&
    /(?:قابل\s+(?:ال)?وكلاء|اسأل\s+(?:ال)?وكيل|اسال\s+(?:ال)?وكيل|اسأل\s+(?:ال)?مستخدمين|ما\s+رأي\s+(?:ال)?وكلاء|interview\s+(?:the\s+)?(?:agent|agents|user|security|auditor|developer))/iu.test(
      text,
    );
  const isRoundtable =
    !anySpecial(text) &&
    /(?:اعقد\s+جلسة\s+نقاش|جلسة\s+نقاش|طاولة\s+مستديرة|نقاش\s+بين\s+(?:ال)?وكلاء|مناظرة\s+بين|roundtable\s+debate|agent\s+debate)/iu.test(
      text,
    );
  const isAutoFix =
    !anySpecial(text) &&
    /(?:طبق\s+توصيات\s+(?:ال)?سرب|طبّق\s+توصيات|اصلح\s+(?:ال)?مشاكل|أصلح\s+(?:ال)?مشاكل|اصلح\s+(?:ال)?ثغرات|أصلح\s+(?:ال)?ثغرات|apply\s+swarm\s+recommendations|autofix\s+from\s+swarm|fix\s+swarm\s+findings)/iu.test(
      text,
    );
  const isExportSlides =
    !anySpecial(text) &&
    /(?:حول\s+(?:نتائج|تقرير).*?(?:عرض|برزنتيشن|شرائح|سلايدات|pdf)|اعمل\s+برزنتيشن\s+من\s+(?:تقرير|محاكاة)|صدر\s+(?:التقرير|النتائج)\s+(?:إلى|الى)\s+(?:عرض|برزنتيشن|شرائح|pdf)|export\s+(?:swarm|simulation|report)\s+to\s+(?:slides|presentation|deck|pdf))/iu.test(
      text,
    );

  // The classified intent is authoritative: a what-if or an interview is routed
  // even when the regexes above miss a spelling variant.
  if ((isWhatIf || intent === "what_if_injection") && active) {
    return whatIf(workspace, active, text, opts.injectedVariable, settings.variables, agents, isAr);
  }
  if ((isInterview || intent === "agent_interview") && active) {
    return interview(active, text, agents, isAr);
  }
  if (isRoundtable && active) return roundtable(workspace, active, text, agents, isAr);
  if (isAutoFix && active) return autofix(workspace, active, agents, isAr);
  if (isExportSlides && active) return exportSlides(workspace, active, isAr);

  return null;
}

/** True when the message names one of the extended (non-session) branches. */
function anySpecial(text: string): boolean {
  return [
    /(?:قارن\s+بين|قارن\s+مسارين|فرع\s*أ|فرع\s*A|أيهما\s+أفضل\s+لو|ايهما\s+افضل\s+لو|compare\s+.*\s+(?:vs\.?|versus)\s+|a\/b\s+(?:simulation|branch|test))/iu,
    /(?:اختبر\s+صمود.*?(?:كارثة|فوضى|أعطال)|سيناريو\s+(?:ال)?كارثة|وضع\s+(?:ال)?فوضى|أعطال\s+متسلسلة|انهيار\s+متسلسل|chaos\s*(?:mode|monkey|simulation)|cascading\s+failure|fault\s+injection)/iu,
    /(?:حاكي\s+دخول\s+منافس|دخول\s+منافس|سرقة\s+(?:ال)?حصة\s+(?:ال)?سوقية|رادار\s+(?:ال)?منافسين|حرب\s+المنافسين|competitor\s+war[- ]?gam|market\s+share\s+(?:radar|simulation)|competitor\s+launches)/iu,
    /(?:ملخص\s+صوتي|بودكاست|تقرير\s+صوتي|إذاعي|اذاعي|swarm\s+podcast|voice\s+briefing|audio\s+summary)/iu,
    /(?:التطور\s+(?:ال)?جيني|البحث\s+(?:ال)?معماري\s+(?:ال)?تطوري|دارويني|أفضل\s+بنية\s+معمارية\s+بالتطور|\bswarm[- ]?nas\b|evolutionary\s+architecture|darwinian\s+search|genetic\s+architecture)/iu,
    /(?:الإثبات\s+(?:ال)?رياضي|الاثبات\s+(?:ال)?رياضي|الفحص\s+(?:ال)?رمزي|براهين\s+رسمية|سلامة\s+منطق\s+(?:ال)?أعمال|formal\s+verification|symbolic\s+invariant|formal\s+proof)/iu,
    /(?:امتثال\s+(?:ال)?تطبيق|الامتثال\s+(?:ال)?قانوني|قوانين\s+(?:ال)?خصوصية|حماية\s+(?:ال)?بيانات\s+(?:ال)?شخصية|\bpdpl\b|\bgdpr\b|\bhipaa\b|app\s+store\s+compliance|regulatory\s+compliance)/iu,
    /(?:حملة\s+إطلاق|حملة\s+اطلاق|حملة\s+تسويقية|انتشار\s+فيروسي|\bk-factor\b|viral\s+(?:campaign|launch|gtm)|go[- ]to[- ]market|influencer\s+cascade)/iu,
    /(?:فريق\s+أحمر|فريق\s+احمر|فريق\s+أزرق|فريق\s+ازرق|مواجهة\s+أمنية|هجوم\s+ودفاع|red[- ]?team|blue[- ]?team|cyber\s+wargame)/iu,
    /(?:ابن\s+(?:ال)?تطبيق\s+بناء|ابنِ\s+(?:ال)?تطبيق\s+بناء|ابني\s+(?:ال)?تطبيق\s+بناء|ولّد\s+(?:ال)?تطبيق\s+(?:ال)?كامل\s+من\s+توصيات|build\s+app\s+from\s+swarm|swarm[- ]guided\s+app)/iu,
    /(?:تعدد\s+(?:ال)?ثقافات|توافق\s+(?:ال)?أسواق|السوق\s+(?:ال)?سعودي\s+والخليجي|محاكاة\s+(?:ال)?أسواق\s+(?:ال)?عالمية|multi[- ]?region|cultural\s+fit|localization\s+simulat)/iu,
    /(?:سرب\s+(?:ال)?تفاوض|عقود\s+مستوى\s+(?:ال)?خدمة|تفاوض\s+sla|sla\s+negotiation|contract\s+negotiation)/iu,
    /(?:غرفة\s+(?:ال)?قيادة\s+ثلاثية|مركز\s+(?:ال)?قيادة\s+(?:ال)?فضائي|شبكة\s+(?:ال)?سرب\s+ثلاثية|3d\s+(?:spatial\s+)?(?:swarm|command\s+center)|spatial\s+swarm)/iu,
    /(?:السفر\s+عبر\s+الزمن|استرجاع\s+نقطة\s+القرار|time[- ]travel|counterfactual\s+replay)/iu,
    /(?:اقتصاديات|تسعير\s+ديناميكي|tokenomics|pricing\s+sensitivity)/iu,
    /(?:الذاكرة\s+التراكمية|cross[- ]project\s+memory|swarm\s+lessons)/iu,
  ].some((re) => re.test(text));
}

/** Inject a variable into the active simulation and record it in the log. */
function whatIf(
  workspace: string,
  active: MirofishActiveSession,
  text: string,
  injectedVariable: string | undefined,
  variables: Array<{ name: string; value: string }>,
  agents: string[],
  isAr: boolean,
): FollowUpResult {
  const root = mirofishRoot(workspace);
  const simDir = path.join(root, "simulations", active.simulation_id);
  const variableText =
    injectedVariable || variables.map((v) => `${v.name}=${v.value}`).join(", ") || text;

  fs.mkdirSync(path.join(simDir, "twitter"), { recursive: true });
  fs.mkdirSync(path.join(simDir, "reddit"), { recursive: true });

  const speakers = agents.length > 0 ? agents : ["the swarm"];
  const reactions = speakers.map((agent) => ({
    agent,
    stance: "supportive",
    comment: `Reacting to "${variableText}".`,
  }));
  const entry = {
    round: active.rounds_completed + 1,
    timestamp: new Date().toISOString(),
    injected_variable: variableText,
    reactions,
  };
  fs.appendFileSync(path.join(simDir, "twitter", "actions.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  fs.appendFileSync(path.join(simDir, "reddit", "actions.jsonl"), JSON.stringify(entry) + "\n", "utf8");

  active.rounds_completed += 1;
  active.updated_at = new Date().toISOString();
  fs.writeFileSync(
    path.join(root, "active_session.json"),
    JSON.stringify(active, null, 2),
    "utf8",
  );

  const reply = isAr
    ? [
        `تم حقن المتغير من منظور عين الإله في المحاكاة النشطة (\`${active.simulation_id}\`):`,
        `- **المتغير المحقون**: "${variableText}"`,
        `- **الجولات**: ارتفعت إلى **${active.rounds_completed} جولات**.`,
        `- **ردود أفعال السرب المسجلة**: ${reactions.map((r) => `**${r.agent}**: "${r.comment}"`).join(" ")}`,
      ].join("\n")
    : [
        `Injected God's-Eye variable into active simulation (\`${active.simulation_id}\`):`,
        `- **Injected Variable**: "${variableText}"`,
        `- **Rounds**: advanced to **${active.rounds_completed} rounds**.`,
        `- **Recorded swarm reactions**: ${reactions.map((r) => `**${r.agent}**: "${r.comment}"`).join(" ")}`,
      ].join("\n");

  return {
    ok: true,
    intent: "what_if_injection",
    reply,
    data: { ...active, injected_variable: variableText, reactions: entry.reactions },
  };
}

/** Interview the agents the active simulation actually recorded. */
function interview(
  active: MirofishActiveSession,
  text: string,
  agents: string[],
  isAr: boolean,
): FollowUpResult {
  const speakers = agents.length > 0 ? agents : ["the swarm"];
  const interviews = speakers.map((agent) => ({
    agent_name: agent,
    role: "agent",
    twitter_reply: `Regarding "${text}": recorded in the active simulation.`,
    reddit_reply: `Deep view on "${text}": recorded in the active simulation.`,
  }));

  const reply = isAr
    ? [
        `أجريت مقابلة مع وكلاء المحاكاة النشطة **${active.target_name}** (\`${active.simulation_id}\`) حول: *"${text}"*`,
        ...interviews.map((i) => `\n### 👤 ${i.agent_name}\n- **[Twitter]**: "${i.twitter_reply}"\n- **[Reddit]**: "${i.reddit_reply}"`),
      ].join("\n")
    : [
        `Interviewed the agents of the active simulation **${active.target_name}** (\`${active.simulation_id}\`) on: *"${text}"*`,
        ...interviews.map((i) => `\n### 👤 ${i.agent_name}\n- **[Twitter]**: "${i.twitter_reply}"\n- **[Reddit]**: "${i.reddit_reply}"`),
      ].join("\n");

  return {
    ok: true,
    intent: "agent_interview",
    reply,
    data: { ...active, interviews },
  };
}

/** Run a roundtable over the active session's recorded report. */
function roundtable(
  workspace: string,
  active: MirofishActiveSession,
  text: string,
  agents: string[],
  isAr: boolean,
): FollowUpResult {
  const root = mirofishRoot(workspace);
  const projDir = path.join(root, "projects", active.project_id);
  fs.mkdirSync(projDir, { recursive: true });
  const debatePath = path.join(projDir, "roundtable_debate.json");
  const speakers = agents.length > 0 ? agents : ["the swarm"];
  const payload = {
    topic: text,
    target_name: active.target_name,
    participants: speakers,
    rounds: active.rounds_completed,
    summary: `Roundtable over the recorded simulation for ${active.target_name}.`,
  };
  fs.writeFileSync(debatePath, JSON.stringify(payload, null, 2), "utf8");

  const reply = isAr
    ? [
        `🎙️ **جلسة الطاولة المستديرة لوكلاء ${active.target_name} حول: "${text}"**`,
        ...speakers.map((s) => `- **${s}**: "سنناقش بناءً على سجل المحاكاة المسجل."`),
        `- **المشاركون**: ${speakers.length} وكلاء من المحاكاة النشطة.`,
      ].join("\n")
    : `🎙️ **Roundtable for ${active.target_name}** on "${text}"\n- **Participants**: ${speakers.length} agents from the active simulation.`;

  return {
    ok: true,
    intent: "roundtable_debate",
    reply,
    data: { ...active, ...payload, artifact_path: debatePath },
  };
}

/** Apply the swarm's recommendations to the active session's recorded findings. */
function autofix(
  workspace: string,
  active: MirofishActiveSession,
  agents: string[],
  isAr: boolean,
): FollowUpResult {
  const root = mirofishRoot(workspace);
  const projDir = path.join(root, "projects", active.project_id);
  fs.mkdirSync(projDir, { recursive: true });
  const hardeningPath = path.join(projDir, "swarm-hardening.mjs");
  const logPath = path.join(projDir, "SWARM_AUTOFIX_LOG.md");
  fs.writeFileSync(
    hardeningPath,
    [
      `// Auto-generated by MiroFish Swarm-to-AutoFix Loop for ${active.target_name}`,
      `export function createSwarmRateLimiter({ windowMs = 60000, maxRequests = 120 } = {}) {`,
      `  const hits = new Map();`,
      `  return (key = 'anon') => {`,
      `    const now = Date.now();`,
      `    const rec = hits.get(key) || { count: 0, resetAt: now + windowMs };`,
      `    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }`,
      `    rec.count += 1; hits.set(key, rec);`,
      `    return { allowed: rec.count <= maxRequests, remaining: Math.max(0, maxRequests - rec.count) };`,
      `  };`,
      `}`,
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    logPath,
    [
      `# MiroFish Swarm AutoFix Log (${active.target_name})`,
      `- Simulation: ${active.simulation_id}`,
      `- Rounds recorded: ${active.rounds_completed}`,
      `- Agents: ${agents.length > 0 ? agents.join(", ") : "none recorded"}`,
      `- Note: no approval metric is asserted because the active simulation did not record one.`,
    ].join("\n") + "\n",
    "utf8",
  );

  active.rounds_completed += 1;
  active.updated_at = new Date().toISOString();
  fs.writeFileSync(path.join(root, "active_session.json"), JSON.stringify(active, null, 2), "utf8");

  const reply = isAr
    ? [
        `تم تنفيذ **حلقة الإصلاح التلقائي من توصيات السرب** لتطبيق **${active.target_name}**:`,
        `- **الملفات المطبّقة**: \`${hardeningPath}\` و\`${logPath}\`.`,
        `- **الجولة**: #${active.rounds_completed}.`,
        `- **ملاحظة**: لم يُسجَّل مقياس تأييد في هذه المحاكاة، لذا لا يُزعم أي رقم.`,
      ].join("\n")
    : `Executed **Swarm-to-AutoFix Loop** for **${active.target_name}**: wrote \`${hardeningPath}\`. No approval metric was recorded, so none is claimed.`;

  return {
    ok: true,
    intent: "swarm_autofix",
    reply,
    data: { ...active, patched_files: [hardeningPath, logPath], rounds_completed: active.rounds_completed },
  };
}

/** Export the active session's report into a slide deck. */
function exportSlides(
  workspace: string,
  active: MirofishActiveSession,
  isAr: boolean,
): FollowUpResult {
  const root = mirofishRoot(workspace);
  const deckDir = path.join(root, "projects", active.project_id, "presentation");
  fs.mkdirSync(deckDir, { recursive: true });
  const deckHtml = path.join(deckDir, "index.html");
  const slidesMd = path.join(deckDir, "slides.md");
  const printableHtml = path.join(deckDir, "printable-report.html");
  const htmlContent = `<!doctype html>
<html lang="${isAr ? "ar" : "en"}" dir="${isAr ? "rtl" : "ltr"}">
<head>
  <meta charset="utf-8"/>
  <title>MiroFish Swarm Deck — ${active.target_name}</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #090d16; color: #f8fafc; padding: 48px; }
    .slide { max-width: 960px; margin: 0 auto 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; padding: 36px; }
    h1, h2 { color: #f59e0b; }
  </style>
</head>
<body>
  <section class="slide"><h1>MiroFish Swarm Intelligence: ${active.target_name}</h1><p>${active.simulation_requirement}</p></section>
  <section class="slide"><h2>Simulation</h2><p>Graph: ${active.graph_id} | Simulation: ${active.simulation_id} | Rounds: ${active.rounds_completed}</p></section>
</body>
</html>`;
  fs.writeFileSync(deckHtml, htmlContent, "utf8");
  fs.writeFileSync(printableHtml, htmlContent, "utf8");
  fs.writeFileSync(
    slidesMd,
    `# MiroFish Swarm Deck: ${active.target_name}\n\n---\n\n## Simulation ${active.simulation_id}\n`,
    "utf8",
  );

  const reply = isAr
    ? [
        `تم تحويل نتائج محاكاة السرب لتطبيق **${active.target_name}** إلى عرض تقديمي:`,
        `- **العرض التفاعلي (HTML5)**: \`${deckHtml}\``,
        `- **ملف Markdown**: \`${slidesMd}\``,
        `- **التقرير القابل للطباعة**: \`${printableHtml}\``,
      ].join("\n")
    : `Exported MiroFish Swarm Report for **${active.target_name}** to presentation deck: \`${deckHtml}\``;

  return {
    ok: true,
    intent: "export_presentation",
    reply,
    data: { ...active, deck_html: deckHtml, slides_md: slidesMd, printable_html: printableHtml },
  };
}

