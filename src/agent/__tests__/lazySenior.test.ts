/**
 * lazy-senior (Ponytail BUILD_SPEC P2) acceptance: the prompt snapshot differs
 * per level, and `off` is byte-identical to the baseline (no block injected).
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import {
  chatCommandPrompt,
  clearSessionLevel,
  isBuildToolset,
  lazySeniorBlock,
  lazyLevelAnnouncement,
  normalizeLazySeniorLevel,
  parseChatCommand,
  parseLazyCommand,
  resolveLazySeniorLevel,
  setSessionLevel,
} from "../lazySenior.js";
import { buildSystemPrompt } from "../prompt.js";
import type { Config } from "../../config.js";

const cfg = {
  workspace: "/tmp/task",
  policy: { networkEnabled: false },
} as unknown as Config;

/** A build-mode toolset: write pair plus the build-only marker. */
const BUILD_TOOLS = ["file_read", "file_write", "file_edit", "shell_run", "code_session", "preview_serve", "finish"];
/** Research-like: writes but no build marker. */
const RESEARCH_TOOLS = ["file_read", "file_write", "web_search", "finish"];
/** Read-only ask mode. */
const ASK_TOOLS = ["file_read", "file_list", "finish"];

describe("parseLazyCommand", () => {
  it("accepts the level words case-insensitively", () => {
    assert.equal(parseLazyCommand("/lazy lite"), "lite");
    assert.equal(parseLazyCommand("/lazy ULTRA "), "ultra");
    assert.equal(parseLazyCommand("/lazy off"), "off");
  });
  it("rejects everything that is not a complete level command", () => {
    assert.equal(parseLazyCommand("/lazy"), null);
    assert.equal(parseLazyCommand("/lazy strong"), null);
    assert.equal(parseLazyCommand("lazy full"), null);
    assert.equal(parseLazyCommand("/lazy full please"), null);
  });
  it("normalizes raw values", () => {
    assert.equal(normalizeLazySeniorLevel("FULL"), "full");
    assert.equal(normalizeLazySeniorLevel(42), null);
  });
});

describe("resolveLazySeniorLevel", () => {
  it("defaults to full and lets the session override win", () => {
    const session = "sess-lazy-test";
    assert.equal(resolveLazySeniorLevel(session), "full");
    setSessionLevel(session, "lite");
    assert.equal(resolveLazySeniorLevel(session), "lite");
    assert.equal(resolveLazySeniorLevel("other-session"), "full");
    clearSessionLevel(session);
    assert.equal(resolveLazySeniorLevel(session), "full");
  });
});

describe("isBuildToolset", () => {
  it("accepts build and App Builder toolsets only", () => {
    assert.equal(isBuildToolset(BUILD_TOOLS), true);
    assert.equal(isBuildToolset(["file_write", "file_edit", "app_task_create", "finish"]), true);
    assert.equal(isBuildToolset(RESEARCH_TOOLS), false);
    assert.equal(isBuildToolset(ASK_TOOLS), false);
  });
});

describe("lazySeniorBlock", () => {
  it("injects nothing for off or a non-build toolset", () => {
    assert.equal(lazySeniorBlock("off", BUILD_TOOLS), null);
    assert.equal(lazySeniorBlock("full", RESEARCH_TOOLS), null);
    assert.equal(lazySeniorBlock("full", ASK_TOOLS), null);
  });
  it("differs per level and carries the decision-order pointer", () => {
    const full = lazySeniorBlock("full", BUILD_TOOLS)!;
    const lite = lazySeniorBlock("lite", BUILD_TOOLS)!;
    const ultra = lazySeniorBlock("ultra", BUILD_TOOLS)!;
    assert.match(full, /8\.0 Decision order/);
    assert.match(full, /before §8\.1/);
    assert.match(full, /ladder/);
    assert.match(full, /Skipped: <what was left out>/);
    assert.match(full, /shortcut: <limit>, <when to upgrade>/);
    assert.notEqual(full, lite);
    assert.notEqual(lite, ultra);
    assert.notEqual(full, ultra);
    assert.match(lite, /name the smaller option/);
    assert.match(ultra, /push back once/);
  });
});

