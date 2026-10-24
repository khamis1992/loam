'use client';

/**
 * Neo N13: "Add to Knowledge Base" from a run node.
 *
 * The preview is shown *before* anything is written, because the smart splitter
 * decides how many seeds a node becomes and the user should see that cost before
 * paying it. The target base defaults to the first existing one; when the garden
 * is empty the server creates a base named after the node, which is why the
 * control is a select plus a free-text fallback rather than a required choice.
 *
 * Every failure is a sentence in the panel, never a thrown error: a node with no
 * text, an offline server, or a garden the embedder cannot reach must all read
 * as something the user can act on.
 */
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';
import { canUseNodeActions, type CanvasClient } from './client';
import type { CanvasKnowledgePreview, CanvasKnowledgeResult } from './nodeActions';

export interface KnowledgePanelProps {
  client: CanvasClient;
  runId: string;
  nodeId: string;
  /** Node kind; the panel hides itself for a node that carries no document text. */
  nodeType: string;
  /** Translate a key for this panel's locale. */
  tr: (key: string, vars?: Record<string, string | number>) => string;
}

interface BaseChoice {
  id: string;
  name: string;
  seeds: number;
}

export function KnowledgePanel({ client, runId, nodeId, nodeType, tr }: KnowledgePanelProps) {
  const usable = canUseNodeActions(nodeType);
  const [preview, setPreview] = useState<CanvasKnowledgePreview | null>(null);
  const [bases, setBases] = useState<BaseChoice[]>([]);
  const [baseId, setBaseId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CanvasKnowledgeResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nodePreview, baseList] = await Promise.all([
        client.previewNodeKnowledge(runId, nodeId),
        client.listKnowledgeBases().catch(() => [] as BaseChoice[]),
      ]);
      setPreview(nodePreview);
      setBases(baseList);
      // The first base is the sensible default; an empty garden lets the server
      // name a new one after the node.
      setBaseId((prev) => prev || (baseList.length > 0 ? baseList[0]!.id : ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, nodeId, runId]);

  useEffect(() => {
    if (!usable) return;
    void load();
  }, [load, usable]);

  const add = useCallback(async () => {
    setError(null);
    setResult(null);
    try {
      const created = await client.addToKnowledgeBase(runId, nodeId, { baseId: baseId || undefined });
      setResult(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [baseId, client, nodeId, runId]);

  if (!usable) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="canvas-knowledge">
      <div className="flex items-center gap-1.5">
        <BookOpen className="size-3.5 text-text-tertiary" />
        <span className="text-[11px] font-medium text-text-secondary">{tr('Knowledge Base')}</span>
      </div>

      {loading ? (
        <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
          <Loader2 className="size-3 animate-spin" /> {tr('Loading')}
        </span>
      ) : error ? (
        <p className="text-[11px] text-function-error" data-testid="canvas-knowledge-error">
          {error}
        </p>
      ) : result ? (
        <p className="text-[11px] text-function-success" data-testid="canvas-knowledge-done">
          {tr('Added {count} seeds to {base}', { count: result.seeds.length, base: result.baseName })}
        </p>
      ) : preview ? (
        <>
          <p className="text-[11px] text-text-tertiary" data-testid="canvas-knowledge-count">
            {tr('{count} seeds', { count: preview.count })}
            {preview.seeds.length > 0 ? ` · ${tr(preview.baseName || 'Knowledge Base')}` : ''}
          </p>

          {preview.seeds.length === 0 ? (
            <p className="text-[11px] text-text-tertiary" data-testid="canvas-knowledge-empty">
              {tr('This node carries no text to add.')}
            </p>
          ) : (
            <>
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {preview.seeds.map((seed, index) => (
                  <li
                    key={`${seed.title}-${index}`}
                    className="rounded-control border border-border-main bg-fill-tsp px-2 py-1"
                    data-testid="canvas-knowledge-seed"
                  >
                    <p className="truncate text-[11px] font-medium text-text-primary" dir="auto">
                      {seed.title}
                    </p>
                    <p className="truncate text-[10px] text-text-tertiary" dir="auto">
                      {seed.body}
                    </p>
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={baseId}
                  onChange={(event) => setBaseId(event.target.value)}
                  aria-label={tr('Knowledge Base')}
                  className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-1 py-0.5 text-[11px] text-text-primary"
                >
                  <option value="">{tr('Knowledge Base')}</option>
                  {bases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void add()}
                  className="rounded-control bg-fill-tsp px-2 py-0.5 text-[11px] font-medium text-text-primary hover:bg-fill-hover"
                >
                  {tr('Add to Knowledge Base')}
                </button>
              </div>

              {preview.warnings.length > 0 ? (
                <p className="text-[10px] text-function-warning" dir="auto">
                  {preview.warnings.join(' · ')}
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
