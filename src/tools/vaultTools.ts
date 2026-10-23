/**
 * Vault reference tools (promptwire): let the model name a stored secret and
 * hand it a reference string without ever seeing the value.
 *
 * The encrypted vault (src/server/secretsVault.ts) is the only place a value is
 * unsealed. `vault_ref` lists NAMES only; `resolveVaultRefs` replaces
 * `{{vault:NAME}}` with the plaintext value and registers it with the log
 * redactor; `planVaultEnv`/`redactVaultValues` let `shell_run` inject the value
 * straight into the child process environment and scrub it from the output.
 */
import { listSecrets, resolveSecret } from "../server/secretsVault.js";
import { registerSecretValue } from "../log.js";
import { LruCache } from "../memory/cache.js";
import { registerCacheStats } from "../memory/stats.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

const VAULT_NAME_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const VAULT_REF_RE = /\{\{vault:([A-Za-z0-9_.-]+)\}\}/g;

/** Scope used when the run context carries no agent id. */
export const VAULT_GLOBAL_SCOPE = "global";

/** Resolved value -> secret name, so redaction can name the ref, not the value.
 *  Bounded (J6): every resolved secret is retained for redaction, so an agent
 *  that resolves many distinct secrets in one session must not grow this map. */
const vaultValueNames = new LruCache<string>({ capacity: 256, name: "vault-value-names" });
registerCacheStats("vault-value-names", () => vaultValueNames.stats());

/** Vault scope for a run: the agent id when known, else "global". */
export function vaultScope(ctx: ToolContext): string {
  const id = ctx.agentId?.trim();
  return id ? id : VAULT_GLOBAL_SCOPE;
}

/** The reference string the model embeds for a secret name. */
export function vaultRef(name: string): string {
  return `{{vault:${name}}}`;
}

/** Environment variable name used to hand a resolved value to a child process. */
export function vaultEnvVarName(name: string): string {
  return `LOAM_VAULT_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Distinct secret names referenced by `text`. */
export function vaultRefNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(VAULT_REF_RE)) {
    const name = m[1];
    if (name) names.add(name);
  }
  return [...names];
}

function rememberSecret(name: string, value: string): void {
  vaultValueNames.set(value, name);
  registerSecretValue(value);
}

/**
 * Replace every `{{vault:NAME}}` in `text` with its resolved value and register
 * each value for log redaction. Throws on the first unknown name.
 */
export function resolveVaultRefs(text: string, scope: string): { text: string; secrets: string[] } {
  const secrets: string[] = [];
  const resolved = text.replace(VAULT_REF_RE, (_m, name: string) => {
    const value = resolveSecret(scope, name);
    if (value === null) throw new Error(`vault secret "${name}" not found in vault "${scope}"`);
    rememberSecret(name, value);
    if (!secrets.includes(value)) secrets.push(value);
    return value;
  });
  return { text: resolved, secrets };
}

/**
 * Replace resolved vault values in `output` with `[vault:NAME]` markers so a
 * child process's echo of a secret never reaches model context.
 */
export function redactVaultValues(output: string, secrets: string[]): string {
  let out = output;
  for (const value of secrets) {
    if (!value || !out.includes(value)) continue;
    const name = vaultValueNames.get(value);
    out = out.split(value).join(name ? `[vault:${name}]` : "[vault]");
  }
  return out;
}

export interface VaultEnvPlan {
  /** Extra env vars to inject (LOAM_VAULT_<NAME> -> resolved value). */
  env: Record<string, string>;
  /** Resolved value per secret name. */
  values: Record<string, string>;
  /** Resolved values, for output redaction. */
  secrets: string[];
  /** Rewrite refs to the platform's env-var reference (no inlining). */
  rewrite: (text: string) => string;
  /** Rewrite refs to the resolved value (for env values, which go to env as-is). */
  inline: (text: string) => string;
}

/**
 * Resolve vault refs found in `texts` (a command and/or env values) into a child
 * environment. Throws on the first unknown name.
 */
export function planVaultEnv(texts: string[], scope: string): VaultEnvPlan {
  const env: Record<string, string> = {};
  const values: Record<string, string> = {};
  const secrets: string[] = [];
  const names = new Set<string>();
  for (const text of texts) for (const name of vaultRefNames(text)) names.add(name);
  for (const name of names) {
    const value = resolveSecret(scope, name);
    if (value === null) throw new Error(`vault secret "${name}" not found in vault "${scope}"`);
    rememberSecret(name, value);
    values[name] = value;
    env[vaultEnvVarName(name)] = value;
    if (!secrets.includes(value)) secrets.push(value);
  }
  const win = process.platform === "win32";
  const rewrite = (text: string): string =>
    text.replace(VAULT_REF_RE, (_m, name: string) => (win ? `$env:${vaultEnvVarName(name)}` : `$${vaultEnvVarName(name)}`));
  const inline = (text: string): string => text.replace(VAULT_REF_RE, (_m, name: string) => values[name] ?? "");
  return { env, values, secrets, rewrite, inline };
}

function vaultRefTool(): Tool {
  return {
    name: "vault_ref",
    description:
      "Reference a secret stored in this agent's vault without exposing its value. Call without a name to list available secret names; call with a name to get the reference string {{vault:NAME}} to embed in a command. The value is resolved server-side and never shown.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Secret name to reference. Omit to list available names." },
      },
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const scope = vaultScope(ctx);
      const name = str(args, "name").trim();
      const names = listSecrets(scope).map((s) => s.name);
      if (!name) {
        if (names.length === 0) return { ok: true, content: `(no secrets in vault "${scope}")` };
        return {
          ok: true,
          content: `Available vault secrets (names only, values never shown):\n${names.map((n) => `- ${n}`).join("\n")}\n\nUse vault_ref with a name to get its {{vault:NAME}} reference.`,
        };
      }
      if (!VAULT_NAME_RE.test(name)) return { ok: false, content: `invalid vault secret name: ${name}` };
      if (!names.includes(name)) {
        return {
          ok: false,
          content: `Secret "${name}" was not found in vault "${scope}". Ask the user to add it in the vault UI (companions > secrets).`,
        };
      }
      return {
        ok: true,
        content: `Reference: ${vaultRef(name)}\n\nUsage: embed ${vaultRef(name)} in a shell_run command or env value. The value is resolved server-side into the child process environment and is redacted from the output. Never paste the value directly.`,
      };
    },
  };
}

export function createVaultTools(): Tool[] {
  return [vaultRefTool()];
}
