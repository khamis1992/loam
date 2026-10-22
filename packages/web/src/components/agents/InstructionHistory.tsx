'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { History } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Button } from '@/components/ui/Button';

export type InstructionSource = 'user' | 'agent';
export type InstructionStatus = 'proposed' | 'approved' | 'rejected';

/** Mirrors InstructionVersion serialized by src/server/instructionHistory.ts. */
export interface InstructionVersion {
  id: string;
  agentId: string;
  version: number;
  instructions: string;
  source: InstructionSource;
  status: InstructionStatus;
  diff: string;
  createdAt: string;
  decidedAt?: string;
}

/** Mirrors InstructionProposal serialized by src/server/instructionHistory.ts. */
export interface InstructionProposal {
  id: string;
  agentId: string;
  version: number;
  instructions: string;
  diff: string;
  createdAt: string;
  reason: string;
}

async function requestJson(serverResponse: Response): Promise<unknown> {
  return (await serverResponse.json()) as unknown;
}

export async function fetchProposals(agentId: string): Promise<InstructionProposal[]> {
  const serverResponse = await fetch(
    `${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/instructions/proposals`,
    { headers: await getApiHeaders() },
  );
  if (!serverResponse.ok) throw new Error(t('Failed to load proposals'));
  const body = (await requestJson(serverResponse)) as { proposals?: InstructionProposal[] };
  return body.proposals ?? [];
}

export async function fetchVersions(agentId: string): Promise<InstructionVersion[]> {
  const serverResponse = await fetch(
    `${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/instructions/versions`,
    { headers: await getApiHeaders() },
  );
  if (!serverResponse.ok) throw new Error(t('Failed to load history'));
  const body = (await requestJson(serverResponse)) as { versions?: InstructionVersion[] };
  return body.versions ?? [];
}

export async function decideProposal(
  agentId: string,
  proposalId: string,
  action: 'approve' | 'reject',
): Promise<void> {
  const serverResponse = await fetch(
    `${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/instructions/proposals/${encodeURIComponent(proposalId)}/${action}`,
    { method: 'POST', headers: await getApiHeaders() },
  );
  if (!serverResponse.ok) throw new Error(t('Failed to update the proposal'));
}

export async function recordInstructionEdit(
  agentId: string,
  oldText: string,
  newText: string,
): Promise<void> {
  const serverResponse = await fetch(
    `${getApiBase()}/api/agents/${encodeURIComponent(agentId)}/instructions/versions`,
    {
      method: 'POST',
      headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify({ old: oldText, new: newText }),
    },
  );
  if (!serverResponse.ok) throw new Error(t('Failed to record the edit'));
}

function Ruler() {
  return (
    <div
      aria-hidden
      className="my-1 h-[2px] w-full rounded-full bg-[var(--fill-tsp-gray-main)]"
    />
  );
}

/**
 * Renders a unified-diff body: removed lines in red, added lines in green,
 * context and headers muted. Line colors match {ComputerPanel.SimpleDiff}.
 */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <div className="font-mono text-xs text-text-tertiary">{t('No content changes')}</div>;
  }
  return (
    <div className="flex flex-col gap-0.5 font-mono text-xs">
      {diff.split('\n').map((line, i) => {
        const key = `diff-${i}`;
        if (line.startsWith('---') || line.startsWith('+++')) {
          return (
            <div key={key} className="px-1.5 py-0.5 text-text-tertiary">
              {line}
            </div>
          );
        }
        if (line.startsWith('@@')) {
          return (
            <div key={key} className="px-1.5 py-0.5 text-text-tertiary">
              {line}
            </div>
          );
        }
        if (line.startsWith('+')) {
          return (
            <div key={key} className="rounded px-1.5 py-0.5 bg-function-success-tsp text-function-success">
              {line}
            </div>
          );
        }
        if (line.startsWith('-')) {
          return (
            <div key={key} className="rounded px-1.5 py-0.5 bg-function-error-tsp text-function-error">
              {line}
            </div>
          );
        }
        return (
          <div key={key} className="px-1.5 py-0.5 text-text-secondary">
            {line}
          </div>
        );
      })}
    </div>
  );
}

