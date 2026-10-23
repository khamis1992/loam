/**
 * End-to-end assessment tests: real command strings in, verdict out.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/assess_tests.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * The two failure modes that matter are opposite and both fatal:
 * under-firing loses a home directory (#604), over-firing trains users to
 * bypass the gate. Both directions are covered.
 */

import test from "node:test";
import assert from "node:assert";
import {
  assess,
  runsImmediately,
  isAbsoluteDeny,
  severity,
  type RiskContext,
  type RiskLevel,
} from "../lib.js";

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    workingDir: "/home/u/proj",
    homeDir: "/home/u",
    scratchDir: undefined,
    ...overrides,
  };
}

function level(command: string): RiskLevel {
  return assess(command, ctx()).level;
}

test("issue 922 heredoc payload does not trip the gate", () => {
  for (const command of [
    "cat >> log.md <<'EOF'\nO(n^2) time and O(n) space\nEOF",
    "cat > helper.sh <<'EOF'\n#!/bin/bash\nrm -f \"$SOME_VAR\"\nEOF",
  ]) {
    assert.ok(runsImmediately(level(command)), JSON.stringify(command));
  }

  assert.equal(
    level("cat <<'EOF'\nrm -rf ~\nEOF\nrm -rf ~"),
    "Catastrophic",
  );
});

test("heredoc inside double quoted command substitution is data", () => {
  // The common "pass a multiline body to a flag" idiom. The body is quoted
  // heredoc data, so backticks, quotes and `>` inside it are prose.
  for (const command of [
    "echo \"$(cat <<'EOF'\n`\"p>\"` y\nEOF\n)\"",
    "gh api repos/o/r/pulls -f body=\"$(cat <<'EOF'\nRan `tool resume X \"<pointer>\"` ok.\nEOF\n)\"",
    "git commit -m \"$(cat <<'EOF'\nSummary with `rm -rf ~` in prose\nEOF\n)\"",
  ]) {
    assert.ok(runsImmediately(level(command)), JSON.stringify(command));
  }

  // A real command after the substitution is still assessed.
  assert.equal(
    level("echo \"$(cat <<'EOF'\ninert\nEOF\n)\"; rm -rf ~"),
    "Catastrophic",
  );
  // `<<` inside single quotes is still not a heredoc.
  assert.equal(
    level("echo '$(cat <<EOF'\nrm -rf ~\nEOF"),
    "Catastrophic",
  );
});

test("the issue 604 command is blocked outright", () => {
  // The reported incident: "jcode just deleted everything in my ~".
  for (const command of [
    "rm -rf ~",
    "rm -rf $HOME",
    'rm -rf "$HOME"',
    "rm -rf ${HOME}",
    "rm -rf /home/u",
    "rm -fr ~/",
    "/bin/rm -rf ~",
    "rm -rf ~/*",
  ]) {
    assert.equal(level(command), "Catastrophic", `${command} must be denied outright`);
  }
});

test("root destruction is blocked outright", () => {
  for (const command of ["rm -rf /", "rm -rf /*", "rm -rf /etc", "rm --recursive --force /usr"]) {
    assert.equal(level(command), "Catastrophic", command);
  }
});

test("credential theft or destruction is blocked", () => {
  for (const command of ["rm -rf ~/.ssh", "shred ~/.gnupg", "rm -rf ~/.aws"]) {
    assert.equal(level(command), "Catastrophic", command);
  }
});

test("chaining does not bypass the gate", () => {
  // The dangerous half is second; the first half is innocuous.
  assert.equal(level("echo starting && rm -rf ~"), "Catastrophic");
  assert.equal(level("cd /tmp; rm -rf $HOME"), "Catastrophic");
  assert.equal(level("true || rm -rf /"), "Catastrophic");
});

test("routine cleanup inside the project is not blocked", () => {
  // If these prompt, the gate is useless because everyone learns to dismiss it.
  for (const command of [
    "rm -rf target",
    "rm -rf ./node_modules",
    "rm -f Cargo.lock",
    "rm -rf /home/u/proj/build",
    "rm -rf /tmp/scratch",
    "cargo clean",
    "ls -la",
    "git status",
    "echo hello > out.txt",
  ]) {
    assert.ok(
      runsImmediately(level(command)),
      `${command} should run without a reflection turn, got ${level(command)}`,
    );
  }
});

