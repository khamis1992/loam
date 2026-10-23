/**
 * Minimal shell tokenizer, tuned for risk analysis rather than execution.
 *
 * Adapted from jcode (MIT) ref/command-risk/src/tokenize.rs
 * jcode: https://github.com/1jehuang/jcode — Copyright (c) 2025 Jeremy Huang.
 *
 * This deliberately does not implement POSIX shell. It implements just enough
 * to answer "which words are targets of a destructive command", and it is
 * written to **fail loud rather than quiet**: when it cannot understand
 * something it marks the segment as opaque so the caller escalates.
 *
 * PowerShell: the shell syntax (backtick escaping, quoted values, `;` and `|`
 * separators) is close enough to POSIX for the same tokenizer to find
 * `Remove-Item`, `del`, `rm` and their targets. Only the flag spellings differ,
 * which the assessor handles.
 */

/** One shell word plus the classification bits the assessor needs. */
export interface Token {
  text: string;
  /** True when this segment's stdin comes from a pipe, so its operands are
   *  partly supplied at runtime by the previous command. */
  receivesPipe: boolean;
  /** True for `>` / `>|` redirect destinations, which are truncated on open. */
  isTruncatingRedirectTarget: boolean;
  /** True for control operators like `&&`, which are never path targets. */
  isOperator: boolean;
}

export function word(text: string): Token {
  return { text, receivesPipe: false, isTruncatingRedirectTarget: false, isOperator: false };
}

/** The command name without its directory, so `/bin/rm` matches `rm`.
 *  Lowercased because PowerShell cmdlets are case-insensitive: `Remove-Item`,
 *  `remove-item` and `REMOVE-ITEM` are the same built-in. */
export function basename(text: string): string {
  const stripped = text.replace(/[\\/]+$/, "");
  const sep = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return (sep >= 0 ? stripped.slice(sep + 1) : stripped).toLowerCase();
}

/** Whether a token is an option (`-rf`, `--recursive`), a flag of any shell.
 *  Windows `cmd.exe` switches (`/s`, `/q`) are single letters, so a path such
 *  as `/sys` is never mistaken for one. */
export function isFlag(text: string): boolean {
  return (text.startsWith("-") && text.length > 1) || /^\/[A-Za-z]$/.test(text);
}

/** Whether this flag requests recursion, including bundles like `-rf`.
 *  PowerShell's `-Recurse` and its abbreviations are covered too. */
export function isRecursiveFlag(text: string): boolean {
  if (!isFlag(text)) return false;
  if (text.startsWith("--")) return text === "--recursive";
  const body = text.slice(1);
  // PowerShell long form: `-Recurse`, possibly abbreviated (`-Rec`). Requiring
  // three or more characters keeps `-Remove` from reading as recursion.
  if (body.length >= 3 && /^[A-Z]/.test(body) && "recurse".startsWith(body.toLowerCase())) {
    return true;
  }
  // Short bundles (`-rf`, `-fr`, `-Rf`) and single letters (`-r`, `-R`).
  return body.length <= 2 && /^[a-zA-Z]+$/.test(body) && /[rR]/.test(body);
}

/** Characters that separate one command from the next. */
const SEGMENT_SEPARATORS = ["&&", "||", ";", "|", "\n", "(", ")"];

/** Split a command line into individual command segments, each tokenized.
 *
 *  `rm -rf a && rm -rf b` yields two segments so both are assessed. Without
 *  this, chaining would be a trivial bypass. */
