const WEB_SESSION_TOKEN_KEY = 'agent-studio:session-token';

export function readWebSessionToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(WEB_SESSION_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeWebSessionToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(WEB_SESSION_TOKEN_KEY, token);
    else window.localStorage.removeItem(WEB_SESSION_TOKEN_KEY);
  } catch {
    /* Storage can be unavailable in private or restricted browser contexts. */
  }
}

export async function webLocalSignIn(apiBase: string): Promise<boolean> {
  try {
    const nonce = crypto.randomUUID();
    const login = await fetch(`${apiBase}/login?from=web&type=signIn&nonce=${encodeURIComponent(nonce)}`);
    if (!login.ok) return false;
    const loginData = await login.json() as { token?: unknown };
    if (typeof loginData.token !== 'string' || !loginData.token) return false;

    const generated = await fetch(`${apiBase}/user.v1.UserAuthService/GenerateTempAuthCode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'Authorization': `Bearer ${loginData.token}`,
      },
      body: '{}',
    });
    if (!generated.ok) return false;
    const generatedData = await generated.json() as { token?: unknown };
    if (typeof generatedData.token !== 'string' || !generatedData.token) return false;

    const exchanged = await fetch(`${apiBase}/user.v1.UserAuthPublicService/ExchangeTokenByCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ token: generatedData.token }),
    });
    if (!exchanged.ok) return false;
    const exchangedData = await exchanged.json() as { token?: unknown };
    if (typeof exchangedData.token !== 'string' || !exchangedData.token) return false;
    writeWebSessionToken(exchangedData.token);
    return true;
  } catch {
    return false;
  }
}
