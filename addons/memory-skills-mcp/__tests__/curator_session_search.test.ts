import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Curator, DEFAULT_CURATOR_CONFIG, type CuratorConfig } from "../src/curator.js";
import { openDatabase, rebuildEpisodeTrigram, runStatement, type Db, type Row } from "../src/db.js";
import { Embedder } from "../src/embed.js";
import { Episodes } from "../src/episodes.js";
import { escapeLike, sanitizeQuery } from "../src/search.js";
import { SessionSearch, searchSessions } from "../src/session_search.js";
import { Skills } from "../src/skills.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-22T12:00:00.000Z");

function tmpDb(): { db: Db; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memskills-test-"));
  const file = path.join(dir, "test.db");
  return { db: openDatabase(file), file, dir };
}

function iso(daysAgo: number, base: Date = NOW): string {
  return new Date(base.getTime() - daysAgo * DAY).toISOString();
}

function seedSkill(
  db: Db,
  opts: { slug: string; daysAgo?: number; pinned?: boolean; tags?: string[]; state?: string },
): void {
  const created = iso(opts.daysAgo ?? 0);
  runStatement(
    db,
    `INSERT INTO skills (slug, name, description, path, created_at, updated_at, uses, last_used, tags, pinned, lifecycle_state)
     VALUES (?, ?, '', ?, ?, ?, 0, ?, ?, ?, ?)`,
    opts.slug,
    opts.slug,
    `/skills/${opts.slug}`,
    created,
    created,
    created,
    JSON.stringify(opts.tags ?? []),
    opts.pinned ? 1 : 0,
    opts.state ?? "active",
  );
}

function stateOf(db: Db, slug: string): string {
  const row = db.prepare(`SELECT lifecycle_state FROM skills WHERE slug = ?`).get(slug) as Row | undefined;
  return String(row?.["lifecycle_state"] ?? "missing");
}

