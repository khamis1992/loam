/**
 * Deterministic risk classification for shell commands.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/lib.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * # Why this exists
 *
 * Loam executes shell tool calls with no classifier of its own: a model that
 * decides to run `rm -rf ~` is obeyed immediately. That is issue #604, where a
 * user lost their home directory.
 *
 * # Design
 *
 * This module is **stage 1** of a two-stage cascade: a cheap, deterministic,
 * high-recall filter. It never calls a model and never touches the network, so
 * it costs nothing on the overwhelmingly common safe path. Stage 2 (the
 * reflection gate, see ./gate.ts) only runs when this returns something other
 * than `RiskLevel.Safe`.
 *
 * Two deliberate choices:
 *
 * 1. **Classify by blast radius, not by command name.** A denylist of `rm -rf`
 *    misses `find -delete`, `shred`, `truncate`, `dd`, and `>file`. We ask
 *    "what would this destroy, and can it be undone" instead.
 * 2. **Bias hard toward recall.** A false positive costs one reflection turn. A
 *    false negative costs a home directory. When parsing is ambiguous we
 *    escalate rather than allow.
 *
 * # Honest limitations
 *
 * This is defense in depth, not a sandbox. A determined or unlucky
 * `sh -c "$(printf ...)"` can defeat any static parser, which is exactly why
 * `RiskLevel.Confirm` is a reflection prompt rather than a hard block, and why
 * the catastrophic tier is a small, absolute, path-based deny that does not
 * depend on parsing the command correctly.
 */

import { classifyTarget, expand, isSafeRedirectSink } from "./paths.js";
import {
  basename,
  embeddedSubstitutions,
  isFlag,
  isRecursiveFlag,
  splitSegments,
  type Token,
} from "./tokenize.js";

/** How dangerous a command looks, and therefore how much scrutiny it earns.
 *  The ordering matters: findings take the maximum. */
export type RiskLevel = "Safe" | "Low" | "Confirm" | "Catastrophic";

const RISK_ORDER: Record<RiskLevel, number> = { Safe: 0, Low: 1, Confirm: 2, Catastrophic: 3 };

export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Whether execution may proceed without a reflection turn. */
export function runsImmediately(level: RiskLevel): boolean {
  return level === "Safe" || level === "Low";
}

/** Whether any confirmation could ever unlock this. */
export function isAbsoluteDeny(level: RiskLevel): boolean {
  return level === "Catastrophic";
}

/** Numeric severity, so `>=` comparisons read like the Rust `RiskLevel` ordering. */
export function severity(level: RiskLevel): number {
  return RISK_ORDER[level];
}

/** A specific reason a command was flagged, used to explain the refusal. */
export interface RiskFinding {
  level: RiskLevel;
  /** Human-readable explanation, shown to the model verbatim. */
  reason: string;
  /** The concrete path or argument that triggered this, when there is one. */
  target?: string;
}

/** The full verdict for one command. */
export interface RiskAssessment {
  level: RiskLevel;
  findings: RiskFinding[];
  /** The refusal text shown to the model, phrased to force a comparison
   *  against what the user actually asked for rather than a yes/no reflex. */
  explanation(): string;
}

/** Attach `explanation` as a non-enumerable method so structural comparison of
 *  assessments (tests, logs) is unaffected by its presence. */
function withExplanation(
  assessment: { level: RiskLevel; findings: RiskFinding[] },
): RiskAssessment {
  const self = assessment as RiskAssessment;
  Object.defineProperty(self, "explanation", {
    value: () => explanation(self),
    enumerable: false,
  });
  return self;
}

function safe(): RiskAssessment {
  return withExplanation({ level: "Safe", findings: [] });
}

function fromFindings(findings: RiskFinding[]): RiskAssessment {
  const level = findings.reduce<RiskLevel>(
    (acc, finding) => (RISK_ORDER[finding.level] > RISK_ORDER[acc] ? finding.level : acc),
    "Safe",
  );
  return withExplanation({ level, findings });
}

