/** GitHub connector: OAuth app credentials come from LOAM_GITHUB_CLIENT_ID /
 *  LOAM_GITHUB_CLIENT_SECRET only. Scopes cover repo listing and issue creation. */
import type { ConnectorDef } from "../oauth.js";

async function fetchLogin(accessToken: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`GitHub account lookup failed (${res.status})`);
  const user = (await res.json()) as { login?: string };
  if (!user.login) throw new Error("GitHub account lookup returned no login");
  return user.login;
}

export const githubConnector: ConnectorDef = {
  id: "github",
  name: "GitHub",
  oauth: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo"],
    envVars: { clientId: "LOAM_GITHUB_CLIENT_ID", clientSecret: "LOAM_GITHUB_CLIENT_SECRET" },
  },
  fetchAccount: fetchLogin,
};
