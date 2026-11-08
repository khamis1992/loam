'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Pencil, Plus, Puzzle, Trash2, X } from 'lucide-react';
import { t } from '@/i18n/t';
import { Button } from '@/components/ui/Button';
import { Section } from './SettingsDialog';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  listMcpServerTools,
  setMcpServerDisabledTools,
  updateMcpServer,
  type McpServer,
  type McpTool,
} from '@/services/mcpServersApi';

interface ServerForm {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  url: string;
  accountName: string;
  customInstructions: string;
  headersText: string;
  envText: string;
}

const EMPTY_FORM: ServerForm = {
  name: '',
  transport: 'stdio',
  command: '',
  url: '',
  accountName: '',
  customInstructions: '',
  headersText: '',
  envText: '',
};

const inputClass = 'rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark placeholder:text-text-tertiary';

function jsonObject(text: string, label: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a JSON object of string values`);
  }
  return value as Record<string, string>;
}

export function McpServerManager() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ServerForm | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, { tools: McpTool[]; disabledTools: string[] }>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await listMcpServers();
      setServers(data.servers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const openEdit = (server: McpServer) => {
    setEditingName(server.name);
    setForm({
      name: server.name,
      transport: server.transport ?? (server.url ? 'http' : 'stdio'),
      command: server.command ?? '',
      url: server.url ?? '',
      accountName: server.accountName ?? '',
      customInstructions: server.customInstructions ?? '',
      headersText: '',
      envText: '',
    });
    setError(null);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const config = {
        transport: form.transport,
        ...(form.transport === 'http' ? { url: form.url.trim() } : { command: form.command.trim() }),
        ...(form.accountName.trim() ? { accountName: form.accountName.trim() } : {}),
        ...(form.customInstructions.trim() ? { customInstructions: form.customInstructions.trim() } : {}),
        ...(jsonObject(form.headersText, 'Headers') ? { headers: jsonObject(form.headersText, 'Headers') } : {}),
        ...(jsonObject(form.envText, 'Environment') ? { env: jsonObject(form.envText, 'Environment') } : {}),
      };
      if (editingName) await updateMcpServer(editingName, config);
      else await createMcpServer(form.name.trim(), config);
      setForm(null);
      setEditingName(null);
      setToolsByServer({});
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (server: McpServer) => {
    if (!window.confirm(t('Delete {name}?', { name: server.accountName ?? server.name }))) return;
    setSaving(true);
    try {
      await deleteMcpServer(server.name);
      setToolsByServer((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleTools = async (server: McpServer) => {
    if (toolsByServer[server.name]) {
      setToolsByServer((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
      });
      return;
    }
    try {
      const data = await listMcpServerTools(server.name);
      setToolsByServer((current) => ({ ...current, [server.name]: data }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleTool = async (server: McpServer, tool: string) => {
    const current = toolsByServer[server.name];
    if (!current) return;
    const disabled = new Set(current.disabledTools);
    if (disabled.has(tool)) disabled.delete(tool);
    else disabled.add(tool);
    try {
      const result = await setMcpServerDisabledTools(server.name, Array.from(disabled));
      setToolsByServer((state) => ({ ...state, [server.name]: { ...current, disabledTools: result.disabledTools } }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Section title={t('MCP Servers')}>
      <div className="flex justify-end py-1">
        <Button type="button" variant="secondary" size="sm" onClick={() => { setEditingName(null); setForm(EMPTY_FORM); }}>
          <Plus className="size-4" /> {t('Add MCP server')}
        </Button>
      </div>
      {form && (
        <div className="mb-3 flex flex-col gap-3 rounded-card border border-border-main bg-bg-main p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-text-primary">{editingName ? t('Edit MCP server') : t('Add MCP server')}</p>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setForm(null); setEditingName(null); }} aria-label={t('Close')}>
              <X className="size-4" />
            </Button>
          </div>
          {!editingName && (
            <label className="flex flex-col gap-1 text-xs text-text-secondary">
              {t('Server name')}
              <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="slack-work" />
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Transport')}
            <select className={inputClass} value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as ServerForm['transport'] })}>
              <option value="stdio">stdio</option>
              <option value="http">HTTP/SSE</option>
            </select>
          </label>
          {form.transport === 'http' ? (
            <label className="flex flex-col gap-1 text-xs text-text-secondary">
              URL
              <input className={inputClass} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-xs text-text-secondary">
              {t('Command')}
              <input className={inputClass} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="node" />
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Account name')}
            <input className={inputClass} value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Custom instructions')}
            <textarea className={inputClass} rows={3} value={form.customInstructions} onChange={(e) => setForm({ ...form, customInstructions: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Headers (JSON, optional)')}
            <textarea className={inputClass} rows={2} value={form.headersText} onChange={(e) => setForm({ ...form, headersText: e.target.value })} placeholder={'{"Authorization":"Bearer <token>"}'} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Environment (JSON, optional)')}
            <textarea className={inputClass} rows={2} value={form.envText} onChange={(e) => setForm({ ...form, envText: e.target.value })} placeholder={'{"API_KEY":"<secret>"}'} />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setForm(null); setEditingName(null); }}>{t('Cancel')}</Button>
            <Button type="button" variant="primary" size="sm" loading={saving} onClick={() => void save()}>{t('Save')}</Button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-text-secondary"><Loader2 className="size-4 animate-spin" /> {t('Loading')}</div>
      ) : servers.length === 0 ? (
        <p className="py-4 text-sm text-text-tertiary">{t('No MCP servers connected.')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => {
            const toolState = toolsByServer[server.name];
            return (
              <li key={server.name} className="rounded-card border border-border-main bg-bg-menu p-3">
                <div className="flex items-center gap-3">
                  <Puzzle className="size-4 shrink-0 text-text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{server.accountName ?? server.name}</p>
                    <p className="truncate text-xs text-text-tertiary">{server.name} · {server.runtime.toolCount} {t('Tools')}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${server.runtime.connected ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`}>
                    {server.runtime.connected ? t('Connected') : t('Disconnected')}
                  </span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void toggleTools(server)}>{t('Tools')}</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(server)} aria-label={t('Edit')}><Pencil className="size-4" /></Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void remove(server)} aria-label={t('Delete')}><Trash2 className="size-4" /></Button>
                </div>
                {toolState && (
                  <ul className="mt-3 flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-border-main pt-3">
                    {toolState.tools.map((tool) => {
                      const enabled = !toolState.disabledTools.includes(tool.name);
                      return (
                        <li key={tool.name} className="flex items-center gap-2 text-xs">
                          <input type="checkbox" checked={enabled} onChange={() => void toggleTool(server, tool.name)} aria-label={tool.name} className="size-3.5 accent-text-primary" />
                          <span className="min-w-0 flex-1 truncate text-text-secondary" title={tool.description}>{tool.name}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="flex items-center gap-2 pt-2 text-xs text-function-error"><AlertCircle className="size-3.5" /> {error}</div>}
    </Section>
  );
}