describe("buildSystemPrompt lazy-senior wiring", () => {
  it("injects the block for a build toolset and changes with the level", () => {
    // No session override yet: the durable default (full) applies.
    const base = buildSystemPrompt(cfg, [], BUILD_TOOLS, [], undefined, undefined, undefined, "add a field", "sess-p2");
    assert.match(base, /8\.0 Decision order \(lazy-senior, level: full\)/);
    setSessionLevel("sess-p2", "lite");
    const litePrompt = buildSystemPrompt(cfg, [], BUILD_TOOLS, [], undefined, undefined, undefined, "add a field", "sess-p2");
    setSessionLevel("sess-p2", "ultra");
    const ultraPrompt = buildSystemPrompt(cfg, [], BUILD_TOOLS, [], undefined, undefined, undefined, "add a field", "sess-p2");
    clearSessionLevel("sess-p2");
    assert.match(litePrompt, /level: lite\)/);
    assert.notEqual(litePrompt, base);
    assert.notEqual(litePrompt, ultraPrompt);
    // A non-build toolset never carries the block.
    const askPrompt = buildSystemPrompt(cfg, [], ASK_TOOLS, [], undefined, undefined, undefined, "explain", "sess-p2");
    assert.doesNotMatch(askPrompt, /lazy-senior, level/);
  });
  it("T6: off gives a prompt byte-identical to the baseline with the block stripped", () => {
    setSessionLevel("sess-off", "off");
    const off = buildSystemPrompt(cfg, [], BUILD_TOOLS, [], undefined, undefined, undefined, "add a field", "sess-off");
    assert.doesNotMatch(off, /lazy-senior, level/);
    setSessionLevel("sess-off", "full");
    const full = buildSystemPrompt(cfg, [], BUILD_TOOLS, [], undefined, undefined, undefined, "add a field", "sess-off");
    clearSessionLevel("sess-off");
    // off == the full-level prompt minus exactly the injected block and the
    // end-of-prompt tail line, so the level adds nothing else.
    const stripped = full
      .replace(/\n### 8\.0 Decision order \(lazy-senior[\s\S]*?existing tests\.\n/, "\n")
      .replace(/\nlazy-senior \(full\) pre-finish:[^\n]*/, "");
    assert.equal(off, stripped);
    const askBaseline = buildSystemPrompt(cfg, [], ASK_TOOLS, [], undefined, undefined, undefined, "explain", "sess-off-2");
    const askSession = buildSystemPrompt(cfg, [], ASK_TOOLS, [], undefined, undefined, undefined, "explain", "sess-off-3");
    assert.equal(askBaseline, askSession);
  });
});

describe("lazyLevelAnnouncement", () => {
  it("answers in the user's language without inventing persistence", () => {
    const text = lazyLevelAnnouncement("lite");
    assert.match(text, /lite/);
    assert.match(text, /الجلسة/);
    const off = lazyLevelAnnouncement("off");
    assert.match(off, /off/);
  });
});

describe("parseChatCommand (P3)", () => {
  it("keeps routing /lazy to the level command", () => {
    assert.deepEqual(parseChatCommand("/lazy ultra"), { kind: "lazy", level: "ultra" });
  });
  it("parses /review with and without a target", () => {
    assert.deepEqual(parseChatCommand("/review"), { kind: "review", target: undefined });
    assert.deepEqual(parseChatCommand("/review src/agent/prompt.ts"), { kind: "review", target: "src/agent/prompt.ts" });
    assert.deepEqual(parseChatCommand("/REVIEW feat/x..main"), { kind: "review", target: "feat/x..main" });
  });
  it("parses /audit with and without a target", () => {
    assert.deepEqual(parseChatCommand("/audit"), { kind: "audit", target: undefined });
    assert.deepEqual(parseChatCommand("/audit bench/"), { kind: "audit", target: "bench/" });
  });
  it("returns null for anything else, including slash-adjacent text", () => {
    assert.equal(parseChatCommand("/reviewme"), null);
    assert.equal(parseChatCommand("/auditx y"), null);
    assert.equal(parseChatCommand("please /review this"), null);
    assert.equal(parseChatCommand("build me a form"), null);
  });
});

describe("chatCommandPrompt (P3)", () => {
  it("review prompt defaults to the uncommitted changes and carries the report structure", () => {
    const prompt = chatCommandPrompt({ kind: "review", target: undefined });
    assert.match(prompt, /uncommitted changes/);
    assert.match(prompt, /correct, safe, holds under load, tested, fast, lean/);
    assert.match(prompt, /Must\/Should\/Nice/);
    assert.match(prompt, /what was not read/);
  });
  it("review prompt names an explicit target", () => {
    assert.match(chatCommandPrompt({ kind: "review", target: "pkg/a.ts" }), /pkg\/a\.ts/);
  });
  it("audit prompt enforces read-only and the fix-first + unread structure", () => {
    const prompt = chatCommandPrompt({ kind: "audit", target: undefined });
    assert.match(prompt, /strictly read-only/);
    assert.match(prompt, /fix first:/);
    assert.match(prompt, /unread list/);
    assert.match(chatCommandPrompt({ kind: "audit", target: "src/tools" }), /src\/tools/);
  });
});
