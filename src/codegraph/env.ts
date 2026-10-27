/**
 * Child-process environment for graphify. Built by ALLOWLIST, never by copying
 * process.env: graphify auto-selects an LLM provider from whichever API key it
 * finds (OBSERVED README "Data residency": Gemini -> Kimi -> Claude -> OpenAI ->
 * DeepSeek -> Azure -> Bedrock -> Ollama). Loam's own process holds keys such as
 * OPENCODE_API_KEY, so inheriting would be a data-egress risk.
 */
export const CHILD_ENV_PASSTHROUGH: readonly string[] = [
  // Windows process basics
  "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  // POSIX basics (dev on Linux/macOS)
  "HOME", "LANG", "LC_ALL", "TMPDIR",
];

/** Fixed variables Loam always sets for graphify. */
export const CHILD_ENV_FIXED: Readonly<Record<string, string>> = {
  GRAPHIFY_BACKEND: "none",          // disable every LLM backend (OBSERVED README Privacy)
  GRAPHIFY_QUERY_LOG_DISABLE: "1",   // no ~/.cache/graphify-queries.log (OBSERVED README Privacy)
  PYTHONUTF8: "1",                   // UTF-8 stdio on Windows code pages
  PYTHONIOENCODING: "utf-8",
  PYTHONNOUSERSITE: "1",             // ignore user site-packages (supply-chain hygiene)
  PYTHONDONTWRITEBYTECODE: "1",
  NO_COLOR: "1",
};

/** Build the child env. `pathPrepend` = venv Scripts/bin; `gitDir` = directory holding git(.exe), if any. */
export function buildChildEnv(opts: {
  source?: NodeJS.ProcessEnv;
  pathPrepend: string[];
  gitDir?: string | null;
  maxWarmGraphs?: number;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const src = opts.source ?? process.env;
  const platform = opts.platform ?? process.platform;
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_PASSTHROUGH) {
    const v = src[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  const sep = platform === "win32" ? ";" : ":";
  const sys = platform === "win32"
    ? [`${src.SystemRoot ?? src.SYSTEMROOT ?? "C:\\Windows"}\\System32`, `${src.SystemRoot ?? src.SYSTEMROOT ?? "C:\\Windows"}`]
    : ["/usr/bin", "/bin"];
  const parts = [...opts.pathPrepend, ...(opts.gitDir ? [opts.gitDir] : []), ...sys];
  out[platform === "win32" ? "Path" : "PATH"] = parts.join(sep);
  Object.assign(out, CHILD_ENV_FIXED);
  if (opts.maxWarmGraphs) out.GRAPHIFY_MAX_CONTEXTS = String(opts.maxWarmGraphs);
  return out;
}

/** Names that must never reach the child, used by the unit test as a tripwire. */
export const FORBIDDEN_ENV_PATTERN = /(API_KEY|_TOKEN|SECRET|PASSWORD|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|MOONSHOT|DEEPSEEK|AZURE_OPENAI|AWS_|OLLAMA|GRAPHIFY_OUT|GRAPHIFY_API_KEY|OPENCODE)/i;
