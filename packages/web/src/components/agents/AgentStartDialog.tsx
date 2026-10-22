'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppDispatch } from '@/store';
import { addSession } from '@/store/sessionsSlice';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Spinner } from '@/components/ui/Button';
import { t } from '@/i18n/t';
import { ChatSocket } from '@/services/chatSocket';
import { getSessionToken, getApiBase } from '@/services/rpc';
import { shortUid } from '@/utils/uid';
import type { TaskMode } from '@shared/socket';
import type { AgentCardAgent } from './AgentCard';
import { AgentAvatar } from './AgentAvatar';

function getSocketBase(): string {
  if (typeof window === 'undefined') return '/';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.socketBase) return injected.socketBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return 'http://localhost:8787';
  return '/';
}

const TASK_MODES: { id: TaskMode; label: string; labelAr: string }[] = [
  { id: 'standard', label: 'Standard', labelAr: 'قياسي' },
  { id: 'max', label: 'Max', labelAr: 'أقصى' },
  { id: 'lite', label: 'Lite', labelAr: 'خفيف' },
  { id: 'discuss', label: 'Discuss', labelAr: 'نقاش' },
  { id: 'cascade', label: 'Cascade', labelAr: 'تسلسلي' },
];

interface AgentStartDialogProps {
  open: boolean;
  onClose: () => void;
  agent: AgentCardAgent | null;
}

export function AgentStartDialog({ open, onClose, agent }: AgentStartDialogProps) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<TaskMode>('standard');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setPrompt('');
      setMode('standard');
      setError(null);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [open]);

  const title = useMemo(() => {
    if (!agent) return t('Start task');
    return `${t('Start task with')} ${agent.name}`;
  }, [agent]);

  const handleSend = async () => {
    if (!agent || !prompt.trim() || sending) return;
    const text = prompt.trim();
    const uid = shortUid();
    setSending(true);
    setError(null);

    const socket = new ChatSocket({
      getToken: getSessionToken,
      socketBase: getSocketBase(),
      onMessage: () => {},
      onAuthFailure: () => setError(t('Session expired. Please sign in again.')),
      onError: (msg) => setError(msg),
    });

    try {
      await socket.connect();
      socket.join(uid);
      socket.sendText(
        uid,
        text,
        mode,
        [],
        {
          agentId: agent.id,
          ...(agent.mode ? { loamMode: agent.mode } : {}),
        },
      );
      // Give the transport a moment to flush the emit before disconnecting.
      await new Promise((r) => setTimeout(r, 80));
      socket.disconnect();

      dispatch(addSession({
        uid,
        title: text.slice(0, 60),
        status: 6,
        lastMessageTime: Date.now(),
        lastDisplayMessage: text,
        icon: agent.emoji || '•',
      }));
      router.push(`/app/${uid}`);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      socket.disconnect();
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} width={560}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          {agent ? (
            <AgentAvatar
              name={agent.name}
              id={agent.id}
              avatarShape={agent.avatarShape}
              avatarColor={agent.avatarColor}
              avatarImage={agent.avatarImage}
              emoji={agent.emoji}
              size={28}
            />
          ) : (
            <span className="text-lg">🤖</span>
          )}
          <span className="font-medium text-text-primary">{agent?.name}</span>
          <span className="text-text-tertiary">· {agent?.mode || 'loam'} · {agent?.workMode || 'loam'}</span>
        </div>

        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('Assign a task or ask anything')}
          rows={4}
          className="w-full resize-none rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
        />

        <div className="flex items-center gap-2">
          <span className="text-sm text-text-secondary">{t('Mode')}:</span>
          <div className="flex flex-wrap gap-2">
            {TASK_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={`rounded-control px-3 py-1 text-xs font-medium transition-colors ${
                  mode === m.id
                    ? 'bg-text-primary text-text-onblack'
                    : 'bg-fill-tsp text-text-secondary hover:bg-fill-hover'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
            {t('Cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={sending}
            disabled={!prompt.trim() || sending}
            onClick={handleSend}
          >
            {sending ? <Spinner className="size-4" /> : t('Send')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