test("deleting concrete paths outside the project runs immediately", () => {
  for (const command of ["rm -rf /home/u/other-project", "rm -rf /srv/data"]) {
    assert.equal(level(command), "Low", command);
  }
});

test("non-rm destructive tools are covered", () => {
  // A name-based denylist would miss all of these.
  assert.equal(level("find /home/u -delete"), "Catastrophic");
  assert.ok(!runsImmediately(level("dd if=/dev/zero of=/dev/sda")));
  assert.equal(level("shred /home/u/other/secrets.txt"), "Low");
});

test("concrete truncating redirect outside cwd runs immediately", () => {
  assert.equal(level("echo '' > /home/u/other/important.conf"), "Low");
});

test("appending is not treated as destructive", () => {
  assert.ok(runsImmediately(level("echo line >> /home/u/other/log.txt")));
});

test("runtime computed targets require justification", () => {
  // We cannot see what $TARGET holds, so we must not assume it is safe.
  assert.ok(severity(level("rm -rf $TARGET")) >= severity("Confirm"));
  assert.ok(severity(level("rm -rf $(cat list.txt)")) >= severity("Confirm"));
});

test("destructive command without a visible target escalates", () => {
  // Unknown blast radius is a reason to ask, not to proceed.
  assert.ok(severity(level("rm -rf")) >= severity("Confirm"));
});

test("assessment is total over garbage input", () => {
  for (const command of ["", "   ", "'", "\\", ";;;", "&&", 'rm -rf "unterminated']) {
    assess(command, ctx());
  }
});

test("explanation names the offending target", () => {
  const text = assess("rm -rf ~", ctx()).explanation();
  assert.ok(text.includes("/home/u"), `explanation should name the path: ${text}`);
});

test("catastrophic cannot be unlocked but confirm can", () => {
  assert.ok(isAbsoluteDeny("Catastrophic"));
  assert.ok(!isAbsoluteDeny("Confirm"));
  assert.ok(!runsImmediately("Confirm"));
  assert.ok(runsImmediately("Safe"));
  assert.ok(runsImmediately("Low"));
});

test("severity ordering is monotonic", () => {
  // from_findings takes the max, so the ordering must be correct.
  assert.ok(severity("Safe") < severity("Low"));
  assert.ok(severity("Low") < severity("Confirm"));
  assert.ok(severity("Confirm") < severity("Catastrophic"));
});

test("the worst finding in a chain wins", () => {
  // A Low finding must not mask a Catastrophic one in the same command.
  const assessment = assess("rm -rf target && rm -rf ~", ctx());
  assert.equal(assessment.level, "Catastrophic");
  assert.ok(assessment.findings.length >= 2);
});

/** State-space sweep: every combination of a destructive verb, a recursive
 *  flag spelling, and a way of naming the home directory must be denied.
 *
 *  Hand-written cases encode the failures we already thought of. This encodes
 *  the ones we did not: 6 verbs x 5 flags x 11 spellings = 330 commands. */
test("no combination of verb flag and home spelling slips through", () => {
  const verbs = ["rm", "/bin/rm", "shred", "srm", "rmdir", "unlink"];
  const flags = ["-rf", "-fr", "-r -f", "--recursive --force", "-Rf"];
  const homes = [
    "~",
    "~/",
    "$HOME",
    "${HOME}",
    '"$HOME"',
    "'/home/u'",
    "/home/u",
    "/home/u/",
    "/home/u/.",
    "/home/u/x/..",
    "/home/./u",
  ];

  const escaped: string[] = [];
  for (const verb of verbs) {
    for (const flag of flags) {
      for (const home of homes) {
        const command = `${verb} ${flag} ${home}`;
        if (assess(command, ctx()).level !== "Catastrophic") escaped.push(command);
      }
    }
  }
  assert.deepEqual(escaped, [], `${escaped.length} command(s) reached the home directory ungated`);
});

