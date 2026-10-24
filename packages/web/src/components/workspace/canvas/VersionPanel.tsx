'use client';

/**
 * Neo N13: the version list and diff for one document node (G18).
 *
 * The server owns the versions (`src/graph/versions.ts`) and the diff. This
 * component only fetches, selects two of them and hands the pair to `DiffView`.
 * The selection defaults to the previous version against the newest, which is
 * the comparison a user almost always means: "what did I change last?".
 *
 * Every network failure lands in `onError` as a message the sheet shows in place
 * of the list, so a node that cannot be versioned, or a run that has gone away,
 * degrades to a sentence rather than an empty panel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { canUseNodeActions, type CanvasClient } from './client';
import type { CanvasDiff, CanvasVersion, CanvasVersionList } from './nodeActions';
import { DiffView } from './DiffView';

export interface VersionPanelProps {
  client: CanvasClient;
  runId: string;
  nodeId: string;
  /** Node kind; the panel hides itself entirely for a node that cannot be versioned. */
  nodeType: string;
  /** Translate a key for this panel's locale. */
  tr: (key: string, vars?: Record<string, string | number>) => string;
}

export function VersionPanel({ client, runId, nodeId, nodeType, tr }: VersionPanelProps) {
  const versionable = canUseNodeActions(nodeType);
  const [versions, setVersions] = useState<CanvasVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<CanvasDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list: CanvasVersionList = await client.getNodeVersions(runId, nodeId);
      setVersions(list.versions);
      // The comparison the user means by default: the newest against the one before.
      const newest = list.versions.length > 0 ? list.versions[list.versions.length - 1]!.version : null;
      const previous = list.versions.length > 1 ? list.versions[list.versions.length - 2]!.version : null;
      setTo(newest);
      setFrom(previous ?? newest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, nodeId, runId]);

  useEffect(() => {
    if (!versionable) return;
    void load();
  }, [load, versionable]);

  // Refetch the diff whenever the selected pair changes, so the two selects and
  // the view never disagree about which versions are being compared.
  useEffect(() => {
    if (!versionable || from === null || to === null) return;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    void client
      .getNodeDiff(runId, nodeId, from, to)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDiffError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, from, nodeId, runId, to, versionable]);

  const capture = useCallback(async () => {
    setError(null);
    try {
      const result = await client.captureNodeVersion(runId, nodeId);
      setCaptured(result.version);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, load, nodeId, runId]);

  if (!versionable) {
    return (
      <p className="text-[11px] text-text-tertiary" data-testid="canvas-versions-unsupported">
        {tr('This node cannot be versioned.')}
      </p>
    );
  }

  const options = useMemo(
    () =>
      versions.map((version) => (
        <option key={version.version} value={version.version}>
          {tr('Version {version}', { version: version.version })}
        </option>
      )),
    [tr, versions],
  );

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="canvas-versions">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-text-secondary">{tr('Versions')}</span>
        <span className="text-[11px] text-text-tertiary" data-testid="canvas-versions-count">
          {tr('{count} versions', { count: versions.length })}
        </span>
        <button
          type="button"
          onClick={() => void capture()}
          className="ms-auto rounded-control px-2 py-0.5 text-[11px] text-text-secondary hover:bg-fill-hover"
        >
          {tr('Capture a snapshot')}
        </button>
      </div>

      {loading ? (
        <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
          <Loader2 className="size-3 animate-spin" /> {tr('Loading')}
        </span>
      ) : error ? (
        <p className="text-[11px] text-function-error" data-testid="canvas-versions-error">
          {error}
        </p>
      ) : versions.length === 0 ? (
        <p className="text-[11px] text-text-tertiary" data-testid="canvas-versions-empty">
          {tr('No versions yet.')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-[11px] text-text-tertiary">
              <select
                value={from ?? ''}
                onChange={(event) => setFrom(Number(event.target.value))}
                aria-label={tr('Compare versions')}
                className="rounded-control border border-border-main bg-bg-main px-1 py-0.5 text-[11px] text-text-primary"
              >
                {options}
              </select>
            </label>
            <span className="text-[11px] text-text-tertiary">→</span>
            <label className="flex items-center gap-1 text-[11px] text-text-tertiary">
              <select
                value={to ?? ''}
                onChange={(event) => setTo(Number(event.target.value))}
                aria-label={tr('Compare versions')}
                className="rounded-control border border-border-main bg-bg-main px-1 py-0.5 text-[11px] text-text-primary"
              >
                {options}
              </select>
            </label>
            {diffLoading ? <Loader2 className="size-3 animate-spin text-text-tertiary" /> : null}
          </div>

          {captured !== null ? (
            <p className="text-[11px] text-function-success" data-testid="canvas-versions-captured">
              {tr('Captured version {version}', { version: captured })}
            </p>
          ) : null}

          {diffError ? (
            <p className="text-[11px] text-function-error">{diffError}</p>
          ) : diff ? (
            <div className="min-h-0 overflow-y-auto">
              <DiffView diff={diff} tr={tr} />
            </div>
          ) : (
            <p className="text-[11px] text-text-tertiary">{tr('Pick two versions to compare.')}</p>
          )}
        </>
      )}
    </div>
  );
}