/** The refusal text for an assessment: one bullet per finding, naming the
 *  concrete target where there is one. */
export function explanation(assessment: { level: RiskLevel; findings: RiskFinding[] }): string {
  return assessment.findings
    .map((finding) => `- ${finding.reason}${finding.target ? ` (target: ${finding.target})` : ""}`)
    .join("\n");
}

/** Context needed to judge blast radius. Supplied by the caller because this
 *  classifier deliberately does no I/O of its own beyond path inspection. */
export interface RiskContext {
  /** The tool call's working directory, if any. */
  workingDir?: string;
  /** The user's home directory. */
  homeDir?: string;
  /** Dedicated scratch directory supplied to the command. */
  scratchDir?: string;
}

/** Commands that destroy data as their primary purpose.
 *
 *  Presence here does not by itself mean danger: `rm` inside the working
 *  directory is routine. It means "inspect the targets".
 *
 *  Windows aliases are included so a PowerShell session is classified by the
 *  same rules as bash: `Remove-Item` is the built-in for `del`/`rm`, and
 *  `del`/`erase`/`rd`/`rmdir` are its aliases. */
const DESTRUCTIVE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "shred",
  "unlink",
  "truncate",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "wipefs",
  "srm",
  // Windows / PowerShell
  "remove-item",
  "del",
  "erase",
  "rd",
  "ri",
  "format",
  "diskpart",
  "cipher",
]);

/** Commands that run another command. The real program is one of their
 *  arguments, so `sudo rm -rf ~` must be unwrapped before classification or the
 *  destructive verb is never seen at all. */
const WRAPPER_COMMANDS = new Set([
  "sudo",
  "doas",
  "env",
  "nice",
  "ionice",
  "time",
  "timeout",
  "nohup",
  "xargs",
  "command",
  "builtin",
  "exec",
  "setsid",
  "stdbuf",
  "chroot",
  "su",
  "watch",
  "eval",
]);

/** Shell grammar words that may prefix the actual command in a segment. */
const SHELL_CONTROL_PREFIXES = new Set([
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "case",
  "in",
  "select",
]);

/** Shells, which take their program from a string argument we cannot parse
 *  reliably. Treated as opaque rather than assumed safe. */
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"]);

/** Commands that are destructive only with specific flags. */
const CONDITIONALLY_DESTRUCTIVE: Array<[string, string[]]> = [
  ["chmod", ["-R"]],
  ["chown", ["-R"]],
];

/** Whether a wrapper option consumes the following word. Option spelling is
 *  wrapper-specific: `nice -n 10` takes a value, while `sudo -n ls` does not. */
function wrapperFlagTakesValue(wrapper: string, flag: string): boolean {
  switch (wrapper) {
    case "sudo":
    case "doas":
      return ["-u", "--user", "-g", "--group", "-C"].includes(flag);
    case "env":
      return ["-u", "--unset", "-C", "--chdir"].includes(flag);
    case "nice":
      return ["-n", "--adjustment"].includes(flag);
    case "ionice":
      return ["-c", "--class", "-n", "--classdata", "-p", "--pid"].includes(flag);
    case "timeout":
      return ["-s", "--signal", "-k", "--kill-after"].includes(flag);
    case "xargs":
      return ["-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"].includes(flag);
    case "chroot":
      return ["--userspec", "--groups"].includes(flag);
    default:
      return false;
  }
}

/** Whether a destructive finding from a `git` subcommand means the command
 *  actually destroys work. `git reset --hard` discards uncommitted changes and
 *  `git clean -fdx` deletes untracked files, but `git reset` alone is read-only.
 *  Matching only the subcommand keeps `git reset --help` from escalating. */
const DESTRUCTIVE_GIT_SUBCOMMANDS = ["clean", "reset", "branch", "checkout"];

