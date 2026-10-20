'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Plus, Loader2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { AgentSidebarList } from '@/components/agents/AgentSidebarList';
import { AgentThreadView, resolveAgentThread } from '@/components/agents/AgentThreadView';
import { AgentInfoPane } from '@/components/agents/AgentInfoPane';
import { NewAgentDialog } from '@/components/agents/NewAgentDialog';
import { AgentStartDialog } from '@/components/agents/AgentStartDialog';
import { AgentEditDrawer } from '@/components/agents/AgentEditDrawer';
import { getBuiltInAgents } from '@/components/agents/BuiltInAgentCard';
import type { AgentCardAgent } from '@/components/agents/AgentCard';

interface Agent extends AgentCardAgent {
  archivedAt?: string;
  description?: string;
  instructions?: string;
  effort?: string;
  allowedServices?: string[];
}

export default function AgentsPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [startAgent, setStartAgent] = useState<AgentCardAgent | null>(null);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [unreadById, setUnreadById] = useState<Record<string, { count: number; lastAt?: string }>>({});

  const selectedId = searchParams.get('agent') ?? undefined;
  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId),
    [agents, selectedId],
  );

  const loadAgents = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`${getApiBase()}/api/agents`, {
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { agents?: Agent[] };
      setAgents((data.agents ?? []).filter((a) => !a.archivedAt));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // eslint-disable-next-line no-console
      console.error('failed to load agents', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAgents();
  }, []);

  // Compute unread counts from agent threads.
  useEffect(() => {
    let mounted = true;
    setUnreadById({});
    (async () => {
      const next: Record<string, { count: number; lastAt?: string }> = {};
      await Promise.all(
        agents.map(async (a) => {
          const seenAt = typeof window !== 'undefined' ? localStorage.getItem(`loam.agentSeen.${a.id}`) : null;
          const uid = await resolveAgentThread(a.id);
          if (!uid) return;
          try {
            const res = await fetch(`${getApiBase()}/api/tasks/${encodeURIComponent(uid)}`, {
              headers: await getApiHeaders(),
            });
            if (!res.ok) return;
            const data = (await res.json()) as { task?: { messages?: Array<{ role: string; content: string; at: string }> } };
            const messages = data.task?.messages ?? [];
            const newMessages = seenAt
              ? messages.filter((m) => m.role === 'assistant' && m.at && m.at > seenAt)
              : messages.filter((m) => m.role === 'assistant');
            next[a.id] = { count: newMessages.length, lastAt: newMessages.at(-1)?.at };
          } catch {
            // ignore per-agent errors
          }
        }),
      );
      if (mounted) setUnreadById(next);
    })();
    return () => { mounted = false; };
  }, [agents]);

  // Toggle info pane with Ctrl+Shift+I.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setInfoOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Update seen timestamp when selected agent changes.
  useEffect(() => {
    if (selectedId && typeof window !== 'undefined') {
      localStorage.setItem(`loam.agentSeen.${selectedId}`, new Date().toISOString());
      setUnreadById((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
    }
  }, [selectedId]);

  const selectAgent = (agent: Agent) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('agent', agent.id);
    router.replace(`/app/agents?${params.toString()}`, { scroll: false });
    setInfoOpen(false);
  };

  const handleCreated = () => {
    void loadAgents();
  };

  const handleSaved = () => {
    void loadAgents();
    setEditAgent(null);
  };

  const handleDuplicate = async (agent: Agent) => {
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}/duplicate`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { agent?: Agent };
      if (data.agent) {
        await loadAgents();
        if (data.agent.id) {
          selectAgent(data.agent);
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('failed to duplicate agent', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleArchive = async (agent: Agent) => {
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}/archive`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await loadAgents();
      if (selectedId === agent.id) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('agent');
        router.replace(`/app/agents?${params.toString()}`, { scroll: false });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('failed to archive agent', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const emptyState = (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-bg-main p-6 text-text-tertiary">
      <div className="flex size-12 items-center justify-center rounded-full bg-fill-tsp text-2xl">🤖</div>
      <p className="text-base font-medium text-text-primary">{t('Pick an agent or create one')}</p>
      <p className="max-w-[320px] text-center text-sm">{t('Select an agent from the sidebar to start a permanent chat, or create a new one.')}</p>
      <Button type="button" variant="primary" size="sm" onClick={() => setNewOpen(true)}>
        <Plus className="size-4" />
        {t('New agent')}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <AgentSidebarList
        agents={agents}
        selectedId={selectedId}
        loading={loading}
        error={error}
        onSelect={selectAgent}
        onNew={() => setNewOpen(true)}
        onEdit={setEditAgent}
        onDuplicate={handleDuplicate}
        onArchive={handleArchive}
        onStartBuiltIn={setStartAgent}
        unreadById={unreadById}
      />

      {selectedAgent ? (
        <AgentThreadView
          agent={selectedAgent}
          onToggleInfo={() => setInfoOpen((v) => !v)}
          infoOpen={infoOpen}
          onTaskCreated={() => setInfoOpen(true)}
        />
      ) : (
        emptyState
      )}

      {selectedAgent && infoOpen && (
        <AgentInfoPane
          agent={selectedAgent}
          threadUid={typeof window !== 'undefined' ? localStorage.getItem(`loam.agentThread.${selectedAgent.id}`) : null}
          onClose={() => setInfoOpen(false)}
          onEdit={() => setEditAgent(selectedAgent)}
        />
      )}

      <NewAgentDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={handleCreated}
      />

      <AgentStartDialog
        open={startAgent !== null}
        onClose={() => setStartAgent(null)}
        agent={startAgent}
      />

      <AgentEditDrawer
        agent={editAgent}
        open={editAgent !== null}
        onClose={() => setEditAgent(null)}
        onSaved={handleSaved}
      />
    </div>
  );
}

export function AgentsPageFallback() {
  return (
    <div className="flex h-full flex-1 items-center justify-center bg-bg-main text-text-secondary">
      <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
    </div>
  );
}
