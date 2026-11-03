'use client';

import { useEffect, useState } from 'react';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { t } from '@/i18n/t';
import { Section, Row } from './SettingsDialog';

interface RecallHit {
  id: string;
  content: string;
  kind: string;
  state: string;
}

export function RecallControls() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RecallHit[]>([]);
  const [rerank, setRerank] = useState(true);
  const [embedder, setEmbedder] = useState('nomic-embed-text:latest');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState('');

  async function search() {
    const headers = await getApiHeaders();
    const res = await fetch(`${getApiBase()}/api/recall/search?q=${encodeURIComponent(query)}`, { headers });
    const data = (await res.json()) as { hits?: RecallHit[] };
    setHits(data.hits ?? []);
  }

  async function act(path: string, id: string, extra: Record<string, unknown> = {}) {
    const headers = await getApiHeaders();
    await fetch(`${getApiBase()}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...extra }),
    });
    await search();
  }

  useEffect(() => {
    if (!progress) return undefined;
    const timer = window.setInterval(() => { void refreshProgress(); }, 1000);
    return () => window.clearInterval(timer);
  }, [progress]);

  async function refreshProgress() {
    const headers = await getApiHeaders();
    const res = await fetch(`${getApiBase()}/api/recall/stats`, { headers });
    const data = (await res.json()) as { reembed?: { total: number; done: number; error?: string } };
    const job = data.reembed;
    if (!job || (job.done >= job.total && !job.error)) {
      setProgress('');
      return;
    }
    setProgress(job.error ?? `${job.done}/${job.total}`);
  }

  async function save() {
    const headers = await getApiHeaders();
    await fetch(`${getApiBase()}/api/recall/settings`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ rerank, embedder }),
    });
    setMessage(t('Saved'));
    setProgress('0/0');
    await refreshProgress();
  }

  return (
    <Section title={t('Loam Recall')}>
      <div dir="auto" className="flex flex-col gap-2 py-3">
        <Row label={t('Search memory')} description={t('Find a stored fact, then confirm, forget, or restore it.')}>
          <span />
        </Row>
        <div className="flex gap-2">
          <input dir="auto" value={query} onChange={(event) => setQuery(event.target.value)} className="flex-1 rounded-control border border-border-main bg-bg-menu px-2 py-1 text-sm" />
          <button type="button" onClick={() => void search()} className="rounded-control bg-fill-tsp px-3 py-1 text-sm">{t('Search')}</button>
        </div>
        <ul className="flex flex-col gap-2">
          {hits.map((hit) => (
            <li key={hit.id} dir="auto" className="rounded-card border border-border-main p-2 text-sm">
              <div className="text-xs text-text-tertiary">{hit.kind} · {hit.state}</div>
              <p>{hit.content}</p>
              <div className="mt-1 flex gap-2">
                <button type="button" className="text-xs" onClick={() => void act('/api/recall/confirm', hit.id)}>{t('Confirm')}</button>
                <button type="button" className="text-xs" onClick={() => void act('/api/recall/forget', hit.id)}>{t('Forget')}</button>
                <button type="button" className="text-xs" onClick={() => void act('/api/recall/restore', hit.id)}>{t('Restore')}</button>
              </div>
            </li>
          ))}
        </ul>
        <Row label={t('Rerank')} description={t('Ask the local model to rescore search hits. It turns itself off when it is too slow.')}>
          <input type="checkbox" checked={rerank} onChange={(event) => setRerank(event.target.checked)} />
        </Row>
        <label className="flex flex-col gap-1 text-sm">
          {t('Embedding model')}
          <select dir="auto" value={embedder} onChange={(event) => setEmbedder(event.target.value)} className="rounded-control border border-border-main bg-bg-menu px-2 py-1">
            <option value="nomic-embed-text:latest">nomic-embed-text</option>
            <option value="bge-m3">bge-m3</option>
            <option value="embeddinggemma">embeddinggemma</option>
          </select>
        </label>
        <button type="button" onClick={() => void save()} className="self-start rounded-control bg-fill-tsp px-3 py-1 text-sm">{t('Save')}</button>
        {message ? <p className="text-xs text-text-tertiary">{message}</p> : null}
        {progress ? <p className="text-xs text-text-tertiary">{t('Re-embedding')} {progress}</p> : null}
      </div>
    </Section>
  );
}
