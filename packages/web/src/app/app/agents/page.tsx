'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, Plus } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { AgentCard, type AgentCardAgent } from '@/components/agents/AgentCard';
import { BuiltInAgentCard, getBuiltInAgents } from '@/components/agents/BuiltInAgentCard';
import { NewAgentDialog } from '@/components/agents/NewAgentDialog';
import { AgentStartDialog } from '@/components/agents/AgentStartDialog';
import { AgentEditDrawer } from '@/components/agents/AgentEditDrawer';
import { TeamRunsList } from '@/components/agents/TeamRunsList';

interface Agent {
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  mode?: string;
  workMode?: string;
  model?: string;
  effort?: 'max' | 'high' | 'medium' | 'low';
  allowedServices?: string[];
  archivedAt?: string;
}

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [startAgent, setStartAgent] = useState<AgentCardAgent | null>(null);
  const [editAgent, setEditAgent] = useState<AgentCardAgent | null>(null);

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
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/agents`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { agents?: Agent[] };
        if (mounted) setAgents((data.agents ?? []).filter((a) => !a.archivedAt));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load agents', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const handleCreated = () => {
    loadAgents();
  };

  const handleSaved = () => {
    loadAgents();
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center justify-between gap-3 border-b border-border-main px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/app')}
            className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
          >
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="text-title-lg text-text-primary">{t('Agent Loam')}</h1>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => setNewOpen(true)}
        >
          <Plus className="size-4" />
          {t('New agent')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-function-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load agents')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[1024px] flex-col gap-8">
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-headline-sm text-text-primary">{t('My agents')}</h2>
                <span className="text-xs text-text-tertiary">{agents.length}</span>
              </div>
              {agents.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border-main bg-bg-menu/50 py-12 text-text-tertiary">
                  <p className="text-sm">{t('No agents yet.')}</p>
                  <p className="max-w-[320px] text-center text-xs">{t('Create companions from the backend console; they will appear here.')}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => setNewOpen(true)}
                  >
                    {t('New agent')}
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {agents.map((a) => (
                    <AgentCard
                      key={a.id}
                      agent={a}
                      onStart={setStartAgent}
                      onEdit={setEditAgent}
                    />
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-headline-sm text-text-primary">{t('Built-in agents')}</h2>
                <span className="text-xs text-text-tertiary">{getBuiltInAgents().length}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {getBuiltInAgents().map((a) => (
                  <BuiltInAgentCard key={a.id} agent={a} />
                ))}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-headline-sm text-text-primary">{t('Team runs')}</h2>
              </div>
              <TeamRunsList />
            </section>
          </div>
        )}
      </div>

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