function isGitDestructive(rest: Token[]): boolean {
  const args = rest.slice(1).filter((t) => !isFlag(t.text) && !t.isOperator);
  const subcommand = args.find((t) => !isFlag(t.text));
  if (!subcommand) return false;
  const name = subcommand.text.toLowerCase();
  if (!DESTRUCTIVE_GIT_SUBCOMMANDS.includes(name)) return false;
  if (name === "reset" || name === "checkout" || name === "branch") {
    // `--hard` / `-f` / `--force` are what make these destructive.
    return rest.some((t) => ["--hard", "-f", "--force", "-D"].includes(t.text));
  }
  return true;
}

/** Assess a single shell command string.
 *
 *  This is the classifier's entry point and is intentionally total: any input,
 *  including garbage, produces an assessment rather than an error. */
export function assess(command: string, ctx: RiskContext = {}): RiskAssessment {
  const findings: RiskFinding[] = [];
  // Keep the trusted context for literal protected paths, but never approve
  // commands whose own assignments can invalidate known-variable expansion.
  if (command.includes("HOME=") || command.includes("JCODE_SCRATCH_DIR=")) {
    findings.push({
      level: "Confirm",
      reason: "command reassigns a path variable used by risk assessment",
    });
  }

  for (const segment of splitSegments(command)) {
    assessSegment(segment, ctx, findings);
  }

  // `"$(...)"`, backticks and unquoted heredoc bodies run commands the word
  // tokenizer flattens into literals (#1753). Each body is strictly shorter than
  // its parent, so the recursion terminates.
  for (const source of embeddedSubstitutions(command)) {
    for (const finding of assess(source, ctx).findings) {
      if (!findings.some((existing) => sameFinding(existing, finding))) findings.push(finding);
    }
  }

  if (findings.length === 0) return safe();
  return fromFindings(findings);
}

function sameFinding(a: RiskFinding, b: RiskFinding): boolean {
  return a.level === b.level && a.reason === b.reason && a.target === b.target;
}

