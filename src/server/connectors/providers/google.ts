/** Google connectors (Gmail + Calendar) sharing one OAuth client: credentials
 *  come from LOAM_GOOGLE_CLIENT_ID / LOAM_GOOGLE_CLIENT_SECRET only. Each
 *  connector requests its own scopes; offline access enables token refresh. */
import type { ConnectorDef } from "../oauth.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_DRAFT_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** Google issues one refresh token per consent; requesting both Gmail scopes
 *  together lets read + draft tools work under a single connection. */
const gmailConnectorDef: ConnectorDef = {
  id: "gmail",
  name: "Gmail",
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [GMAIL_SCOPE, GMAIL_DRAFT_SCOPE, "openid", "email", "profile"],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    envVars: { clientId: "LOAM_GOOGLE_CLIENT_ID", clientSecret: "LOAM_GOOGLE_CLIENT_SECRET" },
  },
  fetchAccount: fetchGoogleEmail,
};

const calendarConnectorDef: ConnectorDef = {
  id: "calendar",
  name: "Google Calendar",
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [CALENDAR_SCOPE, "openid", "email", "profile"],
    extraAuthParams: { access_type: "offline", prompt: "consent" },
    envVars: { clientId: "LOAM_GOOGLE_CLIENT_ID", clientSecret: "LOAM_GOOGLE_CLIENT_SECRET" },
  },
  fetchAccount: fetchGoogleEmail,
};

async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Google account lookup failed (${res.status})`);
  const info = (await res.json()) as { email?: string };
  if (!info.email) throw new Error("Google account lookup returned no email");
  return info.email;
}

export const gmailConnector = gmailConnectorDef;
export const calendarConnector = calendarConnectorDef;
