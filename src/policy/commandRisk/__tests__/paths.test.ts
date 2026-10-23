/**
 * Path-layer tests.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/paths_tests.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * The catastrophic tier is the only protection that cannot be argued around,
 * so it gets adversarial coverage: every spelling of "the home directory" a
 * model might plausibly emit must resolve to the same verdict.
 */

import test from "node:test";
import assert from "node:assert";
import {
  classifyTarget,
  expand,
  isCatastrophicTarget,
  isTempPath,
  normalize,
  pathParent,
  pathStartsWith,
} from "../paths.js";
import type { RiskContext, RiskLevel } from "../lib.js";

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    scratchDir: "/home/u/.jcode/scratch",
    workingDir: "/home/u/proj",
    homeDir: "/home/u",
    ...overrides,
  };
}

test("home directory is catastrophic in every spelling", () => {
  // Each of these denotes /home/u. A model under pressure could emit any.
  const spellings = [
    "~",
    "$HOME",
    "${HOME}",
    "/home/u",
    "/home/u/",
    "/home/u/.",
    "/home/u/foo/..",
    "~/",
    "~/.",
    "/home/u/../u",
    "/home/./u",
  ];
  for (const spelling of spellings) {
    const expanded = expand(spelling, ctx());
    assert.ok(
      isCatastrophicTarget(expanded, ctx()),
      `${spelling} resolved to ${expanded} and was not caught`,
    );
  }
});

test("parent traversal out of home reaches root and is caught", () => {
  for (const spelling of ["~/../..", "/home/u/../..", "~/../../", "/home/u/../../"]) {
    const expanded = expand(spelling, ctx());
    assert.equal(expanded, "/", spelling);
    assert.ok(isCatastrophicTarget(expanded, ctx()), spelling);
  }
});

test("root and system paths are catastrophic", () => {
  for (const p of ["/", "/etc", "/usr", "/var", "/boot", "/home", "/Users"]) {
    assert.ok(isCatastrophicTarget(p, ctx()), `${p} must be protected`);
  }
});

test("credential stores inside home are catastrophic", () => {
  for (const sub of [".ssh", ".gnupg", ".aws", ".config", ".jcode"]) {
    const expanded = expand(`~/${sub}`, ctx());
    assert.ok(isCatastrophicTarget(expanded, ctx()), `~/${sub}`);
  }
});

test("ordinary project paths are not catastrophic", () => {
  // The guard must not fire on normal work, or it trains people to bypass it.
  for (const p of [
    "/home/u/proj/target",
    "/home/u/proj/node_modules",
    "/home/u/proj/src/old.rs",
    "/tmp/scratch",
    "/home/u/scratchpad",
  ]) {
    assert.ok(!isCatastrophicTarget(p, ctx()), `${p} should not be treated as catastrophic`);
  }
});

test("home subdirectory is not itself catastrophic", () => {
  // ~/proj is deletable; ~ is not. The boundary must be exact.
  assert.ok(!isCatastrophicTarget("/home/u/proj", ctx()));
  assert.ok(isCatastrophicTarget("/home/u", ctx()));
});

test("inside working directory is low risk not confirm", () => {
  const expanded = expand("target", ctx());
  const finding = classifyTarget(expanded, "target", true, ctx());
  assert.equal(finding?.level, "Low");
});

test("non-recursive delete inside cwd is unremarkable", () => {
  const expanded = expand("notes.txt", ctx());
  assert.equal(classifyTarget(expanded, "notes.txt", false, ctx()), null);
});

test("concrete outside working directory target is low risk", () => {
  const expanded = expand("/home/u/other-project", ctx());
  const finding = classifyTarget(expanded, "/home/u/other-project", true, ctx());
  assert.equal(finding?.level, "Low");
});

test("temp paths are exempt", () => {
  const expanded = expand("/tmp/build-cache", ctx());
  assert.equal(classifyTarget(expanded, "/tmp/build-cache", true, ctx()), null);
});

test("glob over a protected directory is catastrophic", () => {
  for (const raw of ["~/*", "/*", "$HOME/*"]) {
    const expanded = expand(raw, ctx());
    const finding = classifyTarget(expanded, raw, true, ctx());
    assert.ok(finding, `${raw} produced no finding`);
    assert.equal(finding!.level, "Catastrophic", `${raw} resolved to ${expanded}`);
  }
});

test("unresolvable targets escalate rather than pass", () => {
  // We deliberately do not expand these, so we cannot vouch for them.
  for (const raw of ["$SOME_VAR", "`cat paths.txt`", "$(echo /)"]) {
    const expanded = expand(raw, ctx());
    const finding = classifyTarget(expanded, raw, true, ctx());
    assert.ok(finding, `${raw} produced no finding`);
    assert.equal(
      finding!.level === "Confirm" || finding!.level === "Catastrophic",
      true as boolean,
      `${raw} must not be silently allowed`,
    );
  }
});

test("missing home context does not panic or misfire", () => {
  // On an exotic host HOME may be unset; the system-path tier must still work.
  const noHome = ctx({ homeDir: undefined, workingDir: "/srv/app" });
  assert.ok(isCatastrophicTarget("/", noHome));
  assert.ok(!isCatastrophicTarget("/srv/app/tmp", noHome));
});

test("normalize never escapes above root", () => {
  // Pathological input must not underflow into an empty or relative path.
  const expanded = expand("/../../../../..", ctx());
  assert.equal(expanded, "/");
  assert.ok(isCatastrophicTarget(expanded, ctx()));
});