export function splitSegments(command: string): Token[][] {
  const tokens = tokenize(command);
  const segments: Token[][] = [];
  let current: Token[] = [];

  let nextReceivesPipe = false;
  for (const token of tokens) {
    if (token.isOperator && SEGMENT_SEPARATORS.includes(token.text)) {
      if (current.length > 0) segments.push(current);
      current = [];
      // The command after `|` consumes the previous one's output as operands,
      // which this parser cannot see (#604 review).
      nextReceivesPipe = token.text === "|";
      continue;
    }
    current.push({ ...token, receivesPipe: nextReceivesPipe });
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** True when a backslash here separates Windows path components instead of
 *  escaping the following character (`C:\`, `\\server\share`). */
function isWindowsSeparator(current: string, next: string | undefined): boolean {
  if (/^[A-Za-z]:$/.test(current)) return true;
  if (/^[A-Za-z]:[\\/]/.test(current)) return true;
  if (/^[\\/][\\/]/.test(current)) return true;
  return current === "" && next === "\\";
}

/** Whether a Windows path separator already appears in a partial word, so a
 *  following space is part of the path (`C:\Program Files`) rather than a split.
 *  Only drive roots and UNC prefixes count: a leading `/` on POSIX is an
 *  absolute path, not a Windows separator. */
function hasWindowsSeparator(current: string): boolean {
  return /^[A-Za-z]:/.test(current) || /^[\\/][\\/]/.test(current);
}

/** Tokenize a command line, resolving quotes so `rm "$HOME"` and `rm $HOME`
 *  produce the same target text.
 *
 *  Note the asymmetry with a real shell: we intentionally keep `$VAR` intact
 *  rather than expanding it, and the path layer treats an unexpanded variable
 *  as unknown-and-therefore-risky. */
export function tokenize(command: string): Token[] {
  const source = withoutHeredocBodies(command);
  const tokens: Token[] = [];
  let current = "";
  let hasContent = false;
  const chars = [...source];
  let index = 0;
  let pendingRedirect = false;

  const flush = (): void => {
    if (hasContent) {
      const token = word(current);
      if (pendingRedirect) {
        token.isTruncatingRedirectTarget = true;
        pendingRedirect = false;
      }
      hasContent = false;
      tokens.push(token);
    }
    current = "";
  };

  while (index < chars.length) {
    const c = chars[index]!;
    index += 1;
    switch (c) {
      case "'": {
        hasContent = true;
        while (index < chars.length) {
          const q = chars[index]!;
          index += 1;
          if (q === "'") break;
          current += q;
        }
        break;
      }
      case '"': {
        hasContent = true;
        while (index < chars.length) {
          const q = chars[index]!;
          index += 1;
          if (q === '"') break;
          if (
            q === "\\" &&
            index < chars.length &&
            ['"', "\\", "$", "`"].includes(chars[index]!)
          ) {
            current += chars[index]!;
            index += 1;
            continue;
          }
          current += q;
        }
        break;
      }
      case "\\": {
        // Windows paths use `\` as a separator, not an escape character, so
        // `C:\Users\u` must survive tokenizing intact.
        if (isWindowsSeparator(current, chars[index])) {
          hasContent = true;
          current += "\\";
          break;
        }
        if (index < chars.length) {
          hasContent = true;
          current += chars[index]!;
          index += 1;
        }
        break;
      }
      case "`": {
        // Backtick is PowerShell's escape character, and a backtick-escaped
        // backtick (`` ``) is a literal backtick in a path.
        if (index < chars.length) {
          hasContent = true;
          current += chars[index]!;
          index += 1;
        }
        break;
      }
      case "/": {
        // A `cmd.exe` switch is a single letter (`/s`, `/q`). Ending the token
        // here keeps `del /s C:\x` as three words instead of fusing the switch
        // into the path. POSIX absolute paths (`/bin/cat`) must still tokenize
        // whole, so only a switch at the very start of a word is special.
        if (/^\/[A-Za-z]$/.test(current) && /\s/.test(chars[index] ?? "")) {
          flush();
          break;
        }
        hasContent = true;
        current += "/";
        break;
      }
      case " ":
      case "\t": {
        // Inside a Windows path the space belongs to the path itself, so only
        // split when no drive root or UNC prefix has been seen. A bare drive
        // letter (`C:`) is a complete target, so a space ends it; a `cmd.exe`
        // switch (`/s`) is not a path either.
        const bareDriveRoot = /^[A-Za-z]:$/.test(current);
        if (bareDriveRoot || !hasWindowsSeparator(current)) flush();
        break;
      }
      case "\n":
      case ";":
        flush();
        tokens.push({ ...word(c), isOperator: true });
        break;
      case "&":
      case "|": {
        flush();
        let text = c;
        if (chars[index] === c) {
          text += c;
          index += 1;
        }
        tokens.push({ ...word(text), isOperator: true });
        break;
      }
      case "(":
      case ")":
        flush();
        tokens.push({ ...word(c), isOperator: true });
        break;
      case ">": {
        flush();
        // `>>` appends and does not truncate, so it is far less destructive;
        // only a single `>` clobbers.
        if (chars[index] === ">") {
          index += 1;
        } else if (chars[index] === "&") {
          // `>&N` / `>&-` duplicate or close a file descriptor and never name
          // a file to truncate. Consume the FD word.
          index += 1;
          let fd = "";
          while (index < chars.length && /[0-9\-]/.test(chars[index]!)) {
            fd += chars[index]!;
            index += 1;
          }
          if (fd === "") {
            // `>& file` (bash: redirect stdout+stderr) truncates.
            pendingRedirect = true;
          }
        } else {
          if (chars[index] === "|") index += 1;
          pendingRedirect = true;
        }
        break;
      }
      case "<":
        flush();
        break;
      default:
        hasContent = true;
        current += c;
        break;
    }
  }
  flush();

  return tokens;
}

