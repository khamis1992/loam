import test from "node:test";
import assert from "node:assert";
import {
  buildPermissionRuleSet,
  evaluatePermissionRules,
  evaluateToolPermission,
  globToRegExp,
  isPermissionAction,
  matchGlob,
  parsePermissionRulePattern,
} from "../permissionRules.js";

type RawRuleLists = Partial<Record<"allow" | "deny" | "ask", readonly string[]>>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parse: bare tool name means any arguments", () => {
  const r = parsePermissionRulePattern("file_read");
  assert.deepStrictEqual(r, { ok: true, value: { tool: "file_read", pattern: null } });
});

test("parse: empty parentheses mean any arguments", () => {
  const r = parsePermissionRulePattern("file_read()");
  assert.deepStrictEqual(r, { ok: true, value: { tool: "file_read", pattern: null } });
});

test("parse: tool with a glob pattern", () => {
  const r = parsePermissionRulePattern("shell_run(npm test*)");
  assert.deepStrictEqual(r, { ok: true, value: { tool: "shell_run", pattern: "npm test*" } });
});

test("parse: tool names are lower-cased", () => {
  const r = parsePermissionRulePattern("Shell_Run(npm test*)");
  assert.deepStrictEqual(r, { ok: true, value: { tool: "shell_run", pattern: "npm test*" } });
});

test("parse: MCP-style tool names are accepted", () => {
  const r = parsePermissionRulePattern("mcp__github__create_issue(repo:*)");
  assert.deepStrictEqual(r, {
    ok: true,
    value: { tool: "mcp__github__create_issue", pattern: "repo:*" },
  });
});

test("parse: rejects malformed rules", () => {
  for (const bad of ["", "   ", "shell_run(npm test*", "shell_run)", "(npm test*)", "bad name(x)", "a)b(c)"]) {
    const r = parsePermissionRulePattern(bad);
    assert.strictEqual(r.ok, false, `expected "${bad}" to be rejected`);
    if (!r.ok) assert.ok(r.error.length > 0);
  }
});

test("isPermissionAction validates the three actions", () => {
  for (const a of ["allow", "deny", "ask"]) assert.equal(isPermissionAction(a), true, a);
  for (const a of ["", "ALLOW", "block", null, 1]) assert.equal(isPermissionAction(a), false, String(a));
});

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

test("glob: * matches any run of characters including spaces", () => {
  assert.equal(matchGlob("npm test -- --watch", "npm test*"), true);
  assert.equal(matchGlob("npm test", "npm test*"), true);
  assert.equal(matchGlob("npm run build", "npm test*"), false);
  assert.equal(matchGlob("anything", "*"), true);
  assert.equal(matchGlob("", "*"), true);
});

test("glob: ? matches exactly one character", () => {
  assert.equal(matchGlob("cat", "c?t"), true);
  assert.equal(matchGlob("coat", "c?t"), false);
  assert.equal(matchGlob("ct", "c?t"), false);
});

test("glob: character sets and ranges", () => {
  assert.equal(matchGlob("file1.txt", "file[0-9].txt"), true);
  assert.equal(matchGlob("filea.txt", "file[0-9].txt"), false);
  assert.equal(matchGlob("filex.txt", "file[!0-9].txt"), true);
  assert.equal(matchGlob("file5.txt", "file[!0-9].txt"), false);
});

test("glob: matching is case-insensitive", () => {
  assert.equal(matchGlob("NPM TEST", "npm test*"), true);
  assert.equal(matchGlob("Src/App.ts", "src/**"), true);
});

test("glob: regex metacharacters are literal", () => {
  assert.equal(matchGlob("a.b", "a.b"), true);
  assert.equal(matchGlob("axb", "a.b"), false);
  assert.equal(matchGlob("a+b", "a+b"), true);
  assert.equal(matchGlob("a(b)", "a(b)"), true); // parentheses are literal, not a group
  assert.equal(matchGlob("aXb", "a(b)"), false);
  assert.equal(matchGlob("(x)", "(x)"), true);
  assert.equal(matchGlob("a|b", "a|b"), true);
  assert.equal(matchGlob("axb", "a|b"), false);
});

test("glob: path glob with ** and leading slash", () => {
  assert.equal(matchGlob("/repo/src/a/b.ts", "/repo/src/**"), true);
  assert.equal(matchGlob("/repo/test/a.ts", "/repo/src/**"), false);
});

test("globToRegExp is anchored and cached", () => {
  const re = globToRegExp("npm test*");
  assert.ok(re instanceof RegExp);
  assert.strictEqual(globToRegExp("npm test*"), re);
  assert.equal(re.test("xnpm test"), false);
  assert.equal(re.test("npm test"), true);
});

// ---------------------------------------------------------------------------
// Rule matching matrix
// ---------------------------------------------------------------------------

