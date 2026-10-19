interface AgentStudioEnv {
  apiBase?: string;
  socketBase?: string;
}

function readEnv(): AgentStudioEnv {
  if (typeof window === 'undefined') return {};
  const globalWindow = window as unknown as { __AGENT_STUDIO_ENV__?: AgentStudioEnv };
  return globalWindow.__AGENT_STUDIO_ENV__ ?? {};
}

export const env = {
  apiBase: readEnv().apiBase ?? '/api',
  socketBase: readEnv().socketBase ?? '/',
};