/** Remove heredoc payloads before tokenizing shell source.
 *
 *  A heredoc body is input data for the command on the declaration line, not
 *  shell source in the surrounding command. Treating it as source makes prose
 *  containing `time`, or a script containing `rm`, trip the risk gate (#922).
 *  Newlines are retained so a command after the terminator remains a separate
 *  segment and cannot disappear from assessment. */
function withoutHeredocBodies(command: string): string {
  const lines = splitInclusive(command, "\n");
  let output = "";
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    output += line;
    const delimiters = heredocDelimiters(line.replace(/\n$/, ""));
    index += 1;

    for (const [delimiter, stripTabs] of delimiters) {
      while (index < lines.length) {
        let candidate = lines[index]!.replace(/[\r\n]$/, "");
        if (stripTabs) candidate = candidate.replace(/^\t+/, "");
        index += 1;
        if (candidate === delimiter) {
          output += "\n";
          break;
        }
      }
    }
  }

  return output;
}

/** Command sources that the shell runs through `$(...)` or backtick
 *  substitution but that `tokenize` flattens into a single word.
 *
 *  `echo "$(rm -rf ~)"`, `` echo `rm -rf ~` `` and an unquoted heredoc body
 *  containing `$(rm -rf ~)` all run `rm`, yet the word-level tokenizer never
 *  sees `rm` as a program (#1753). The caller assesses each returned source
 *  like a top-level command. Single-quoted text and quoted heredoc bodies are
 *  inert in the shell and are skipped. */
export function embeddedSubstitutions(command: string): string[] {
  const lines = splitInclusive(command, "\n");
  let shellSource = "";
  const found: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    shellSource += line;
    index += 1;
    for (const [delimiter, stripTabs, quoted] of heredocDelimiters(line.replace(/\n$/, ""))) {
      let body = "";
      while (index < lines.length) {
        const raw = lines[index]!;
        let candidate = raw.replace(/[\r\n]$/, "");
        if (stripTabs) candidate = candidate.replace(/^\t+/, "");
        index += 1;
        if (candidate === delimiter) {
          shellSource += "\n";
          break;
        }
        body += raw;
      }
      // An unquoted heredoc body still expands `$(...)` and backticks, but
      // quotes inside it are literal text.
      if (!quoted) scanSubstitutions(body, false, found);
    }
  }
  scanSubstitutions(shellSource, true, found);
  return found;
}

function scanSubstitutions(text: string, shellQuotes: boolean, found: string[]): void {
  const chars = [...text];
  let index = 0;
  let inDouble = false;

  while (index < chars.length) {
    const c = chars[index]!;
    switch (c) {
      case "\\":
        index += 2;
        break;
      case "'":
        if (shellQuotes && !inDouble) {
          index += 1;
          while (index < chars.length && chars[index] !== "'") index += 1;
          index += 1;
        } else {
          index += 1;
        }
        break;
      case '"':
        if (shellQuotes) inDouble = !inDouble;
        index += 1;
        break;
      case "$":
        if (chars[index + 1] === "(") {
          const [body, next] = matchingParenBody(chars, index + 2);
          found.push(body);
          index = next;
        } else {
          index += 1;
        }
        break;
      case "`": {
        let body = "";
        index += 1;
        while (index < chars.length && chars[index] !== "`") {
          if (
            chars[index] === "\\" &&
            index + 1 < chars.length &&
            ["`", "\\", "$"].includes(chars[index + 1]!)
          ) {
            body += chars[index + 1]!;
            index += 2;
            continue;
          }
          body += chars[index]!;
          index += 1;
        }
        index += 1;
        found.push(body);
        break;
      }
      default:
        index += 1;
        break;
    }
  }
}

