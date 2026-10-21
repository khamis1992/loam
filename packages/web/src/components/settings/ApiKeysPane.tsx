'use client';

import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { Row, Section } from './SettingsDialog';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

/**
 * Settings > Integrations / Developers (UNIMPLEMENTED_OPTIONS #7).
 *
 * CRUD for developer API keys backed by the Loam server:
 *  - GET    /api/api-keys              → list keys (masked: only a prefix is ever stored)
 *  - POST   /api/api-keys              → create; the raw key is returned exactly once
 *  - POST   /api/api-keys/:id/revoke   → revoke a key
 *
 * The raw key is never persisted server-side (only its SHA-256 hash is), so it is
 * shown once at creation and cannot be recovered afterwards.
 */

type ApiKeyInfo = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

type CreatedApiKey = ApiKeyInfo & { key: string };

type Notice = { kind: 'ok' | 'error'; text: string } | null;

function mask(prefix: string): string {
  return `${prefix}…`;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function ApiKeysPane() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/api-keys`, { headers: await getApiHeaders() });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { keys?: ApiKeyInfo[] };
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch {
      /* leave the list as-is on failure */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    setCreating(true);
    setNotice(null);
    try {
      const res = await fetch(`${getApiBase()}/api/api-keys`, {
        method: 'POST',
        headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as CreatedApiKey & { keys?: ApiKeyInfo[] };
      setCreated(data);
      setCopied(false);
      setName('');
      if (Array.isArray(data.keys)) setKeys(data.keys);
      else await load();
    } catch {
      setNotice({ kind: 'error', text: t('Could not create the API key') });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    setNotice(null);
    try {
      const res = await fetch(`${getApiBase()}/api/api-keys/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
        headers: await getApiHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { keys?: ApiKeyInfo[] };
      if (Array.isArray(data.keys)) setKeys(data.keys);
      else await load();
      setNotice({ kind: 'ok', text: t('API key revoked') });
    } catch {
      setNotice({ kind: 'error', text: t('Could not revoke the API key') });
    } finally {
      setRevokingId(null);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const closeCreated = () => {
    setCreated(null);
    setCopied(false);
  };

  return (
    <div className="space-y-2">
      <Section title={t('API keys')}>
        <Row
          label={t('Developer API keys')}
          description={t('Create keys to call the Loam API from your own tools. A key is shown only once.')}
        >
          <span className="text-xs text-text-tertiary">{loading ? t('Loading…') : `${keys.length}`}</span>
        </Row>
      </Section>

      <Section title={t('Create a key')}>
        <Row label={t('Key name')} description={t('A label so you can recognise this key later.')}>
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('e.g. my-script')}
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-44 rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
            />
            <Button variant="secondary" size="sm" loading={creating} onClick={() => void create()}>
              {t('Create key')}
            </Button>
          </div>
        </Row>
      </Section>

      <Section title={t('Your keys')}>
        {keys.length === 0 ? (
          <Row label={t('No API keys yet')} description={t('Create one above to get started.')}>
            <span />
          </Row>
        ) : (
          keys.map((key) => {
            const revoked = Boolean(key.revokedAt);
            return (
              <Row
                key={key.id}
                label={key.name}
                description={`${mask(key.prefix)} · ${t('Created')} ${formatDate(key.createdAt)} · ${revoked ? t('Revoked') : t('Active')}${key.lastUsedAt ? ` · ${t('Last used')} ${formatDate(key.lastUsedAt)}` : ''}`}
              >
                <Button
                  variant={revoked ? 'ghost' : 'danger'}
                  size="sm"
                  disabled={revoked || revokingId === key.id}
                  onClick={() => void revoke(key.id)}
                >
                  {revoked ? t('Revoked') : t('Revoke')}
                </Button>
              </Row>
            );
          })
        )}
      </Section>

      {notice && (
        <p className={notice.kind === 'ok' ? 'text-sm text-function-success' : 'text-sm text-function-error'}>{notice.text}</p>
      )}

      <Dialog open={created !== null} onClose={closeCreated} title={t('API key created')} width={560}>
        <p className="mb-3 text-sm text-text-secondary">
          {t('Copy this key now. It is shown only once and cannot be recovered.')}
        </p>
        <input
          readOnly
          value={created?.key ?? ''}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          className="h-9 w-full rounded-control border border-border-main bg-fill-tsp px-3 font-mono text-sm text-text-primary outline-none"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            {copied ? t('Copied') : t('Copy key')}
          </Button>
          <Button variant="ghost" size="sm" onClick={closeCreated}>
            {t('Done')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
