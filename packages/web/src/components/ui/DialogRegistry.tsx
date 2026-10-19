'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type DialogState = { open: boolean; payload?: unknown };

interface DialogRegistryContextValue {
  dialogs: Record<string, DialogState>;
  open: (name: string, payload?: unknown) => void;
  close: (name: string) => void;
  isOpen: (name: string) => boolean;
}

const DialogRegistryContext = createContext<DialogRegistryContextValue | undefined>(undefined);

export function DialogRegistryProvider({ children }: { children: ReactNode }) {
  const [dialogs, setDialogs] = useState<Record<string, DialogState>>({});

  const open = useCallback((name: string, payload?: unknown) => {
    setDialogs((prev) => ({ ...prev, [name]: { open: true, payload } }));
  }, []);

  const close = useCallback((name: string) => {
    setDialogs((prev) => ({ ...prev, [name]: { ...prev[name], open: false } }));
  }, []);

  const isOpen = useCallback((name: string) => !!dialogs[name]?.open, [dialogs]);

  return (
    <DialogRegistryContext.Provider value={{ dialogs, open, close, isOpen }}>
      {children}
    </DialogRegistryContext.Provider>
  );
}

export function useDialogRegistry() {
  const ctx = useContext(DialogRegistryContext);
  if (!ctx) throw new Error('useDialogRegistry must be used within DialogRegistryProvider');
  return ctx;
}