/** The text of a `$(...)` body starting at `start`, plus the index after its
 *  closing paren. An unterminated body runs to the end of the input, which
 *  keeps it assessed rather than silently dropped. */
function matchingParenBody(chars: string[], start: number): [string, number] {
  let depth = 1;
  let quote: string | null = null;
  let index = start;

  while (index < chars.length) {
    const c = chars[index]!;
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (quote !== null) {
      if (c === "\\") index += 1;
      else if (c === '"') quote = null;
    } else if (c === "\\") {
      index += 1;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) return [chars.slice(start, index).join(""), index + 1];
    }
    index += 1;
  }
  return [chars.slice(Math.min(start, chars.length)).join(""), chars.length];
}

/** Heredoc declarations on one line: `[delimiter, stripTabs, quoted]`.
 *  A quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) makes the body inert. */
export function heredocDelimiters(line: string): Array<[string, boolean, boolean]> {
  const bytes = [...line];
  const found: Array<[string, boolean, boolean]> = [];
  let index = 0;
  // Quote state per command-substitution level. `"$(cat <<'EOF'` opens a new
  // shell context inside the double quotes, so a heredoc declared there is real
  // and its body must still be stripped.
  const quotes: Array<string | null> = [null];

  while (index + 1 < bytes.length) {
    const byte = bytes[index]!;
    const quote = quotes[quotes.length - 1] ?? null;
    if (quote !== "'" && byte === "$" && bytes[index + 1] === "(") {
      quotes.push(null);
      index += 2;
      continue;
    }
    if (quote === null && byte === ")" && quotes.length > 1) {
      quotes.pop();
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (byte === "\\" && quote === '"') {
        index += 2;
        continue;
      }
      if (byte === quote) quotes[quotes.length - 1] = null;
      index += 1;
      continue;
    }
    if (byte === "'" || byte === '"') {
      quotes[quotes.length - 1] = byte;
      index += 1;
      continue;
    }
    if (byte === "\\") {
      index += 2;
      continue;
    }
    if (byte !== "<" || bytes[index + 1] !== "<") {
      index += 1;
      continue;
    }

    index += 2;
    // `<<<` is a here-string, not a multiline heredoc.
    if (bytes[index] === "<") {
      index += 1;
      continue;
    }
    const stripTabs = bytes[index] === "-";
    if (stripTabs) index += 1;
    while (index < bytes.length && /\s/.test(bytes[index]!)) index += 1;

    let delimiter = "";
    let delimiterQuote: string | null = null;
    let quoted = false;
    while (index < bytes.length) {
      const b = bytes[index]!;
      if (b === "'" || b === '"' || b === "\\") quoted = true;
      if (delimiterQuote !== null) {
        if (b === delimiterQuote) {
          delimiterQuote = null;
        } else if (b === "\\" && delimiterQuote === '"' && index + 1 < bytes.length) {
          index += 1;
          delimiter += bytes[index]!;
        } else {
          delimiter += b;
        }
      } else if (b === "'" || b === '"') {
        delimiterQuote = b;
      } else if (b === "\\" && index + 1 < bytes.length) {
        index += 1;
        delimiter += bytes[index]!;
      } else if (/\s/.test(b) || b === ";" || b === "&" || b === "|") {
        break;
      } else {
        delimiter += b;
      }
      index += 1;
    }
    if (delimiter !== "") found.push([delimiter, stripTabs, quoted]);
  }

  return found;
}

/** `split_inclusive` equivalent: keeps the separator at the end of each part. */
function splitInclusive(text: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const at = text.indexOf(sep, start);
    if (at === -1) {
      out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, at + sep.length));
    start = at + sep.length;
  }
}