const MATCH_CASES: Array<{
  note: string;
  rules: RawRuleLists;
  tool: string;
  args?: Record<string, unknown>;
  expected: "allow" | "deny" | "ask" | null;
}> = [
  // bare tool
  { note: "bare tool matches any args", rules: { allow: ["file_read"] }, tool: "file_read", args: { path: "/x" }, expected: "allow" },
  { note: "bare tool matches with no args", rules: { deny: ["shell_run"] }, tool: "shell_run", args: {}, expected: "deny" },
  { note: "bare tool does not match a different tool", rules: { allow: ["file_read"] }, tool: "file_write", args: { path: "/x" }, expected: null },
  // exec / command patterns
  { note: "shell_run command prefix", rules: { allow: ["shell_run(npm test*)"] }, tool: "shell_run", args: { command: "npm test -- --watch" }, expected: "allow" },
  { note: "shell_run command exact", rules: { allow: ["shell_run(npm test*)"] }, tool: "shell_run", args: { command: "npm test" }, expected: "allow" },
  { note: "shell_run command mismatch", rules: { allow: ["shell_run(npm test*)"] }, tool: "shell_run", args: { command: "npm run build" }, expected: null },
  { note: "bash alias command", rules: { ask: ["bash(git push*)"] }, tool: "bash", args: { command: "git push origin main" }, expected: "ask" },
  { note: "cmd key is used for exec tools", rules: { allow: ["shell_run(ls*)"] }, tool: "shell_run", args: { cmd: "ls -la" }, expected: "allow" },
  // write / path patterns
  { note: "file_write path glob", rules: { allow: ["file_write(src/**)"] }, tool: "file_write", args: { path: "src/a/b.ts" }, expected: "allow" },
  { note: "file_write path mismatch", rules: { allow: ["file_write(src/**)"] }, tool: "file_write", args: { path: "test/a.ts" }, expected: null },
  { note: "file_edit uses path", rules: { deny: ["file_edit(*/secrets/**)"] }, tool: "file_edit", args: { path: "config/secrets/key.ts" }, expected: "deny" },
  { note: "filePath alias", rules: { allow: ["write(src/*)"] }, tool: "write", args: { filePath: "src/a.ts" }, expected: "allow" },
  // network / url patterns
  { note: "web_fetch url glob", rules: { allow: ["web_fetch(https://*.example.com/*)"] }, tool: "web_fetch", args: { url: "https://api.example.com/v1" }, expected: "allow" },
  { note: "web_fetch url mismatch", rules: { allow: ["web_fetch(https://*.example.com/*)"] }, tool: "web_fetch", args: { url: "https://evil.test/x" }, expected: null },
  // secret / id patterns
  { note: "secret id glob", rules: { deny: ["secrets_read(prod-*)"] }, tool: "secrets_read", args: { id: "prod-db" }, expected: "deny" },
  { note: "secret name key", rules: { ask: ["env_read(PATH)"] }, tool: "env_read", args: { name: "PATH" }, expected: "ask" },
  // unknown tool falls back to stable JSON
  { note: "unknown tool matches JSON", rules: { allow: ["custom_tool({\"a\":1})"] }, tool: "custom_tool", args: { a: 1 }, expected: "allow" },
  { note: "unknown tool JSON key order independent", rules: { allow: ["custom_tool({\"a\":1,\"b\":2})"] }, tool: "custom_tool", args: { b: 2, a: 1 }, expected: "allow" },
  // case-insensitivity
  { note: "rule tool name is case-insensitive", rules: { allow: ["SHELL_RUN(npm test*)"] }, tool: "shell_run", args: { command: "npm test" }, expected: "allow" },
  // no match at all
  { note: "empty lists never match", rules: {}, tool: "file_read", args: {}, expected: null },
];

for (const c of MATCH_CASES) {
  test(`match: ${c.note}`, () => {
    const res = evaluatePermissionRules({ ...c.rules, tool: c.tool, args: c.args });
    assert.strictEqual(res?.action ?? null, c.expected);
  });
}

// ---------------------------------------------------------------------------
// Precedence matrix
// ---------------------------------------------------------------------------

test("precedence: deny beats allow", () => {
  const res = evaluatePermissionRules({
    allow: ["shell_run(npm test*)"],
    deny: ["shell_run(npm test -- --coverage*)"],
    tool: "shell_run",
    args: { command: "npm test -- --coverage" },
  });
  assert.strictEqual(res?.action, "deny");
});

test("precedence: deny beats ask", () => {
  const res = evaluatePermissionRules({
    ask: ["shell_run(npm test*)"],
    deny: ["shell_run(npm test -- --coverage*)"],
    tool: "shell_run",
    args: { command: "npm test -- --coverage" },
  });
  assert.strictEqual(res?.action, "deny");
});

test("precedence: ask beats allow", () => {
  const res = evaluatePermissionRules({
    allow: ["shell_run(npm test*)"],
    ask: ["shell_run(npm test -- --watch*)"],
    tool: "shell_run",
    args: { command: "npm test -- --watch" },
  });
  assert.strictEqual(res?.action, "ask");
});

