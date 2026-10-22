/** Credential scrubbing for the ACP child environment.
 *
 *  The child process must never inherit host credentials. We drop any variable
 *  whose upper-cased name contains KEY, TOKEN, SECRET, or PASSWORD, plus the
 *  well-known cloud-provider prefixes. Explicit caller extras are merged after
 *  scrubbing and therefore win.
 */
const SECRET_SUBSTRINGS = ["KEY", "TOKEN", "SECRET", "PASSWORD"];
const SECRET_PREFIXES = ["AWS_", "AZURE_", "GCP_", "GOOGLE_", "OPENAI_", "ANTHROPIC_", "HF_", "HUGGINGFACE_", "GITHUB_"];

function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return SECRET_SUBSTRINGS.some((s) => upper.includes(s));
}

export function scrubEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isSecretName(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
