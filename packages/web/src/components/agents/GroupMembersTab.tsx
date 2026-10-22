'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, Plus, X } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { AgentCardAgent } from './AgentCard';
import type { GroupChat } from './groupTypes';
import { AgentAvatar } from './AgentAvatar';

interface GroupMembersTabProps {
  groupId: string;
  onChanged?: (group: GroupChat) => void;
}

export function GroupMembersTab({ groupId, onChanged }: GroupMembersTabProps) {
  const [group, setGroup] = useState<GroupChat | null>(null);
  const [agents, setAgents] = useState<AgentCardAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getApiHeaders();
      const [groupRes, agentsRes] = await Promise.all([
        fetch(`${getApiBase()}/api/groups/${encodeURIComponent(groupId)}`, { headers }),
        fetch(`${getApiBase()}/api/agents`, { headers }),
      ]);
      if (!groupRes.ok) throw new Error(`group ${groupRes.status}`);
      if (!agentsRes.ok) throw new Error(`agents ${agentsRes.status}`);
      const groupData = (await groupRes.json()) as { group?: GroupChat };
      const agentsData = (await agentsRes.json()) as { agents?: AgentCardAgent[] };
      setGroup(groupData.group ?? null);
      setAgents((agentsData.agents ?? []).filter((a) => !(a as { archivedAt?: string }).archivedAt));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const memberIds = useMemo(() => new Set(group?.memberIds ?? []), [group]);
  const available = useMemo(() => agents.filter((a) => !memberIds.has(a.id)), [agents, memberIds]);

  const addMember = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/groups/${encodeURIComponent(groupId)}/members`, {
        method: 'POST',
        headers: await getApiHeaders(),
        body: JSON.stringify({ agentId: selected }),
      });
      const data = (await res.json()) as { group?: GroupChat; error?: string };
      if (!res.ok || !data.group) throw new Error(data.error || `status ${res.status}`);
      setGroup(data.group);
      setSelected('');
      onChanged?.(data.group);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (agentId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${getApiBase()}/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(agentId)}`,
        { method: 'DELETE', headers: await getApiHeaders() },
      );
      const data = (await res.json()) as { group?: GroupChat; error?: string };
      if (!res.ok || !data.group) throw new Error(data.error || `status ${res.status}`);
      setGroup(data.group);
      onChanged?.(data.group);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-text-secondary">
        <Loader2 className="size-5 animate-spin" /> {t('Loading')}
      </div>
    );
  }

  if (!group) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-function-error">
        <AlertCircle className="size-5" />
        <p className="text-sm">{t('Group not found')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium text-text-tertiary">{t('Members')}</span>
      {(group.members ?? []).length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('No members yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {(group.members ?? []).map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-2 rounded-card border border-border-main bg-bg-main p-2"
            >
              <AgentAvatar
                name={member.name}
                id={member.id}
                emoji={member.emoji}
                size={24}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{member.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void removeMember(member.id)}
                aria-label={t('Remove {name}', { name: member.name })}
                title={t('Remove {name}', { name: member.name })}
                className="h-row-sm w-row-sm px-0 text-text-tertiary"
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-text-tertiary">{t('Add member')}</span>
        <div className="flex items-center gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || available.length === 0}
            className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1.5 text-sm text-text-primary outline-none"
          >
            <option value="">{available.length === 0 ? t('All agents are members') : t('Pick an agent')}</option>
            {available.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy || !selected}
            onClick={() => void addMember()}
            aria-label={t('Add')}
            title={t('Add')}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

      {error && (
        <p className="flex items-center gap-1 text-xs text-function-error">
          <AlertCircle className="size-3.5" /> {error}
        </p>
      )}
    </div>
  );
}
