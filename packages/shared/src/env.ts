export const env = {
  apiBase: typeof window !== 'undefined'
    ? (window as unknown as { __AGENT_STUDIO_ENV__?: { apiBase?: string } }).__AGENT_STUDIO_ENV__?.apiBase ?? '/api'
    : '/api',
  socketBase: typeof window !== 'undefined'
    ? (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__?.socketBase ?? '/',
    : '/',
};