function assessSegment(tokens: Token[], ctx: RiskContext, findings: RiskFinding[]): void {
  // Shell redirects happen even when a wrapper only prints information.
  for (const target of tokens.filter((t) => t.isTruncatingRedirectTarget)) {
    if (isSafeRedirectSink(target.text)) continue;
    const expanded = expand(target.text, ctx);
    const finding = classifyTarget(expanded, target.text, false, ctx);
    if (finding) findings.push(finding);
  }

  // Strip wrapper programs (`sudo`, `env`, `xargs`, ...) so the destructive
  // verb underneath is the one we classify. Without this, any common prefix is a
  // complete bypass.
  let rest = tokens;
  while (rest.length > 1 && SHELL_CONTROL_PREFIXES.has(rest[0]!.text)) {
    rest = rest.slice(1);
  }

  let wrappedBy: string | undefined;
  for (;;) {
    const first = rest[0];
    if (!first) {
      // Ran off the end while unwrapping: the payload is invisible.
      if (wrappedBy) {
        findings.push({
          level: "Confirm",
          reason: `\`${wrappedBy}\` runs another command that could not be identified statically`,
        });
      }
      return;
    }
    const name = basename(first.text);
    if (!WRAPPER_COMMANDS.has(name)) break;

    // `command -v/-V` describes names, including names of wrappers. Only
    // inspect the option prefix, never options belonging to its payload.
    if (
      name === "command" &&
      rest
        .slice(1)
        .filter((t) => isFlag(t.text) && t.text !== "--")
        .some(
          (t) =>
            !t.text.startsWith("--") &&
            (t.text.slice(1).includes("v") || t.text.slice(1).includes("V")),
        )
    ) {
      return;
    }
    wrappedBy = name;

    // Skip the wrapper plus its own options and `VAR=value` assignments, landing
    // on the wrapped program. Options that take a separate value (`nice -n 10`,
    // `timeout 5`) must consume that value too.
    const args = rest.slice(1);
    let idx = 0;
    while (idx < args.length) {
      const token = args[idx]!;
      if (
        name === "env" &&
        (token.text.startsWith("--split-string") ||
          (token.text.startsWith("-") && !token.text.startsWith("--") && token.text.includes("S")))
      ) {
        findings.push({
          level: "Confirm",
          reason: "`env` split-string payload cannot be identified statically",
        });
        return;
      }
      if (token.isOperator || token.text.includes("=")) {
        idx += 1;
        continue;
      }
      if (isFlag(token.text)) {
        idx += 1;
        // A short flag known to take an argument consumes the next word.
        if (wrapperFlagTakesValue(name, token.text) && idx < args.length) idx += 1;
        continue;
      }
      // A bare number is an operand of the wrapper itself (`timeout 5`), not the
      // program to run.
      if (/^[0-9.]+$/.test(token.text)) {
        idx += 1;
        continue;
      }
      break;
    }
    if (name === "env" && idx === args.length) return;
    rest = args.slice(idx);
  }

  const program = rest[0];
  if (!program) {
    // A wrapper with nothing recognizable after it hides its payload.
    if (wrappedBy) {
      findings.push({
        level: "Confirm",
        reason: `\`${wrappedBy}\` runs another command that could not be identified statically`,
      });
    }
    return;
  }
  const programName = basename(program.text);

  if (programName === "find") {
    assessFind(rest, ctx, findings);
    return;
  }

  // A shell invoked with an inline script is opaque to this parser. Assess the
  // script text too, so `sh -c "rm -rf ~"` is not a free pass.
  if (SHELL_COMMANDS.has(programName)) {
    for (const token of rest.slice(1).filter((t) => !isFlag(t.text))) {
      for (const segment of splitSegments(token.text)) {
        assessSegment(segment, ctx, findings);
      }
    }
    return;
  }

  // A destructive `git` subcommand discards work that is not recoverable. Its
  // arguments are revisions and ref names rather than paths, so the blast radius
  // cannot be derived from them: ask instead of guessing. Read-only subcommands
  // (`git status`, `git reset --help`) fall through untouched.
  if (programName === "git") {
    if (isGitDestructive(rest)) {
      findings.push({
        level: "Confirm",
        reason: "`git` subcommand can discard or delete work that is not recoverable",
      });
    }
    return;
  }

  const conditionalFlags = CONDITIONALLY_DESTRUCTIVE.find(([name]) => name === programName)?.[1];
  const isDestructive =
    DESTRUCTIVE_COMMANDS.has(programName) ||
    (conditionalFlags !== undefined && rest.some((t) => conditionalFlags.includes(t.text)));
  if (!isDestructive) return;

  const targets = rest
    .slice(1)
    .filter((t) => !isFlag(t.text) && !t.isOperator && !t.isTruncatingRedirectTarget);

  // A destructive command fed by a pipe takes its operands from the previous
  // command's output, which we cannot enumerate. `find ~ -type f | xargs rm` is a
  // real deletion of home contents that neither segment reveals on its own, so
  // escalate rather than trust the visible arguments.
  if (program.receivesPipe) {
    findings.push({
      level: "Confirm",
      reason: `\`${programName}\` deletes paths supplied by a pipe, so the set of affected files cannot be checked before it runs`,
    });
  }

  // A destructive program with no parsable target is more suspicious, not less:
  // we could not see what it would touch.
  if (targets.length === 0) {
    findings.push({
      level: "Confirm",
      reason: `\`${programName}\` is destructive but its target could not be determined statically, so its blast radius is unknown`,
    });
    return;
  }

  // Flags belonging to a read-only command are not deletion flags. In
  // particular, the `r` in `find -printf` must not turn a redirect into a
  // recursive deletion.
  const recursive = rest.some((t) => isRecursiveFlag(t.text));

  for (const target of targets) {
    // `dd`-style `key=value` operands hide the path from a naive scan.
    const eq = target.text.indexOf("=");
    const key = eq >= 0 ? target.text.slice(0, eq) : "";
    const raw =
      eq >= 0 && ["of", "if", "seek", "conv"].includes(key) ? target.text.slice(eq + 1) : target.text;
    const expanded = expand(raw, ctx);
    const finding = classifyTarget(expanded, raw, recursive, ctx);
    if (finding) findings.push(finding);
  }
}