/** The inverse sweep: ordinary in-project work must never be interrupted. */
test("no routine project command triggers a prompt", () => {
  const commands = [
    "rm -rf target",
    "rm -rf ./target",
    "rm -rf build dist",
    "rm -f a.txt b.txt",
    "rm -rf src/generated",
    "rm -rf /home/u/proj/.cache",
    "rm -rf /tmp/x",
    "git status",
    "cargo build",
    "npm ci",
    "mkdir -p out",
    "cp a b",
    "mv old new",
    "echo hi > out.txt",
    "cat Cargo.toml",
    "grep -r TODO src",
  ];
  const noisy: string[] = [];
  for (const command of commands) {
    const lvl = assess(command, ctx()).level;
    if (!runsImmediately(lvl)) noisy.push(`${command} -> ${lvl}`);
  }
  assert.deepEqual(
    noisy,
    [],
    `gate fired on routine work, which trains users to bypass it: ${JSON.stringify(noisy)}`,
  );
});

/** Chaining, in every separator form, must not launder a catastrophic command. */
test("no separator launders a catastrophic command", () => {
  const escaped: string[] = [];
  for (const sep of ["&&", "||", ";", "|", "\n"]) {
    for (const command of [
      `echo safe ${sep} rm -rf ~`,
      `rm -rf ~ ${sep} echo done`,
      `cd /tmp ${sep} rm -rf $HOME`,
    ]) {
      if (assess(command, ctx()).level !== "Catastrophic") escaped.push(command);
    }
  }
  assert.deepEqual(escaped, [], `laundered through a separator: ${JSON.stringify(escaped)}`);
});

/** Bypasses found by automated review of the original PR. Each of these was
 *  classified `Safe` before the fix, including `sudo rm -rf ~`. */
test("wrapper commands do not hide the real program", () => {
  const escaped: string[] = [];
  for (const wrapper of [
    "sudo",
    "doas",
    "env",
    "nice -n 10",
    "ionice -c 3",
    "time",
    "timeout 5",
    "nohup",
    "setsid",
    "stdbuf -o0",
    "command",
    "exec",
    "sudo -u root",
    "env FOO=bar",
    "watch",
  ]) {
    for (const tail of ["rm -rf ~", "rm -rf $HOME", "rm -rf /"]) {
      const command = `${wrapper} ${tail}`;
      if (assess(command, ctx()).level !== "Catastrophic") escaped.push(command);
    }
  }
  assert.deepEqual(escaped, [], `wrapper bypass: ${JSON.stringify(escaped)}`);
});

test("nested wrappers are unwrapped all the way down", () => {
  assert.equal(level("sudo env nice -n 5 rm -rf ~"), "Catastrophic");
  assert.equal(level("timeout 5 sudo rm -rf /"), "Catastrophic");
});

test("a wrapper hiding an unparseable payload escalates", () => {
  // We could not see what sudo was about to run, so we must not assume safety.
  assert.ok(severity(assess("sudo", ctx()).level) >= severity("Confirm"));
});

test("inline shell scripts are assessed not skipped", () => {
  // `sh -c "..."` is the classic way around a static parser. It cannot be fully
  // solved, but the plain literal case must not be a free pass.
  for (const command of ['sh -c "rm -rf ~"', "bash -c 'rm -rf $HOME'", 'sudo sh -c "rm -rf /"']) {
    assert.equal(assess(command, ctx()).level, "Catastrophic", command);
  }
});

test("piped deletes cannot launder their targets", () => {
  // `find ~ -type f | xargs rm -rf` deletes home contents, but neither segment
  // shows it: xargs takes its operands from stdin.
  for (const command of [
    "find ~ -type f | xargs rm -rf",
    "find / -name '*.conf' | xargs rm",
    "cat paths.txt | xargs rm -rf",
  ]) {
    assert.ok(!runsImmediately(assess(command, ctx()).level), `${command} must not run unchallenged`);
  }
});

test("files inside system directories are protected too", () => {
  // Exact-root matching left /etc/passwd merely "Confirm", and the approval gate
  // consults only the catastrophic tier, so it would have deleted it.
  for (const path of [
    "rm -f /etc/passwd",
    "rm -rf /usr/bin/env",
    "rm /boot/vmlinuz",
    "shred /etc/shadow",
  ]) {
    assert.equal(level(path), "Catastrophic", path);
  }
});

test("user directories under home root stay workable", () => {
  // /home and /Users must not become recursive, or every project path under
  // them would be blocked.
  assert.ok(runsImmediately(level("rm -rf /home/u/proj/target")));
  assert.equal(level("rm -rf /home"), "Catastrophic");
});

