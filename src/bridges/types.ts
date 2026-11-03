/** App bridge types: a manifest declares an installed program's CLI as data. */

/** What a command can do to the machine; decides whether approval is needed. */
export type BridgeEffect = "read" | "write_workspace" | "exec_script" | "external";

export type ParamType = "string" | "path" | "number" | "enum";

export interface BridgeParam {
  type: ParamType;
  description?: string;
  required?: boolean;
  /** Allowed values for `enum`. */
  values?: string[];
  /** For `path`: `read` may point anywhere readable, `write` must stay in the workspace. */
  access?: "read" | "write";
}

/** One argv token, or a group that is emitted only when `when` was supplied. */
export type ArgvToken = string | { when: string; args: string[] };

export interface BridgeCommand {
  id: string;
  description: string;
  effect: BridgeEffect;
  argv: ArgvToken[];
  params: Record<string, BridgeParam>;
  /** How stdout is parsed into the result envelope. `base64` preserves binary output; `jsonl` preserves each JSON object untruncated. */
  output: "json" | "text" | "base64" | "jsonl";
  /** Per-command environment overrides (e.g. sanitize a broken provider config). */
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface BridgeProbe {
  /** Executable names looked up with `where.exe`, in order. */
  names: string[];
  /** Absolute install candidates; `%VAR%` segments are expanded. */
  paths?: string[];
  /** Executable names registered under the App Paths registry key. */
  appPaths?: string[];
}

export interface BridgeManifest {
  id: string;
  name: string;
  description: string;
  probe: BridgeProbe;
  /** Args that print a version string, used to confirm the program runs. */
  versionArgs?: string[];
  commands: BridgeCommand[];
}

export type BridgeStatus = "ready" | "disabled" | "missing" | "error";

export interface BridgeInfo {
  id: string;
  name: string;
  description: string;
  status: BridgeStatus;
  enabled: boolean;
  exePath?: string;
  version?: string;
  detail?: string;
  commands: { id: string; description: string; effect: BridgeEffect }[];
}

/** Result envelope handed back to the model. */
export interface BridgeEnvelope {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Parsed JSON when `output: "json"` and stdout parsed; otherwise text. */
  data?: unknown;
  text?: string;
  error?: { type: string; message: string };
}