function skillCount(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM skills`).get() as Row;
  return Number(row["c"] ?? 0);
}

test("lifecycle transitions active -> stale -> archived by inactivity", () => {
  const { db } = tmpDb();
  try {
    seedSkill(db, { slug: "active-skill", daysAgo: 1 });
    seedSkill(db, { slug: "stale-skill", daysAgo: 15 });
    seedSkill(db, { slug: "archived-skill", daysAgo: 31 });
    const curator = new Curator(db, DEFAULT_CURATOR_CONFIG, { clock: () => NOW });
    const res = curator.runLifecycle(NOW);
    assert.equal(stateOf(db, "active-skill"), "active");
    assert.equal(stateOf(db, "stale-skill"), "stale");
    assert.equal(stateOf(db, "archived-skill"), "archived");
    assert.deepEqual(res.states, { active: 1, stale: 1, archived: 1 });
    assert.equal(res.updated, 3);
  } finally {
    db.close();
  }
});

test("pinned skills are exempt from lifecycle transitions", () => {
  const { db } = tmpDb();
  try {
    seedSkill(db, { slug: "pinned-old", daysAgo: 60, pinned: true });
    const curator = new Curator(db, DEFAULT_CURATOR_CONFIG, { clock: () => NOW });
    const res = curator.runLifecycle(NOW);
    assert.equal(stateOf(db, "pinned-old"), "active");
    assert.equal(res.skipped, 1);
    assert.equal(res.updated, 0);
  } finally {
    db.close();
  }
});

test("skills referenced by scheduled jobs are exempt", () => {
  const { db } = tmpDb();
  try {
    seedSkill(db, { slug: "cron-tagged", daysAgo: 60, tags: ["scheduled-job"] });
    seedSkill(db, { slug: "cron-referenced", daysAgo: 60 });
    const curator = new Curator(db, DEFAULT_CURATOR_CONFIG, {
      clock: () => NOW,
      exemptScheduledSlugs: () => ["cron-referenced"],
    });
    const res = curator.runLifecycle(NOW);
    assert.equal(stateOf(db, "cron-tagged"), "active");
    assert.equal(stateOf(db, "cron-referenced"), "active");
    assert.equal(res.skipped, 2);
  } finally {
    db.close();
  }
});

test("the curator archives but never deletes skills", () => {
  const { db } = tmpDb();
  try {
    seedSkill(db, { slug: "doomed", daysAgo: 90 });
    const before = skillCount(db);
    const curator = new Curator(db, DEFAULT_CURATOR_CONFIG, { clock: () => NOW });
    curator.runLifecycle(NOW);
    assert.equal(skillCount(db), before, "no skill may be deleted");
    assert.equal(stateOf(db, "doomed"), "archived");
    const row = db.prepare(`SELECT slug FROM skills WHERE slug = 'doomed'`).get();
    assert.ok(row, "archived skill remains recoverable");
  } finally {
    db.close();
  }
});

test("inactivity trigger respects idle hours and the last-run window", () => {
  const { db } = tmpDb();
  try {
    const curator = new Curator(db, DEFAULT_CURATOR_CONFIG, { clock: () => NOW });
    assert.equal(curator.shouldRun({ idleMs: 3 * 3_600_000, now: NOW }), true, "idle > 2h and never ran");
    assert.equal(curator.shouldRun({ idleMs: 3_600_000, now: NOW }), false, "idle < 2h");

    curator.recordInactivityCheckRun(NOW);
    assert.equal(curator.shouldRun({ idleMs: 3 * 3_600_000, now: NOW }), false, "ran recently");

    curator.recordInactivityCheckRun(new Date(NOW.getTime() - 8 * DAY));
    assert.equal(curator.shouldRun({ idleMs: 3 * 3_600_000, now: NOW }), true, "idle and last run > 7d");
  } finally {
    db.close();
  }
});

test("query sanitizer caps length, strips FTS operators and preserves Arabic", () => {
  assert.equal(sanitizeQuery('test "special" chars* (x) ^y').replace(/\s+/g, " "), "test special chars x y");
  assert.equal(sanitizeQuery("a".repeat(3000)).length, 2048);
  assert.equal(sanitizeQuery(""), "");
  assert.ok(sanitizeQuery("اختبار البحث").includes("اختبار"));
  assert.ok(sanitizeQuery("测试搜索").includes("测试"));
  assert.equal(escapeLike("100%_x"), "100\\%\\_x");
});

test("session search ranks FTS matches and highlights snippets", async () => {
  const { db } = tmpDb();
  try {
    const episodes = new Episodes(db, new Embedder());
    await episodes.record({
      goal: "Install Playwright Chromium on Windows",
      outcome: "success",
      summary: "Installed the browser with npx playwright install chromium.",
      lessons: ["Set PLAYWRIGHT_BROWSERS_PATH first"],
      tools: ["shell"],
      tags: ["setup"],
    });
    await episodes.record({
      goal: "Deploy to Netlify",
      outcome: "failed",
      summary: "Upload failed because the API token had been revoked.",
      lessons: ["Check the token first"],
      tools: ["shell"],
      tags: ["deploy"],
    });

    const search = new SessionSearch(db);
    const hits = await search.search("playwright", 10);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.goal, /Playwright/);
    assert.ok(hits[0]!.snippet.includes("<mark>"), "snippet highlights the match");
    assert.ok(hits[0]!.score > 0);

    const ranked = await search.search("deploy", 10);
    assert.ok(ranked.length >= 1);
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1]!.score >= ranked[i]!.score, "results are bm25-ordered");
    }
  } finally {
    db.close();
  }
});

test("session search finds Arabic text", async () => {
  const { db } = tmpDb();
  try {
    const episodes = new Episodes(db, new Embedder());
    await episodes.record({
      goal: "اختبار باللغة العربية",
      outcome: "success",
      summary: "تم التثبيت بنجاح",
      lessons: ["درس عربي"],
      tags: ["arabic"],
    });
    const search = new SessionSearch(db);
    const hits = await search.search("اختبار", 10);
    assert.ok(hits.some((h) => h.goal.includes("اختبار")), "Arabic query matches");
  } finally {
    db.close();
  }
});

test("trigram fallback matches CJK substrings", async () => {
  const { db } = tmpDb();
  try {
    const episodes = new Episodes(db, new Embedder());
    const res = await episodes.record({
      goal: "配置测试搜索功能",
      outcome: "success",
      summary: "完成了配置",
      tags: ["cjk"],
    });
    const search = new SessionSearch(db);
    assert.equal(search.usesTrigram, true, "this SQLite build has the trigram tokenizer");
    const hits = await search.search("测试搜索", 10);
    assert.ok(hits.some((h) => h.id === res.id), "substring found via trigram");
    assert.equal(hits[0]!.source, "trigram");
  } finally {
    db.close();
  }
});

test("LIKE fallback handles short substrings when trigram is skipped", async () => {
  const { db } = tmpDb();
  try {
    const episodes = new Episodes(db, new Embedder());
    const res = await episodes.record({
      goal: "Run xray diagnostics",
      outcome: "success",
      summary: "xray reported clean",
      tags: ["diag"],
    });
    const search = new SessionSearch(db);
    const hits = await search.search("ra", 10);
    assert.ok(hits.some((h) => h.id === res.id), "LIKE fallback finds the substring");
    assert.equal(hits[0]!.source, "like");
  } finally {
    db.close();
  }
});

test("searchSessions server helper returns hits", async () => {
  const { db } = tmpDb();
  try {
    const episodes = new Episodes(db, new Embedder());
    await episodes.record({ goal: "Search helper smoke", outcome: "success", summary: "helper works", tags: [] });
    const hits = await searchSessions(db, "helper", 5);
    assert.ok(hits.length >= 1);
  } finally {
    db.close();
  }
});

test("self-made skills loop stages a proposal after enough tool calls", async () => {
  const { db } = tmpDb();
  try {
    const trace = {
      name: "gh-login",
      actions: [
        { op: "goto", url: "https://github.com/login", ok: true },
        { op: "TYPE_TEXT", index: 3, text: "octocat", ok: true },
        { op: "CLICK", index: 9, ok: true },
      ],
    };
    const curator = new Curator(db, DEFAULT_CURATOR_CONFIG, { clock: () => NOW });

    const below = await curator.proposeSkill({ trace, toolCallCount: 4 }, { writeApproval: true });
    assert.equal(below.proposed, false, "below the threshold nothing is proposed");

    const staged = await curator.proposeSkill({ trace, toolCallCount: 6 }, { writeApproval: true });
    assert.equal(staged.proposed, true);
    assert.equal(staged.staged, true);
    assert.ok(staged.slug && staged.slug.length > 0);
    assert.equal(curator.listStaged().length, 1);
    assert.match(curator.listStaged()[0]!.body, /## Procedure/);

    const failed = await curator.proposeSkill({ trace, toolCallCount: 6, outcome: "failed" }, { writeApproval: true });
    assert.equal(failed.proposed, false, "only successful tasks propose skills");
  } finally {
    db.close();
  }
});

test("self-made skills loop applies directly when writeApproval is off", async () => {
  const { db } = tmpDb();
  try {
    let captured: { name: string; body: string } | null = null;
    const writer = {
      record: async (input: { name: string; description: string; body: string }) => {
        captured = input;
        return { slug: "gh-login", path: "/skills/gh-login/SKILL.md", version: 1, action: "created" };
      },
    };
    const curator = new Curator(db, DEFAULT_CURATOR_CONFIG, { clock: () => NOW, skills: writer });
    const trace = { name: "gh-login", actions: [{ op: "goto", url: "https://example.com", ok: true }] };
    const res = await curator.proposeSkill({ trace, toolCallCount: 5 }, { writeApproval: false });
    assert.equal(res.proposed, true);
    assert.equal(res.staged, false);
    assert.equal(res.slug, "gh-login");
    assert.ok(captured, "skill writer received the proposal");
    assert.match(captured!.body, /## When to Use/);
  } finally {
    db.close();
  }
});

test("LLM consolidation is a stub disabled by default", async () => {
  const { db } = tmpDb();
  try {
    seedSkill(db, { slug: "stale-a", daysAgo: 40, state: "stale" });
    const off = new Curator(db, DEFAULT_CURATOR_CONFIG, { clock: () => NOW });
    const disabled = await off.consolidate({ now: NOW });
    assert.equal(disabled.run, false);
    assert.match(disabled.message, /disabled/i);

    const on = new Curator(db, { ...DEFAULT_CURATOR_CONFIG, consolidate: true }, { clock: () => NOW });
    const enabled = await on.consolidate({ now: NOW });
    assert.equal(enabled.run, true);
    assert.equal(enabled.planned, 1);
  } finally {
    db.close();
  }
});

test("reading a skill tracks reads and last_read_at", async () => {
  const { db } = tmpDb();
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "memskills-skills-"));
  try {
    const skills = new Skills(db, new Embedder(), skillsDir);
    await skills.record({ name: "demo-skill", description: "demo", body: "## Procedure\n1. do it" });
    await skills.get("demo-skill");
    const row = db.prepare(`SELECT reads, last_read_at FROM skills WHERE slug = 'demo-skill'`).get() as Row;
    assert.equal(Number(row["reads"]), 1);
    assert.ok(String(row["last_read_at"] ?? "").length > 0);
  } finally {
    db.close();
  }
});

test("rebuildEpisodeTrigram reindexes existing episodes", () => {
  const { db } = tmpDb();
  try {
    runStatement(
      db,
      `INSERT INTO episodes (id, created_at, goal, outcome, summary, lessons, tools, tags)
       VALUES ('ep_x', ?, ' Deploy to Netlify ', 'failed', 'token revoked', '[]', '[]', '[]')`,
      NOW.toISOString(),
    );
    runStatement(db, `INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')`);
    const indexed = rebuildEpisodeTrigram(db);
    assert.equal(indexed, 1);
    const tri = db.prepare(`SELECT COUNT(*) AS c FROM episodes_trigram`).get() as Row;
    assert.equal(Number(tri["c"]), 1, "trigram index was repopulated");
  } finally {
    db.close();
  }
});