test("individual credential files are protected not just their directory", () => {
  // Exact-match alone left an obvious hole: deleting one private key is as
  // damaging as deleting ~/.ssh wholesale.
  for (const path of [
    "/home/u/.ssh/id_ed25519",
    "/home/u/.ssh/config",
    "/home/u/.gnupg/secring.gpg",
    "/home/u/.aws/credentials",
    "/home/u/.kube/config",
  ]) {
    assert.ok(isCatastrophicTarget(path, ctx()), `${path} must be protected`);
  }
});

test("ordinary config files remain editable", () => {
  // The inverse: config directories are protected as a whole, but agents
  // legitimately rewrite individual files inside them all day.
  for (const path of [
    "/home/u/.config/app/settings.toml",
    "/home/u/.jcode/sessions/old.json",
    "/home/u/Documents/notes/draft.md",
  ]) {
    assert.ok(!isCatastrophicTarget(path, ctx()), `${path} should stay editable`);
  }
  // ...while the roots themselves stay protected.
  for (const path of ["/home/u/.config", "/home/u/.jcode", "/home/u/Documents"]) {
    assert.ok(isCatastrophicTarget(path, ctx()), path);
  }
});

test("known variable logs are bounded but unknown expansions still confirm", () => {
  for (const raw of [
    "$HOME/.jcode/scratch/tests.log",
    "${HOME}/proj/tests.log",
    "$JCODE_SCRATCH_DIR/tests.log",
    "${JCODE_SCRATCH_DIR}/backup.patch",
  ]) {
    const path = expand(raw, ctx());
    const finding = classifyTarget(path, raw, false, ctx());
    assert.ok(
      finding === null || finding.level === "Low" || finding.level === "Safe",
      raw,
    );
  }
  for (const raw of [
    "$HOME_BACKUP/file",
    "$HOME/proj/$UNKNOWN/file*",
    "$HOME/proj/$UNKNOWN/../file*",
    "$JCODE_SCRATCH_DIR_OTHER/file",
    "${HOME:-/tmp}/file",
    "$UNKNOWN/../file",
    "$JCODE_SCRATCH_DIR/$UNKNOWN/../file",
    "$JCODE_SCRATCH_DIR/$(pwd)/file",
  ]) {
    const path = expand(raw, ctx());
    const finding = classifyTarget(path, raw, false, ctx());
    assert.ok(finding, raw);
    assert.equal(finding!.level, "Confirm", raw);
  }
});

test("known variables do not bypass protected paths", () => {
  for (const raw of [
    "$HOME",
    "${HOME}/.ssh/key",
    "$JCODE_SCRATCH_DIR/../..",
    "$JCODE_SCRATCH_DIR/../../../../etc/passwd",
  ]) {
    const path = expand(raw, ctx());
    const finding = classifyTarget(path, raw, true, ctx());
    assert.ok(finding, raw);
    assert.equal(finding!.level, "Catastrophic", `${raw}: ${path}`);
  }
  const scratchIsEtc = ctx({ scratchDir: "/etc" });
  const raw = "$JCODE_SCRATCH_DIR/passwd";
  const finding = classifyTarget(expand(raw, scratchIsEtc), raw, false, scratchIsEtc);
  assert.ok(finding);
  assert.equal(finding!.level, "Catastrophic");
});

// ---------------------------------------------------------------------------
// Windows / PowerShell cases
// ---------------------------------------------------------------------------

test("a drive root is catastrophic", () => {
  for (const p of ["C:\\", "C:/", "D:\\"]) {
    assert.ok(isCatastrophicTarget(p, ctx()), p);
  }
});

test("a drive letter alone is catastrophic", () => {
  assert.ok(isCatastrophicTarget("C:", ctx()));
});

test("UNC server and share roots are catastrophic", () => {
  assert.ok(isCatastrophicTarget("\\\\server", ctx()));
  assert.ok(isCatastrophicTarget("\\\\server\\share", ctx()));
});

test("Windows paths under a project stay workable", () => {
  const win = ctx({ homeDir: "C:\\Users\\u", workingDir: "C:\\Users\\u\\proj" });
  assert.ok(isCatastrophicTarget("C:\\Users\\u", win));
  assert.ok(!isCatastrophicTarget("C:\\Users\\u\\proj\\target", win));
  assert.ok(isCatastrophicTarget("C:\\Users\\u\\.ssh", win));
});

test("Windows temp paths are exempt", () => {
  assert.ok(isTempPath("C:/Users/u/AppData/Local/Temp"));
  assert.ok(isTempPath("C:\\Users\\u\\AppData\\Local\\Temp"));
  assert.ok(isTempPath("D:/tmp"));
  assert.ok(!isTempPath("C:/Users/u/proj/target"));
});

test("Windows device names are catastrophic write targets", () => {
  for (const p of ["C:/Windows/NUL", "C:/Windows/CON", "C:/COM1"]) {
    const finding = classifyTarget(p, p, false, ctx());
    assert.ok(finding, p);
    assert.equal(finding!.level, "Catastrophic", p);
  }
});

test("path prefix matching is component based, not string based", () => {
  assert.ok(pathStartsWith("/home/u/proj", "/home/u"));
  assert.ok(!pathStartsWith("/home/user", "/home/u"));
  assert.ok(pathStartsWith("C:/Users/u/proj", "C:/Users/u"));
  assert.ok(!pathStartsWith("C:/Users/v/proj", "C:/Users/u"));
});

test("path parent and normalize handle Windows separators", () => {
  assert.equal(normalize("C:\\Users\\u\\proj\\..\\src"), "C:/Users/u/src");
  assert.equal(normalize("/a/b/../.."), "/");
  assert.equal(pathParent("C:/Users/u/proj"), "C:/Users/u");
  assert.equal(pathParent("/"), null);
});