/** Find actions run a separate argv. Search roots are deletion targets only for
 *  -delete or a destructive action, not for read-only inspection. */
function assessFind(tokens: Token[], ctx: RiskContext, findings: RiskFinding[]): void {
  const roots = tokens
    .slice(1)
    .filter((t) => !["-H", "-L", "-P", "--"].includes(t.text))
    .filter((t) => !isFlag(t.text) && !t.isOperator && !["!", "("].includes(t.text))
    .filter((t) => !t.isTruncatingRedirectTarget)
    .map((t) => t.text);

  const classifyRoots = (): void => {
    for (const raw of roots.length > 0 ? roots : ["."]) {
      const expanded = expand(raw, ctx);
      const finding = classifyTarget(expanded, raw, true, ctx);
      if (finding) findings.push(finding);
    }
  };

  let index = 1;
  while (index < tokens.length) {
    const text = tokens[index]!.text;
    if (text === "-delete") {
      classifyRoots();
    } else if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(text)) {
      const target = tokens[index + 1];
      if (target && !isSafeRedirectSink(target.text)) {
        const expanded = expand(target.text, ctx);
        const finding = classifyTarget(expanded, target.text, false, ctx);
        if (finding) findings.push(finding);
      } else if (!target) {
        findings.push({
          level: "Confirm",
          reason: "`find` output target cannot be identified statically",
        });
      }
      index += text === "-fprintf" ? 2 : 1;
    } else if (
      [
        "-name",
        "-iname",
        "-path",
        "-ipath",
        "-wholename",
        "-iwholename",
        "-regex",
        "-iregex",
        "-lname",
        "-ilname",
        "-printf",
      ].includes(text)
    ) {
      index += 1;
    } else if (["-exec", "-execdir", "-ok", "-okdir"].includes(text)) {
      const start = index + 1;
      const relativeEnd = tokens.slice(start).findIndex((t) => t.text === ";" || t.text === "+");
      const end = relativeEnd >= 0 ? start + relativeEnd : tokens.length;
      const payload = tokens.slice(start, end);
      const nested: RiskFinding[] = [];
      if (!readOnlyFindPayload(payload) || end === tokens.length) {
        assessSegment(payload, ctx, nested);
        if (payload.some((t) => t.text.includes("{}"))) {
          for (const root of roots.length > 0 ? roots : ["."]) {
            const substituted: Token[] = payload.map((token) => ({
              ...token,
              text: token.text.replaceAll("{}", root),
            }));
            assessSegment(substituted, ctx, nested);
          }
        }
        findings.push(...nested);
        findings.push({
          level: "Confirm",
          reason:
            "`find` action may modify files and its full effects cannot be determined statically",
        });
      }
      index = end;
    }
    index += 1;
  }
}

function readOnlyFindPayload(tokens: Token[]): boolean {
  const program = tokens[0];
  if (!program) return false;
  const name = basename(program.text);
  if (name === "cat" || name === "readlink") return true;
  // Sed can execute commands or write files even without -i. Recognize only
  // simple print scripts rather than guessing about arbitrary code.
  if (name === "sed") {
    const args = tokens.slice(1).map((t) => t.text);
    const scriptIndex = args[0] === "-n" ? 1 : 0;
    const script = args[scriptIndex];
    if (script === undefined) return false;
    const trimmed = script.endsWith("p") ? script.slice(0, -1) : script;
    return (
      script.endsWith("p") &&
      [...trimmed].every((c) => /[0-9]/.test(c) || c === "," || c === "$") &&
      args.slice(scriptIndex + 1).every((arg) => !arg.startsWith("-"))
    );
  }
  return false;
}

/** Re-exported so callers need only import this module. */
export { splitSegments, tokenize, embeddedSubstitutions, type Token } from "./tokenize.js";
export {
  classifyTarget,
  expand,
  expandKnownPrefix,
  isCatastrophicTarget,
  isSafeRedirectSink,
  isTempPath,
  normalize,
} from "./paths.js";
export { basename, isFlag, isRecursiveFlag } from "./tokenize.js";
