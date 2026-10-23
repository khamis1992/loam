/**
 * Tokenizer tests.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/tokenize_tests.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * The tokenizer's job is to make quoting and chaining non-bypasses, so those
 * are the cases that matter.
 */

import test from "node:test";
import assert from "node:assert";
import {
  basename,
  embeddedSubstitutions,
  heredocDelimiters,
  isRecursiveFlag,
  splitSegments,
  tokenize,
  word,
} from "../tokenize.js";

test("heredoc payload is data not shell source", () => {
  const command = "cat > /tmp/repro.sh <<'EOF'\n#!/bin/bash\nrm -rf \"$SOME_VAR\"\nEOF\necho wrote";
  const segments = splitSegments(command);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]![0]!.text, "cat");
  assert.equal(segments[1]![0]!.text, "echo");
  assert.ok(!segments.flat().some((token) => token.text === "rm"));
});

test("heredoc terminator does not hide following command", () => {
  const segments = splitSegments("cat <<EOF\ninert\nEOF\nrm -rf ~");
  assert.ok(segments.some((segment) => segment[0]!.text === "rm"));
});

test("tab stripping and escaped delimiters are supported", () => {
  for (const command of [
    "cat <<-EOF\n\trm -rf ~\n\tEOF\necho safe",
    "cat <<\\EOF\nrm -rf ~\nEOF\necho safe",
  ]) {
    const segments = splitSegments(command);
    assert.ok(!segments.flat().some((token) => token.text === "rm"), command);
    assert.ok(segments.some((segment) => segment[0]!.text === "echo"), command);
  }
});

test("heredoc declared inside command substitution is found", () => {
  assert.deepEqual(heredocDelimiters("gh api x -f body=\"$(cat <<'EOF'"), [
    ["EOF", false, true],
  ]);
  assert.deepEqual(heredocDelimiters("echo \"$(printf ')' ; cat <<-END"), [
    ["END", true, false],
  ]);
  // Single quotes suppress `$(`, so this `<<` is literal text.
  assert.equal(heredocDelimiters("echo '$(cat <<EOF'").length, 0);
  // A closed substitution restores the outer double-quote context.
  assert.equal(heredocDelimiters("echo \"$(date) <<EOF\"").length, 0);
});

function texts(command: string): string[] {
  return tokenize(command).map((t) => t.text);
}

test("quoting does not hide a target", () => {
  // All three must yield the same target word.
  for (const command of ["rm -rf $HOME", 'rm -rf "$HOME"', "rm -rf '$HOME'"]) {
    assert.deepEqual(texts(command), ["rm", "-rf", "$HOME"], command);
  }
});

test("backslash escapes are resolved", () => {
  assert.deepEqual(texts("rm -rf /home/my\\ files"), ["rm", "-rf", "/home/my files"]);
});

test("chained commands split into separate segments", () => {
  const segments = splitSegments("echo hi && rm -rf /tmp/a; rm -rf /tmp/b");
  assert.equal(segments.length, 3);
  assert.equal(segments[1]![0]!.text, "rm");
  assert.equal(segments[2]![0]!.text, "rm");
});

test("piped commands are separate segments", () => {
  const segments = splitSegments("find . -type f | xargs rm -rf");
  assert.equal(segments.length, 2);
  assert.equal(segments[1]![0]!.text, "xargs");
});

test("truncating redirect target is marked but append is not", () => {
  const clobber = tokenize("echo x > important.conf");
  assert.ok(
    clobber.some((t) => t.isTruncatingRedirectTarget && t.text === "important.conf"),
    JSON.stringify(clobber),
  );

  const append = tokenize("echo x >> log.txt");
  assert.ok(
    !append.some((t) => t.isTruncatingRedirectTarget),
    "append does not truncate and must not be flagged",
  );
});

test("fd duplication is not a truncating redirect", () => {
  for (const cmd of ["printf evidence 2>&1", "cmd >&2", "cmd 2>&-", "cmd 1>&2 && ls"]) {
    assert.ok(
      !tokenize(cmd).some((t) => t.isTruncatingRedirectTarget),
      `${cmd} duplicates an fd and must not flag a target`,
    );
  }
  const both = tokenize("cmd >& out.log");
  assert.ok(both.some((t) => t.isTruncatingRedirectTarget && t.text === "out.log"));
  const mixed = tokenize("cmd 2>&1 > out.txt");
  assert.ok(mixed.some((t) => t.isTruncatingRedirectTarget && t.text === "out.txt"));
});

test("recursive flag detected in bundles and long form", () => {
  const cases: Array<[string, boolean]> = [
    ["-rf", true],
    ["-fr", true],
    ["-R", true],
    ["--recursive", true],
    ["-f", false],
    ["--force", false],
    ["-i", false],
  ];
  for (const [flag, expected] of cases) {
    assert.equal(isRecursiveFlag(flag), expected, flag);
  }
});

test("basename strips the path so absolute invocations match", () => {
  assert.equal(basename("/bin/rm"), "rm");
  assert.equal(basename("/usr/bin/shred"), "shred");
});

test("tokenizing is total and never panics", () => {
  // Malformed input must degrade gracefully rather than crash the tool call.
  for (const command of ["", "   ", "'", '"', "\\", ">", "&&", 'rm -rf "unterminated']) {
    splitSegments(command);
  }
});

test("parentheses split subshell and command substitution bodies", () => {
  const segments = splitSegments("x=$(rm -rf ~); (echo ok)");
  const textsOf = segments.map((segment) => segment.map((token) => token.text));
  assert.deepEqual(textsOf, [["x=$"], ["rm", "-rf", "~"], ["echo", "ok"]]);
});

// ---------------------------------------------------------------------------
// Windows / PowerShell cases
// ---------------------------------------------------------------------------

test("PowerShell backtick escape resolves like a backslash", () => {
  assert.deepEqual(texts("Remove-Item C:\\Users\\u\\file``s.txt"), [
    "Remove-Item",
    "C:\\Users\\u\\file`s.txt",
  ]);
});

test("PowerShell drive letters are preserved", () => {
  assert.deepEqual(texts("del C:\\Users\\u\\AppData\\Local\\Temp\\x"), [
    "del",
    "C:\\Users\\u\\AppData\\Local\\Temp\\x",
  ]);
});

test("PowerShell -Recurse is a recursive flag", () => {
  assert.equal(isRecursiveFlag("-Recurse"), true);
  assert.equal(isRecursiveFlag("-r"), true);
  assert.equal(isRecursiveFlag("-Force"), false);
});

test("PowerShell semicolons and pipes split segments", () => {
  const segments = splitSegments("Remove-Item -Recurse C:\\a; Remove-Item C:\\b");
  assert.equal(segments.length, 2);
  assert.equal(segments[1]![0]!.text, "Remove-Item");
});

test("substitutions are collected", () => {
  assert.deepEqual(embeddedSubstitutions("echo $(rm -rf ~)"), ["rm -rf ~"]);
  assert.deepEqual(embeddedSubstitutions("echo `rm -rf ~`"), ["rm -rf ~"]);
  // Inert: single quotes and quoted heredocs are not expanded.
  assert.deepEqual(embeddedSubstitutions("echo '$(rm -rf ~)'"), []);
  assert.deepEqual(embeddedSubstitutions("cat <<'EOF'\n$(rm -rf ~)\nEOF"), []);
});

test("word() helper produces a plain token", () => {
  assert.deepEqual(word("-rf"), {
    text: "-rf",
    receivesPipe: false,
    isTruncatingRedirectTarget: false,
    isOperator: false,
  });
});
