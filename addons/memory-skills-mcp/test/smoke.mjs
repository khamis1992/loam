import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "server.cjs");
if (!fs.existsSync(serverPath)) {
  console.error(`missing ${serverPath} — run: npm run build:memory-skills`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memskills-smoke-"));
const dataDir = path.join(tmp, "data");
const skillsDir = path.join(tmp, "skills");
const workspace = path.join(tmp, "workspace");
for (const dir of [dataDir, skillsDir, workspace]) fs.mkdirSync(dir, { recursive: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const env = { ...process.env, MEMSKILLS_DATA_DIR: dataDir, MEMSKILLS_SKILLS_DIR: skillsDir, MEMSKILLS_WORKSPACE: workspace };
delete env.MEMSKILLS_OLLAMA_URL;
delete env.MEMSKILLS_EMBED_MODEL;
delete env.MANUS_LOCAL_DATA_DIR;
delete env.MANUS_LOCAL_SKILLS_DIR;

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" });
const stderrLines = [];
transport.stderr?.on("data", (d) => stderrLines.push(String(d)));

const client = new Client({ name: "memskills-smoke", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c))).join("\n");
  return { text, isError: res.isError === true };
}

try {
  const tools = (await client.listTools()).tools;
  const names = new Set(tools.map((t) => t.name));
  check("tools/list advertises 17 tools", tools.length === 17, `got ${tools.length}: ${[...names].join(",")}`);
  check(
    "expected tool names present",
    ["recall", "episode_record", "episode_search", "episode_get", "episode_stats", "fact_remember", "fact_search", "fact_forget", "skill_record", "skill_search", "skill_get", "skill_report", "skill_improve", "skill_review", "skill_compose", "skill_from_trace", "dashboard"].every((n) => names.has(n)),
  );

  const ep1 = await call("episode_record", {
    goal: "Install Playwright Chromium on Windows",
    outcome: "success",
    summary: "Installed the browser with npx playwright install chromium after pointing PLAYWRIGHT_BROWSERS_PATH to the workspace drive.",
    lessons: ["Set PLAYWRIGHT_BROWSERS_PATH before install to avoid filling the system drive"],
    tools: ["shell"],
    tags: ["setup", "browser"],
    duration_ms: 90000,
  });
  check("episode_record stores episode 1", /recorded episode ep_[a-z0-9]+/i.test(ep1.text) && !ep1.isError, ep1.text);
  const ep1Id = /recorded episode (\S+)/.exec(ep1.text)?.[1] ?? "";

  const ep2 = await call("episode_record", {
    goal: "Publish static site to Netlify",
    outcome: "failed",
    summary: "Upload failed because the API token had been revoked; the site was never published.",
    lessons: ["Check the Netlify token before starting the deploy"],
    tools: ["shell", "web_fetch"],
    tags: ["deploy"],
  });
  check("episode_record stores episode 2", !ep2.isError, ep2.text);

  const search1 = await call("episode_search", { query: "playwright chromium" });
  check("episode_search finds the playwright episode", search1.text.includes(ep1Id) && search1.text.includes("success"));

  const search2 = await call("episode_search", { query: "deploy", outcome: "failed" });
  check("episode_search filters by failed outcome", search2.text.includes("Netlify") && !search2.text.includes(ep1Id));

  const got = await call("episode_get", { id: ep1Id });
  let gotJson = null;
  try {
    gotJson = JSON.parse(got.text);
  } catch {
    /* fall through */
  }
  check("episode_get returns full episode json", gotJson?.id === ep1Id && Array.isArray(gotJson?.lessons) && gotJson.lessons.length === 1);

  const stats = await call("episode_stats", {});
  check("episode_stats reports totals", stats.text.includes("2 total") && stats.text.includes("success=1") && stats.text.includes("failed=1"), stats.text);

  const dup1 = await call("episode_record", { goal: "duplicate check", outcome: "success", summary: "first write for task_dup_1", task_id: "task_dup_1" });
  const dup2 = await call("episode_record", { goal: "duplicate check", outcome: "success", summary: "second write for task_dup_1", task_id: "task_dup_1" });
  check(
    "episode_record dedupes repeated task_id",
    dup1.text.includes("recorded episode") && dup2.text.includes("already recorded") && dup2.text.includes(dup1.text.match(/ep_[a-z0-9]+/)?.[0] ?? "nomatch"),
    `${dup1.text} | ${dup2.text}`,
  );

  const f1 = await call("fact_remember", { text: "The user's default code editor is VS Code.", kind: "preference", tags: ["env"] });
  check("fact_remember inserts", !f1.isError && /stored fact fact_/.test(f1.text), f1.text);
  const f2 = await call("fact_remember", { text: "The user's default code editor is VS Code.", kind: "preference" });
  check("fact_remember dedupes exact duplicate", f2.text.includes("replaced existing entry"), f2.text);
  const fsearch = await call("fact_search", { query: "editor" });
  check("fact_search finds the fact", fsearch.text.includes("VS Code"));
  const ff = await call("fact_forget", { text: "The user's default code editor is VS Code." });
  check("fact_forget deletes", ff.text.includes("forgot 1"), ff.text);

  const skillBody = [
    "## When to Use",
    "Use when a browser is missing for Playwright automation on Windows.",
    "",
    "## Procedure",
    "1. Confirm Node.js is installed and recent (node --version).",
    "2. Set the environment variable PLAYWRIGHT_BROWSERS_PATH to a drive with free space.",
    "3. Run npx playwright install chromium and wait for the download to finish.",
    "4. Verify the browser launches with a tiny script before moving on.",
    "",
    "## Pitfalls",
    "- The default cache path can fill the system drive.",
    "",
    "## Verification",
    "- A Playwright page.goto to about:blank succeeds.",
  ].join("\n");
  const sk1 = await call("skill_record", {
    name: "windows-playwright-setup",
    description: "Prepare Playwright Chromium on Windows without filling the system drive.",
    body: skillBody,
    tags: ["browser", "setup"],
  });
  const skillFile = path.join(skillsDir, "windows-playwright-setup", "SKILL.md");
  check("skill_record creates SKILL.md on disk", !sk1.isError && fs.existsSync(skillFile), sk1.text);

  const skSearch = await call("skill_search", { query: "playwright browser install" });
  check("skill_search finds the skill", skSearch.text.includes("windows-playwright-setup"), skSearch.text);

  const report1 = await call("skill_report", {
    name: "windows-playwright-setup",
    outcome: "failure",
    notes: "Chromium download stalled behind the corporate proxy; had to set HTTPS_PROXY first.",
  });
  check("skill_report records failure + hint", report1.text.includes("skill_improve") && report1.text.includes("uses=1"), report1.text);

  const review1 = await call("skill_review", {});
  check("skill_review lists the failure note", review1.text.includes("windows-playwright-setup") && review1.text.includes("unreviewed"), review1.text);

  const improve = await call("skill_improve", { name: "windows-playwright-setup" });
  check("skill_improve bumps version and merges lesson", improve.text.includes("v2") && improve.text.includes("proxy"), improve.text);

  const got2 = await call("skill_get", { name: "windows-playwright-setup" });
  check(
    "skill_get shows merged lessons + history",
    got2.text.includes("Lessons & Fixes") && got2.text.includes("HTTPS_PROXY") && /history: v1_/.test(got2.text),
    got2.text.slice(0, 400),
  );

  const review2 = await call("skill_review", {});
  check("skill_review is clean after improvement", review2.text.includes("healthy"), review2.text);

  const report2 = await call("skill_report", { name: "windows-playwright-setup", outcome: "success" });
  check("skill_report success updates rate", report2.text.includes("50%"), report2.text);

  const compose = await call("skill_compose", { goal: "prepare playwright chromium for a new machine" });
  check(
    "skill_compose builds an ordered plan from the skill",
    compose.text.includes("## Plan:") && compose.text.includes("← windows-playwright-setup") && compose.text.includes("1. "),
    compose.text.slice(0, 400),
  );

  const traceDir = path.join(workspace, ".browser-recordings");
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(
    path.join(traceDir, "gh-login.json"),
    JSON.stringify({
      name: "gh-login",
      startedAt: new Date().toISOString(),
      stoppedAt: new Date().toISOString(),
      actions: [
        { at: new Date().toISOString(), op: "goto", ok: true, message: "", url: "https://github.com/login" },
        { at: new Date().toISOString(), op: "TYPE_TEXT", index: 3, text: "octocat", ok: true, message: "", url: "https://github.com/login" },
        { at: new Date().toISOString(), op: "CLICK", index: 9, ok: false, message: "stale element index", url: "https://github.com/login" },
      ],
    }),
    "utf8",
  );
  const fromTrace = await call("skill_from_trace", { trace_path: "gh-login.json" });
  check(
    "skill_from_trace converts a recording into a draft skill",
    !fromTrace.isError && fromTrace.text.includes("capturedSteps") === false && fromTrace.text.includes("3 steps") && fromTrace.text.includes("FAILED: stale element index"),
    fromTrace.text.slice(0, 500),
  );
  const traceFile = path.join(skillsDir, "gh-login", "SKILL.md");
  check("trace draft landed on disk", fs.existsSync(traceFile) && fs.readFileSync(traceFile, "utf8").includes("## Procedure"));

  const recall = await call("recall", { goal: "install playwright and log into github" });
  check(
    "recall returns episodes, facts and skills sections together",
    recall.text.includes("episodic memory") && recall.text.includes("procedural memory"),
    recall.text.slice(0, 400),
  );

  const dash = await call("dashboard", {});
  let dashJson = null;
  try {
    dashJson = JSON.parse(dash.text);
  } catch {
    /* fall through */
  }
  check(
    "dashboard returns parseable JSON with all sections",
    Boolean(dashJson && dashJson.stats && Array.isArray(dashJson.episodes) && Array.isArray(dashJson.facts) && Array.isArray(dashJson.skills) && Array.isArray(dashJson.review)) &&
      dashJson.episodes.length > 0 &&
      dashJson.skills.length > 0,
    dash.text.slice(0, 200),
  );

  const bad = await call("skill_get", { name: "does-not-exist" });
  check("missing skill is a clean error", bad.isError === true && bad.text.includes("not found"), bad.text);
} catch (err) {
  failed += 1;
  console.log(`FAIL  unexpected exception — ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  await client.close();
}

try {
  const appData = path.join(tmp, "appdata");
  const appDataSkills = path.join(appData, "skills");
  const appDataData = path.join(appData, "data");
  fs.mkdirSync(path.join(appDataSkills, "handbook-note"), { recursive: true });
  fs.writeFileSync(
    path.join(appDataSkills, "handbook-note", "SKILL.md"),
    "---\nname: handbook-note\ndescription: Note taking skill stored in the app data skills dir.\n---\n\n## Procedure\n1. Write the note down.\n",
    "utf8",
  );
  const env2 = { ...process.env, MANUS_LOCAL_DATA_DIR: appDataData, MANUS_LOCAL_SKILLS_DIR: appDataSkills };
  delete env2.MEMSKILLS_DATA_DIR;
  delete env2.MEMSKILLS_SKILLS_DIR;
  delete env2.MEMSKILLS_OLLAMA_URL;
  delete env2.MEMSKILLS_EMBED_MODEL;
  const transport2 = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: env2, stderr: "pipe" });
  const client2 = new Client({ name: "memskills-smoke-2", version: "0.1.0" }, { capabilities: {} });
  await client2.connect(transport2);
  const found = await client2.callTool({ name: "skill_search", arguments: { query: "note taking" } });
  const text = (found.content ?? []).map((c) => c.text ?? "").join("\n");
  check("MANUS_LOCAL_SKILLS_DIR is honored (packaged-app path)", text.includes("handbook-note"), text);
  check("db lands under MANUS_LOCAL_DATA_DIR", fs.existsSync(path.join(appDataData, "memory-skills", "memory-skills.db")));
  await client2.close();
} catch (err) {
  failed += 1;
  console.log(`FAIL  env-inheritance phase — ${err instanceof Error ? err.message : String(err)}`);
}

if (stderrLines.length > 0) {
  console.log(`\nserver stderr (${stderrLines.length} chunk(s)):\n${stderrLines.join("").trim().slice(0, 1500)}`);
}
console.log(`\n${failed === 0 ? "SMOKE OK" : "SMOKE FAILED"}: ${passed} passed, ${failed} failed — data ${tmp}`);
process.exit(failed === 0 ? 0 : 1);