test("ordinary wrapped commands still run immediately", () => {
  const noisy: string[] = [];
  for (const command of [
    "sudo apt update",
    "env RUST_LOG=debug cargo test",
    "timeout 30 cargo build",
    "nice -n 10 make",
    "time ls -la",
    "sudo systemctl status jcode",
    "xargs echo",
    "find . -name '*.rs' | xargs grep TODO",
    "sh -c 'echo hello'",
    "bash -c 'cargo build'",
    "sudo rm -rf /home/u/proj/target",
  ]) {
    const lvl = assess(command, ctx()).level;
    if (!runsImmediately(lvl)) noisy.push(`${command} -> ${lvl}`);
  }
  assert.deepEqual(noisy, [], `gate became noisy on normal work: ${JSON.stringify(noisy)}`);
});

test("read only find with stderr redirect is safe", () => {
  const command =
    "find ~/.jcode -maxdepth 3 -type f \\\n" +
    "                   \\( -name '*.log' -o -name '*events*' \\) \\\n" +
    "                   -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -20";
  const assessment = assess(command, ctx());
  assert.equal(assessment.level, "Safe", JSON.stringify(assessment));
  assert.equal(assessment.findings.length, 0, JSON.stringify(assessment));
});

test("harmless command operands are not redirect targets", () => {
  for (const command of [
    "grep needle /home/u/.jcode/config 2>/dev/null",
    "find / -name '*.conf' 2>/dev/null",
    "printf '%s\\n' /home/u/.ssh/id_ed25519 >/tmp/list",
  ]) {
    const assessment = assess(command, ctx());
    assert.equal(assessment.level, "Safe", `${command}: ${JSON.stringify(assessment)}`);
  }
});

test("safe redirect sink does not make explicit deletion safe", () => {
  assert.equal(level("rm /dev/null"), "Catastrophic");
});

test("shell constructs do not hide catastrophic commands", () => {
  for (const command of [
    "(rm -rf ~)",
    "x=$(rm -rf ~)",
    "case x in y) rm -rf ~;; esac",
    "if true; then rm -rf ~; fi",
    "while true; do rm -rf ~; done",
  ]) {
    assert.equal(level(command), "Catastrophic", command);
  }
  assert.ok(
    severity(level("rm -rf $(echo ~)")) >= severity("Confirm"),
    "runtime-computed targets must not run immediately",
  );
});

test("issue 725 read only and bounded commands run immediately", () => {
  for (const command of [
    't=$(readlink "$f" 2>/dev/null)',
    "sudo -n ls /sys",
    "rm -f build-2026-*.json",
    "rm -f /tmp/jcode-*.json",
  ]) {
    assert.ok(runsImmediately(level(command)), `${command} should be bounded, got ${level(command)}`);
  }
});

test("wrapper value flags and unbounded globs remain guarded", () => {
  for (const command of [
    "nice -n 10 rm -rf ~",
    "sudo -u root rm -rf ~",
    "timeout -s KILL 5 rm -rf ~",
    "xargs -n 1 rm -rf ~",
    "ionice -c 3 rm -rf ~",
    "rm -rf /home/u/*/node_modules",
    "rm -rf /etc/*",
  ]) {
    assert.ok(severity(level(command)) >= severity("Confirm"), `${command} must remain guarded`);
  }
});

test("environment printing and command lookup are read only", () => {
  for (const command of [
    "env",
    "env -i",
    "env FOO=bar",
    "sudo env",
    "command -v sudo",
    "command -V rm",
    "command -pv sudo env rm",
    "command -p -V sudo",
    "env command -v sudo",
    "command -v rm -rf /",
  ]) {
    assert.equal(level(command), "Safe", command);
  }
  for (const command of ["command -p rm -rf ~", "env rm -rf ~", "command -- rm -rf ~"]) {
    assert.equal(level(command), "Catastrophic", command);
  }
});

test("read only find actions do not delete search roots", () => {
  for (const action of ["-exec", "-execdir", "-ok", "-okdir"]) {
    for (const payload of [
      "cat {}",
      "/bin/cat -- {}",
      "readlink -f {}",
      "sed -n '1,200p' {}",
      "sed 'p' {}",
    ]) {
      for (const root of ["/", "~", "~/.ssh", "/etc"]) {
        for (const terminator of ["\\;", "+"]) {
          const command = `find ${root} -type f ${action} ${payload} ${terminator}`;
          assert.equal(level(command), "Safe", command);
        }
      }
    }
  }
  assert.equal(level("find / -exec cat {} \\; -exec readlink {} \\;"), "Safe");
});

