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
import { GroupThreadView } from '@/components/agents/GroupThreadView';
import { GroupCreateDialog } from '@/components/agents/GroupCreateDialog';
import type { GroupChat } from '@/components/agents/groupTypes';
import { NewAgentDialog } from '@/components/agents/NewAgentDialog';
import { AgentStartDialog } from '@/components/agents/AgentStartDialog';
import { AgentEditDrawer } from '@/components/agents/AgentEditDrawer';
import { RenameAgentDialog } from '@/components/agents/RenameAgentDialog';
import { getBuiltInAgents } from '@/components/agents/BuiltInAgentCard';
import type { AgentCardAgent } from '@/components/agents/AgentCard';

interface Agent extends AgentCardAgent {
  hiddenAt?: string;
  archivedAt?: string;
  description?: string;
  instructions?: string;
  effort?: string;
  allowedServices?: string[];
}

interface AgentThreadSummary {
  agentId: string;
  threadUid: string;
  updatedAt: string;
  lastSeenAt: string | null;
  lastMessageAt: string | null;
  unread: boolean;
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
  const [renameAgent, setRenameAgent] = useState<Agent | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [unreadById, setUnreadById] = useState<Record<string, { count: number; lastAt?: string }>>({});
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  const selectedId = searchParams.get('agent') ?? undefined;
  const selectedGroupId = searchParams.get('group') ?? undefined;
  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === selectedId),
    [agents, selectedId],
  );
  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId),
    [groups, selectedGroupId],
  );
  const [infoThreadUid, setInfoThreadUid] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setInfoThreadUid(null);
    if (!selectedAgent) return;
    resolveAgentThread(selectedAgent.id).then((uid) => {
      if (mounted) setInfoThreadUid(uid);
    });
    return () => { mounted = false; };
  }, [selectedAgent]);

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

  const loadGroups = async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/groups`, {
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { groups?: GroupChat[] };
      setGroups(data.groups ?? []);
    } catch (e) {
      // Groups are additive; a failure must not break the agents page.
      // eslint-disable-next-line no-console
      console.error('failed to load groups', e);
    }
  };

  useEffect(() => {
    void loadAgents();
    void loadGroups();
  }, []);

  // Compute unread counts from agent threads.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agent-threads`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { threads?: AgentThreadSummary[] };
        const next: Record<string, { count: number; lastAt?: string }> = {};
        for (const item of data.threads ?? []) {
          if (item.unread) next[item.agentId] = { count: 1, lastAt: item.lastMessageAt ?? undefined };
        }
        if (mounted) setUnreadById(next);
      } catch {
        // ignore list fetch errors
      }
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
    if (!selectedId) return;
    (async () => {
      try {
        await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(selectedId)}/thread/seen`, {
          method: 'POST',
          headers: await getApiHeaders(),
        });
      } catch {
        // ignore seen-marking errors
      }
    })();
    setUnreadById((prev) => {
      const next = { ...prev };
      delete next[selectedId];
      return next;
    });
  }, [selectedId]);

  const selectAgent = (agent: Agent, opts?: { openInfo?: boolean }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('agent', agent.id);
    params.delete('group');
    router.replace(`/app/agents?${params.toString()}`, { scroll: false });
    setInfoOpen(opts?.openInfo ?? false);
  };

  const selectGroup = (group: GroupChat) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('group', group.id);
    params.delete('agent');
    router.replace(`/app/agents?${params.toString()}`, { scroll: false });
    setInfoOpen(false);
  };

  const handleGroupCreated = (group: GroupChat) => {
    setGroups((prev) => [group, ...prev.filter((g) => g.id !== group.id)]);
    selectGroup(group);
  };

  const handleGroupChanged = (group: GroupChat) => {
    setGroups((prev) => prev.map((g) => (g.id === group.id ? group : g)));
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

  const handleHidden = async (agent: Agent, hidden: boolean) => {
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}/hide`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ hidden }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await loadAgents();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('failed to toggle agent hidden state', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleInfo = (agent: Agent) => {
    selectAgent(agent, { openInfo: true });
  };

  const handleDeleteAgent = async (agent: Agent) => {
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'DELETE',
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setInfoOpen(false);
      if (selectedId === agent.id) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('agent');
        router.replace(`/app/agents?${params.toString()}`, { scroll: false });
      }
      await loadAgents();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('failed to delete agent', e);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRenamed = () => {
    void loadAgents();
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
        onHideAgent={handleHidden}
        onStartBuiltIn={setStartAgent}
        unreadById={unreadById}
        groups={groups}
        selectedGroupId={selectedGroupId}
        onSelectGroup={selectGroup}
        onNewGroup={() => setNewGroupOpen(true)}
        onInfo={handleInfo}
        onRename={setRenameAgent}
        onDeleteAgent={handleDeleteAgent}
      />

      {selectedGroup ? (
        <GroupThreadView
          group={selectedGroup}
          agents={agents}
          onToggleInfo={() => setInfoOpen((v) => !v)}
          infoOpen={infoOpen}
          onGroupChanged={() => void loadGroups()}
        />
      ) : selectedAgent ? (
        <AgentThreadView
          agent={selectedAgent}
          onToggleInfo={() => setInfoOpen((v) => !v)}
          infoOpen={infoOpen}
          onTaskCreated={() => setInfoOpen(true)}
        />
      ) : (
        emptyState
      )}

      {selectedGroup && infoOpen ? (
        <AgentInfoPane
          agent={{ id: selectedGroup.id, name: selectedGroup.name, emoji: '👥' }}
          threadUid={null}
          onClose={() => setInfoOpen(false)}
          onEdit={() => undefined}
          group={selectedGroup}
          onGroupChanged={handleGroupChanged}
        />
      ) : selectedAgent && infoOpen ? (
        <AgentInfoPane
          agent={selectedAgent}
          threadUid={infoThreadUid}
          onClose={() => setInfoOpen(false)}
          onEdit={() => setEditAgent(selectedAgent)}
          onRenameAgent={() => setRenameAgent(selectedAgent)}
          onDeleteAgent={() => void handleDeleteAgent(selectedAgent)}
        />
      ) : null}

      <NewAgentDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={handleCreated}
      />

      <GroupCreateDialog
        open={newGroupOpen}
        agents={agents}
        onClose={() => setNewGroupOpen(false)}
        onCreated={handleGroupCreated}
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

      <RenameAgentDialog
        agent={renameAgent}
        onClose={() => setRenameAgent(null)}
        onRenamed={handleRenamed}
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
