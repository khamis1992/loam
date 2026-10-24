'use client';

/**
 * Neo N13: the actions a webpage node offers (G19).
 *
 * Two things only a webpage can do: open the page the agent built in the sandbox
 * preview, and download a ZIP that opens offline. Both are server-side facts, so
 * the panel resolves the artifact first and then acts on the URLs the server
 * returned rather than building them itself: the server is the only place that
 * knows the page's directory and the token rule that protects it.
 *
 * The ZIP is fetched as a Blob and handed to an object URL. A plain link would
 * work too, but the route can fail for a reason worth showing (a page too large
 * to archive), and a failed `window.open` is silent. Fetching first turns that
 * into the message the panel already renders.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, Eye, Loader2 } from 'lucide-react';
import { canOpenWebpage, type CanvasClient } from './client';
import type { CanvasArtifactInfo, CanvasPreviewStart } from './nodeActions';

export interface WebpageActionsProps {
  client: CanvasClient;
  runId: string;
  nodeId: string;
  /** Node kind; the panel hides itself for anything that is not a webpage. */
  nodeType: string;
  /** Translate a key for this panel's locale. */
  tr: (key: string, vars?: Record<string, string | number>) => string;
  /** Absolute base the server's relative URLs resolve against. */
  apiBase: string;
}

export function WebpageActions({ client, runId, nodeId, nodeType, tr, apiBase }: WebpageActionsProps) {
  const isWebpage = canOpenWebpage(nodeType);
  const [artifact, setArtifact] = useState<CanvasArtifactInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await client.getNodeArtifact(runId, nodeId);
      setArtifact(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, nodeId, runId]);

  useEffect(() => {
    if (!isWebpage) return;
    void load();
  }, [isWebpage, load]);

  const open = useCallback(async () => {
    setError(null);
    try {
      const started: CanvasPreviewStart = await client.startNodePreview(runId, nodeId);
      setPreviewUrl(started.url);
      window.open(started.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, nodeId, runId]);

  const download = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      const blob = await client.downloadNodeZip(runId, nodeId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${artifact ? safeName(artifact.nodeId) : 'page'}.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // The URL is only needed until the browser has the bytes; releasing it
      // immediately after the click is enough for the download to start.
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }, [artifact, client, nodeId, runId]);

  if (!isWebpage) return null;

  const previewHref = previewUrl ?? (artifact ? `${apiBase}${artifact.url}` : null);

  return (
    <div className="flex flex-col gap-2" data-testid="canvas-webpage">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void open()}
          disabled={loading || Boolean(error)}
          className="flex items-center gap-1 rounded-control bg-fill-tsp px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-fill-hover disabled:opacity-50"
        >
          <Eye className="size-3.5" />
          {tr('Open in sandbox')}
        </button>
        <button
          type="button"
          onClick={() => void download()}
          disabled={downloading}
          className="flex items-center gap-1 rounded-control px-2 py-1 text-[11px] text-text-secondary hover:bg-fill-hover disabled:opacity-50"
        >
          {downloading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          {tr('Download ZIP')}
        </button>
        {previewHref ? (
          <a
            href={previewHref}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-control px-1 py-1 text-[11px] text-text-tertiary hover:bg-fill-hover"
          >
            <ExternalLink className="size-3.5" />
            {tr('Open in a new tab')}
          </a>
        ) : null}
      </div>

      {loading ? (
        <span className="flex items-center gap-1 text-[11px] text-text-tertiary">
          <Loader2 className="size-3 animate-spin" /> {tr('Loading')}
        </span>
      ) : error ? (
        <p className="text-[11px] text-function-error" data-testid="canvas-webpage-error">
          {error}
        </p>
      ) : artifact ? (
        <p className="truncate text-[10px] text-text-quaternary" dir="auto" title={artifact.entry}>
          {artifact.entry}
        </p>
      ) : (
        <p className="text-[11px] text-text-tertiary" data-testid="canvas-webpage-missing">
          {tr('This page has no artifact directory.')}
        </p>
      )}
    </div>
  );
}

/** A download file name that cannot escape the current directory. */
function safeName(nodeId: string): string {
  const cleaned = nodeId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'page';
}