test("find mutating and unknown actions remain protected", () => {
  for (const action of ["-exec", "-execdir", "-ok", "-okdir"]) {
    for (const payload of ["rm -rf {}", "sudo rm -rf {}", "shred {}"]) {
      const command = `find ~ ${action} ${payload} \\;`;
      assert.equal(level(command), "Catastrophic", command);
    }
    for (const payload of [
      "mystery {}",
      "$PROGRAM {}",
      "sed -i 's/a/b/' {}",
      "sed 'w /etc/passwd' {}",
      "sed 'e rm -rf ~' {}",
      "sed -n -f script {}",
      "sh -c '$PAYLOAD' {}",
    ]) {
      const command = `find / ${action} ${payload} \\;`;
      assert.ok(severity(level(command)) >= severity("Confirm"), command);
    }
  }
  for (const command of [
    "find ~ -delete",
    "find ~ -exec cat {} \\; -delete",
    "find / -exec cat {} \\; -exec rm -rf {} +",
    "find . -exec rm -rf /etc \\;",
    "find -L ~ -delete",
  ]) {
    assert.equal(level(command), "Catastrophic", command);
  }
  for (const command of ["find / -exec", "find / -exec cat {}", "find / -execdir mystery {} +"]) {
    assert.ok(severity(level(command)) >= severity("Confirm"), command);
  }
});

test("read only early returns preserve redirect checks", () => {
  for (const prefix of [
    "env",
    "command -v sudo",
    "find / -exec cat {} \\;",
    "find / -exec sed -n '1p' {} \\;",
    "sh -c 'echo hello'",
  ]) {
    assert.equal(level(`${prefix} > /etc/passwd`), "Catastrophic", prefix);
    assert.equal(level(`${prefix} > $UNKNOWN`), "Confirm", prefix);
    assert.equal(level(`${prefix} 2>/dev/null`), "Safe", prefix);
  }
});

test("reassignment does not override trusted protection", () => {
  for (const command of ["HOME=/tmp; rm -rf /home/u", "env HOME=/tmp rm -rf ~/.ssh"]) {
    assert.equal(level(command), "Catastrophic", command);
  }
  for (const command of [
    "HOME=/etc; rm -rf $HOME/cache",
    "JCODE_SCRATCH_DIR=/etc; rm -rf $JCODE_SCRATCH_DIR/passwd",
  ]) {
    assert.ok(severity(level(command)) >= severity("Confirm"), command);
  }
  assert.equal(level("env -u UNUSED rm -rf ~"), "Catastrophic");
  assert.equal(level("env -u UNUSED"), "Safe");
  assert.ok(severity(level("env -S 'rm -rf ~'")) >= severity("Confirm"));
});

test("env split strings cannot be mistaken for printing", () => {
  for (const command of [
    "env -S='rm -rf /'",
    "env --split-string='rm -rf /'",
    "env -u FOO -S 'rm -rf /'",
    "env -iS 'rm -rf /'",
  ]) {
    assert.ok(severity(level(command)) >= severity("Confirm"), command);
  }
});

test("find output actions write only their destinations", () => {
  for (const action of ["-fprint", "-fprint0", "-fls", "-fprintf"]) {
    const suffix = action === "-fprintf" ? " '%p'" : "";
    for (const [target, expected] of [
      ["/etc/passwd", "Catastrophic"],
      ["$UNKNOWN", "Confirm"],
      ["/tmp/find-output", "Safe"],
      ["/dev/null", "Safe"],
    ] as Array<[string, RiskLevel]>) {
      const command = `find / ${action} ${target}${suffix}`;
      assert.equal(level(command), expected, command);
    }
  }
  for (const command of [
    "find / -name '-delete'",
    "find / -printf '-delete'",
    "find / -name '-exec'",
  ]) {
    assert.equal(level(command), "Safe", command);
  }
});

test("issue 1753 substitutions are assessed like top level commands", () => {
  for (const command of [
    "echo $(rm -rf ~)",
    "x=$(rm -rf ~)",
    'echo "$(rm -rf ~)"',
    "echo `rm -rf ~`",
    'echo "`rm -rf ~`"',
    "cat <<EOF\n$(rm -rf ~)\nEOF",
    "cat <<EOF\n`rm -rf ~`\nEOF",
    'echo "$(echo "$(rm -rf ~)")"',
    'git commit -m "$(rm -rf ~)"',
  ]) {
    assert.equal(level(command), "Catastrophic", JSON.stringify(command));
  }
});

