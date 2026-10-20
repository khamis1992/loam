'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Puzzle } from 'lucide-react';
import { t } from '@/i18n/t';
import { getSessionToken, getApiBase } from '@/services/rpc';

interface McpServer {
  name: string;
  connected?: boolean;
  toolCount?: number;
}

interface ToolSummary {
  name: string;
  description?: string;
}

export default function PluginsPage() {
  const router = useRouter();
  const [mcp, setMcp] = useState<{ servers?: McpServer[] } | null>(null);
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const token = await getSessionToken();
      try {
        const [mcpRes, toolsRes] = await Promise.all([
          fetch(`${getApiBase()}/api/mcp/status`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${getApiBase()}/api/tools`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        const mcpData = mcpRes.ok ? (await mcpRes.json()) as { servers?: McpServer[] } : null;
        const toolsData = toolsRes.ok ? (await toolsRes.json()) as { tools?: ToolSummary[] } : null;
        if (mounted) {
          setMcp(mcpData);
          setTools(toolsData?.tools ?? []);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('failed to load plugins', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-title-lg text-text-primary">{t('Plugins')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : (
          <div className="space-y-4">
            <section
            >
              <h2 className="mb-2 text-sm font-semibold text-text-primary">{t('MCP Servers')}</h2>
              {(mcp?.servers ?? []).length === 0 ? (
                <p className="text-sm text-text-tertiary">{t('No MCP servers connected.')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {(mcp?.servers ?? []).map((s) => (
                    <li key={s.name} className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
                      <Puzzle className="size-4 text-text-tertiary" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-text-primary">{s.name}</p>
                        <p className="text-xs text-text-tertiary">{s.toolCount ?? 0} tools</p>
                      </div>
                      <span className={clsConnected(s.connected)}>
                        {s.connected ? t('Connected') : t('Disconnected')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section
            >
              <h2 className="mb-2 text-sm font-semibold text-text-primary">{t('Tools')}</h2>
              {tools.length === 0 ? (
                <p className="text-sm text-text-tertiary">{t('No tools registered.')}</p>
              ) : (
                <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {tools.map((tItem) => (
                    <li key={tItem.name} className="truncate rounded-control px-2 py-1 text-sm text-text-secondary hover:bg-fill-hover">
                      {tItem.name}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function clsConnected(connected?: boolean) {
  return `shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${connected ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`;
}
