export const isDesktop = typeof window !== 'undefined' && !!(window as unknown as { desktopSync?: unknown }).desktopSync;

export const desktopApis = {
  system: {
    openExternal: async (url: string) => {
      const apis = (window as unknown as { __apis?: { system?: { openExternal?: (url: string) => Promise<void> } } }).__apis;
      await apis?.system?.openExternal?.(url);
    },
  },
  desktopOperator: {
    respondFolderAccess: async (_payload: { requestId: string; decision: 'deny' | 'once' | 'always' }) => {
      const apis = (window as unknown as { __apis?: { desktopOperator?: { respondFolderAccess?: (p: unknown) => Promise<unknown> } } }).__apis;
      await apis?.desktopOperator?.respondFolderAccess?.(_payload);
    },
  },
};