test("issue 1753 inert text stays safe", () => {
  for (const command of [
    // The shell does not expand quoted heredocs or single quotes.
    "cat <<'EOF'\n$(rm -rf ~)\nEOF",
    'cat <<"EOF"\n`rm -rf ~`\nEOF',
    "echo '$(rm -rf ~)'",
    "echo '`rm -rf ~`'",
    // Ordinary substitutions keep running immediately.
    'echo "$(git rev-parse HEAD)"',
    "echo `date`",
    "git commit -m \"$(cat <<'EOF'\nfix: thing\n\nrm -rf ~ is mentioned here\nEOF\n)\"",
  ]) {
    assert.ok(runsImmediately(level(command)), JSON.stringify(command));
  }
});

// ---------------------------------------------------------------------------
// Windows / PowerShell cases
// ---------------------------------------------------------------------------

test("Windows drive root deletion is catastrophic", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  for (const command of [
    "Remove-Item -Recurse -Force C:\\",
    "Remove-Item -Recurse C:\\",
    "rd /s /q C:\\",
    "del /s /q C:\\Users",
  ]) {
    assert.equal(level(command), "Catastrophic", command);
    assert.equal(assess(command, win).level, "Catastrophic", command);
  }
});

test("PowerShell Remove-Item of the user home is catastrophic", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  assert.equal(assess("Remove-Item -Recurse -Force C:\\Users\\u", win).level, "Catastrophic");
  assert.equal(assess("Remove-Item -Recurse $env:USERPROFILE", win).level, "Catastrophic");
  assert.equal(assess("Remove-Item -Recurse ~", win).level, "Catastrophic");
});

test("PowerShell in-project cleanup runs immediately", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  for (const command of [
    "Remove-Item -Recurse target",
    "Remove-Item -Force build",
    "del *.tmp",
  ]) {
    assert.ok(
      runsImmediately(assess(command, win).level),
      `${command} should run, got ${assess(command, win).level}`,
    );
  }
});

test("del /s outside the project is low risk", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  assert.equal(assess("del /s C:\\Users\\u\\other", win).level, "Low");
});

test("Windows credential stores are protected", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  for (const command of [
    "Remove-Item -Recurse C:\\Users\\u\\.ssh",
    "Remove-Item -Recurse C:\\Users\\u\\.aws",
    "del /s C:\\Users\\u\\.gnupg",
  ]) {
    assert.equal(assess(command, win).level, "Catastrophic", command);
  }
});

test("Windows drive root via redirection is catastrophic", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  assert.equal(assess("echo x > C:\\", win).level, "Catastrophic");
});

test("format of a drive is catastrophic", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  assert.equal(assess("format C: /q", win).level, "Catastrophic");
});

test("PowerShell pipeline to Remove-Item escalates", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  assert.ok(
    severity(assess("Get-ChildItem C:\\Users\\u | Remove-Item -Recurse -Force", win).level) >=
      severity("Confirm"),
  );
});

test("git destructive subcommands are covered and read-only ones are not", () => {
  const git = ctx();
  for (const command of [
    "git reset --hard HEAD",
    "git clean -fdx",
    "git clean -f",
    "git checkout -f main",
    "git branch -D feature",
  ]) {
    assert.ok(
      severity(assess(command, git).level) >= severity("Confirm"),
      `${command} must be guarded`,
    );
  }
  for (const command of ["git status", "git reset --help", "git log -1", "git branch"]) {
    assert.ok(runsImmediately(assess(command, git).level), `${command} should run`);
  }
});

test("Windows separators and quoted paths are handled", () => {
  const win = ctx({ workingDir: "C:\\Users\\u\\proj", homeDir: "C:\\Users\\u" });
  assert.equal(assess('Remove-Item "C:\\Users\\u\\proj\\build"', win).level, "Safe");
  assert.equal(assess("Remove-Item -Recurse C:\\Users\\u\\proj\\build", win).level, "Low");
  // A drive-rooted path outside the project is still a notable operation.
  assert.equal(assess("Remove-Item -Recurse C:\\Users\\u\\other", win).level, "Low");
});