/** Fetches and exposes pending proposals for one agent with a manual refresh. */
export function useInstructionProposals(agentId: string) {
  const [proposals, setProposals] = useState<InstructionProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProposals(await fetchProposals(agentId));
    } catch (err) {
      setProposals([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!agentId) return;
    let mounted = true;
    (async () => {
      if (!mounted) return;
      await refresh();
    })();
    return () => {
      mounted = false;
    };
  }, [agentId, refresh]);

  return { proposals, loading, error, refresh };
}

/** Approval card for one proposed change, with Approve/Reject actions. */
export function InstructionProposalCard({
  proposal,
  agentName,
  onDone,
}: {
  proposal: InstructionProposal;
  agentName?: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      await decideProposal(proposal.agentId, proposal.id, action);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-card border border-border-main bg-fill-tsp p-3">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
        <span>{t('Proposed instruction change')}</span>
        {agentName && <span className="text-xs font-normal text-text-tertiary">{agentName}</span>}
      </div>
      <div className="text-xs text-text-tertiary">
        v{proposal.version} · {new Date(proposal.createdAt).toLocaleString()}
      </div>
      {proposal.reason && (
        <div className="mt-2 text-xs text-text-secondary">{proposal.reason}</div>
      )}
      <Ruler />
      <div className="max-h-64 overflow-y-auto rounded-control bg-[var(--background-code-bg)] p-2">
        <DiffView diff={proposal.diff} />
      </div>
      {error && <div className="mt-2 text-xs text-function-error">{error}</div>}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" loading={busy === 'approve'} disabled={busy !== null} onClick={() => decide('approve')}>
          {t('Approve')}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'reject'} disabled={busy !== null} onClick={() => decide('reject')}>
          {t('Reject')}
        </Button>
      </div>
    </div>
  );
}

/** Version history with per-entry expandable diffs. */
export function InstructionHistoryList({ agentId }: { agentId: string }) {
  const [versions, setVersions] = useState<InstructionVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    fetchVersions(agentId)
      .then((result) => {
        if (mounted) setVersions(result);
      })
      .catch((err) => {
        if (mounted) {
          setVersions([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  if (loading && versions.length === 0) {
    return <div className="text-xs text-text-tertiary">{t('Loading')}</div>;
  }
  if (error) {
    return <div className="text-xs text-function-error">{error}</div>;
  }
  if (versions.length === 0) {
    return <div className="text-xs text-text-tertiary">{t('No history yet')}</div>;
  }

  return (
    <div className="flex flex-col gap-1">
      {versions.map((version) => (
        <div key={version.id} className="rounded-control border border-border-main bg-fill-tsp px-2 py-1.5">
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-text-secondary">
              <History className="size-3.5 shrink-0 text-text-tertiary" />
              <span className="font-mono">v{version.version}</span>
              <span
                className={clsx(
                  'rounded-full px-1.5 py-0 text-[10px]',
                  version.source === 'agent'
                    ? 'bg-function-success-tsp text-function-success'
                    : 'bg-fill-tsp text-text-tertiary',
                )}
              >
                {version.source === 'agent' ? t('Proposed') : t('Editor')}
              </span>
              <span
                className={clsx(
                  'rounded-full px-1.5 py-0 text-[10px]',
                  version.status === 'proposed'
                    ? 'bg-function-warning-tsp text-function-warning'
                    : 'bg-fill-tsp text-text-tertiary',
                )}
              >
                {version.status === 'proposed'
                  ? t('Pending')
                  : version.status === 'approved'
                    ? t('Approved')
                    : t('Rejected')}
              </span>
              <span className="text-text-tertiary">{new Date(version.createdAt).toLocaleString()}</span>
            </summary>
            {version.diff && (
              <div className="mt-1.5 rounded-control bg-[var(--background-code-bg)] p-2">
                <DiffView diff={version.diff} />
              </div>
            )}
          </details>
        </div>
      ))}
    </div>
  );
}
