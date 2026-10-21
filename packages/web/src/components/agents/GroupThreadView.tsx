'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, Loader2, AlertCircle, Send, ArrowRightLeft, Users } from 'lucide-react';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { AgentCardAgent } from './AgentCard';
import type { GroupChat, GroupMessage, GroupMemberInfo } from './groupTypes';

interface GroupThreadViewProps {
  group: GroupChat;
  agents: AgentCardAgent[];
  onToggleInfo: () => void;
  infoOpen: boolean;
  onGroupChanged?: () => void;
}

const POLL_MS = 4000;

function memberOf(group: GroupChat, agents: AgentCardAgent[], id: string): GroupMemberInfo {
  const member = group.members?.find((m) => m.id === id);
  if (member) return member;
  const agent = agents.find((a) => a.id === id);
  return { id, name: agent?.name ?? id, emoji: agent?.emoji ?? '🤖' };
}

export function GroupThreadView({ group, agents, onToggleInfo, infoOpen, onGroupChanged }: GroupThreadViewProps) {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const load = async (initial = false) => {
    try {
      if (initial) setLoading(true);
      const res = await fetch(`${getApiBase()}/api/groups/${encodeURIComponent(group.id)}/messages`, {
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { messages?: GroupMessage[]; group?: GroupChat };
      if (!mountedRef.current) return;
      setMessages(data.messages ?? []);
      setError(null);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (initial && mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    setMessages([]);
    setError(null);
    setText('');
    void load(true);
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const handleSend = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/groups/${encodeURIComponent(group.id)}/messages`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ text: body }),
      });
      const data = (await res.json()) as { messages?: GroupMessage[]; error?: string };
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      setText('');
      if (data.messages) setMessages(data.messages);
      onGroupChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const members = useMemo(
    () => (group.memberIds ?? []).map((id) => memberOf(group, agents, id)),
    [group, agents],
  );

  return (
    <div className={clsx('flex flex-1 flex-col overflow-hidden bg-bg-main', infoOpen && 'min-w-[360px]')}>
      <header className="flex h-row shrink-0 items-center justify-between border-b border-border-main px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-control bg-fill-tsp text-base">
            <Users className="size-4 text-text-secondary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{group.name}</p>
            <p className="truncate text-xs text-text-tertiary">
              {t('{count} members', { count: members.length })}
              {members.length > 0 ? ` · ${members.map((m) => m.name).join(', ')}` : ''}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggleInfo}
          className="h-row-sm w-row-sm px-0"
          aria-label={t('Group info')}
          title={t('Group info')}
        >
          <Info className="size-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-text-secondary">
            <Loader2 className="size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary">
            <Users className="size-6" />
            <p className="text-sm">{t('Start the group conversation.')}</p>
            <p className="max-w-[360px] text-center text-xs">
              {t('Mention an agent with @name to address them; otherwise the first member replies.')}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[820px] flex-col gap-3">
            {messages.map((message) => {
              const isUser = message.author === 'user';
              const who = isUser ? null : memberOf(group, agents, message.author);
              const handoff = message.handoffTo ? memberOf(group, agents, message.handoffTo) : null;
              return (
                <div key={message.id} className={clsx('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
                  {!isUser && (
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-fill-tsp text-sm">
                      {who!.emoji || '🤖'}
                    </div>
                  )}
                  <div className={clsx('min-w-0 max-w-[78%]', isUser && 'items-end')}>
                    <div className="mb-0.5 flex items-center gap-2 text-[11px] text-text-tertiary">
                      <span className="font-medium text-text-secondary">{isUser ? t('You') : who!.name}</span>
                      <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <div
                      className={clsx(
                        'whitespace-pre-wrap break-words rounded-card px-3 py-2 text-sm',
                        isUser
                          ? 'bg-text-primary text-text-onblack'
                          : 'border border-border-main bg-bg-menu text-text-primary',
                      )}
                    >
                      {message.text}
                    </div>
                    {handoff && (
                      <div className="mt-1 flex items-start gap-1.5 rounded-control bg-fill-tsp px-2 py-1 text-[11px] text-text-secondary">
                        <ArrowRightLeft className="mt-0.5 size-3 shrink-0" />
                        <span>
                          {t('Handoff to {name}', { name: handoff.name })}
                          {message.handoffNote ? ` — ${message.handoffNote}` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {error && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-control bg-fill-tsp px-2 py-1 text-xs text-function-error">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      <div className="shrink-0 border-t border-border-main p-3">
        <div className="mx-auto flex max-w-[820px] items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={2}
            placeholder={t('Message the group… use @name to address an agent')}
            className="min-h-[44px] flex-1 resize-none rounded-card border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:ring-1 focus:ring-text-primary"
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={sending}
            disabled={sending || !text.trim()}
            onClick={() => void handleSend()}
            aria-label={t('Send')}
            title={t('Send')}
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