test("precedence: first matching entry in declaration order wins", () => {
  const res = evaluatePermissionRules({
    allow: ["shell_run(npm test*)", "shell_run(npm run*)"],
    tool: "shell_run",
    args: { command: "npm test" },
  });
  assert.strictEqual(res?.rule.pattern, "npm test*");
});

test("precedence: a broader allow does not shadow a narrower ask", () => {
  const res = evaluatePermissionRules({
    allow: ["file_write(*)"],
    ask: ["file_write(src/**)"],
    tool: "file_write",
    args: { path: "src/a.ts" },
  });
  assert.strictEqual(res?.action, "ask");
});

test("evaluatePermissionRules: malformed entries are ignored", () => {
  const res = evaluatePermissionRules({
    allow: ["shell_run(npm test*", "file_read"],
    tool: "file_read",
    args: {},
  });
  assert.strictEqual(res?.action, "allow");
});

// ---------------------------------------------------------------------------
// buildPermissionRuleSet
// ---------------------------------------------------------------------------

test("buildPermissionRuleSet: splits lists and reports errors", () => {
  const { set, errors } = buildPermissionRuleSet({
    allow: ["file_read", "shell_run(npm test*)"],
    deny: ["shell_run(rm -rf*)"],
    ask: ["web_fetch(*)"],
  });
  assert.equal(set.allow.length, 2);
  assert.equal(set.deny.length, 1);
  assert.equal(set.ask.length, 1);
  assert.deepStrictEqual(set.deny[0], { tool: "shell_run", pattern: "rm -rf*", action: "deny" });
  assert.deepStrictEqual(errors, []);
});

test("buildPermissionRuleSet: drops malformed entries and records them", () => {
  const { set, errors } = buildPermissionRuleSet({
    allow: ["file_read", "bad rule("],
    deny: [],
  });
  assert.equal(set.allow.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /bad rule/);
});

// ---------------------------------------------------------------------------
// Composition with the risk-tier gate
// ---------------------------------------------------------------------------

test("gate: an allow rule overrides a tier that would ask", () => {
  // shell_run in workspace-write would be "ask" by the matrix.
  const res = evaluateToolPermission({
    allow: ["shell_run(npm test*)"],
    tool: "shell_run",
    args: { command: "npm test" },
    mode: "workspace-write",
  });
  assert.strictEqual(res.decision, "allow");
  assert.strictEqual(res.source, "permission-rule");
});

test("gate: a deny rule overrides a tier that would allow", () => {
  const res = evaluateToolPermission({
    deny: ["file_read(*/secrets/**)"],
    tool: "file_read",
    args: { path: "src/secrets/key.ts" },
    mode: "danger-full-access",
  });
  assert.strictEqual(res.decision, "deny");
  assert.strictEqual(res.source, "permission-rule");
});

test("gate: an ask rule overrides a tier that would allow", () => {
  const res = evaluateToolPermission({
    ask: ["file_read(config/**)"],
    tool: "file_read",
    args: { path: "config/app.json" },
    mode: "danger-full-access",
  });
  assert.strictEqual(res.decision, "ask");
  assert.strictEqual(res.source, "permission-rule");
});

test("gate: no rule falls through to the risk-tier matrix", () => {
  const res = evaluateToolPermission({ tool: "file_read", args: { path: "a.txt" }, mode: "read-only" });
  assert.strictEqual(res.decision, "allow");
  assert.strictEqual(res.source, "matrix");
  assert.strictEqual(res.matchedRule, undefined);
});

test("gate: fallthrough still honours a saved rule", () => {
  const res = evaluateToolPermission({
    tool: "shell_run",
    args: { command: "npm test" },
    mode: "workspace-write",
    rule: { decision: "allow", tier: "exec" },
  });
  assert.strictEqual(res.decision, "allow");
  assert.strictEqual(res.source, "rule");
});

test("gate: fallthrough still honours task auto-approve", () => {
  const res = evaluateToolPermission({
    tool: "shell_run",
    args: { command: "npm test" },
    mode: "workspace-write",
    autoApprove: true,
  });
  assert.strictEqual(res.decision, "allow");
  assert.strictEqual(res.source, "auto");
});

test("gate: fallthrough default mode is workspace-write", () => {
  const res = evaluateToolPermission({ tool: "file_write", args: { path: "a.txt" } });
  assert.strictEqual(res.decision, "allow");
});

test("gate: matched rule is reported for diagnostics", () => {
  const res = evaluateToolPermission({
    deny: ["file_write(/etc/**)"],
    tool: "file_write",
    args: { path: "/etc/passwd" },
  });
  assert.strictEqual(res.matchedRule?.action, "deny");
  assert.strictEqual(res.matchedRule?.tool, "file_write");
  assert.strictEqual(res.matchedRule?.pattern, "/etc/**");
  assert.match(res.reason, /deny rule matched/);
});
