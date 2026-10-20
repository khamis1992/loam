'use client';

import { useEffect, useState } from 'react';

export function useBranch(): string | null {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as unknown as {
      desktopSync?: { env?: Record<string, string> };
      __AGENT_STUDIO_ENV__?: { gitBranch?: string };
      __apis?: { system?: { getGitBranch?: () => Promise<string | null> | string | null } };
    };
    const fromEnv = w.desktopSync?.env?.GIT_BRANCH || w.__AGENT_STUDIO_ENV__?.gitBranch;
    if (fromEnv) {
      setBranch(fromEnv);
      return;
    }
    const getter = w.__apis?.system?.getGitBranch;
    if (getter) {
      Promise.resolve(getter()).then((b) => setBranch(b || null)).catch(() => setBranch(null));
    }
  }, []);

  return branch;
}
