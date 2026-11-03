'use client';

import { useEffect, useState } from 'react';
import { getApiBase, getApiHeaders } from '@/services/rpc';

interface StudioArtifact {
  title?: string;
  kind?: string;
  content?: {
    slides?: Array<{ id?: string; title?: string; body?: string }>;
    blocks?: Array<{ type?: string; text?: string }>;
    sheets?: Array<{ name?: string; cells?: string[][] }>;
  };
}

/** Renders `.loam/studio.json` as the studio artifact instead of a raw-file card. */
export function StudioFileView({ taskId }: { taskId: string }) {
  const [artifact, setArtifact] = useState<StudioArtifact | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/studio?taskId=${encodeURIComponent(taskId)}`, { headers });
        if (!res.ok) {
          if (!stop) setError('No studio artifact yet');
          return;
        }
        const body = (await res.json()) as { artifact?: StudioArtifact | null };
        if (!stop) setArtifact(body.artifact ?? null);
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : 'Studio unavailable');
      }
    })();
    return () => {
      stop = true;
    };
  }, [taskId]);

  if (error) return <p className="p-4 text-sm text-text-tertiary">{error}</p>;
  if (!artifact) return <p className="p-4 text-sm text-text-tertiary">Studio</p>;
  const slides = artifact.content?.slides ?? [];
  const blocks = artifact.content?.blocks ?? [];
  const sheets = artifact.content?.sheets ?? [];
  return (
    <article className="h-full overflow-auto bg-white p-6 text-[#222]" dir="auto" data-testid="studio-file-view">
      <h1 className="mb-4 text-xl font-semibold">{artifact.title || 'Studio'}</h1>
      {slides.map((slide) => (
        <section key={slide.id ?? slide.title} className="mb-4 rounded-md border border-[#e6e6e3] p-4">
          <h2 className="text-lg font-medium">{slide.title}</h2>
          {slide.body ? <p className="mt-2 whitespace-pre-wrap leading-7">{slide.body}</p> : null}
        </section>
      ))}
      {blocks.map((block, index) => (
        <p key={index} className={block.type === 'heading' ? 'mb-2 text-lg font-medium' : 'mb-3 leading-7'}>
          {block.text}
        </p>
      ))}
      {sheets.map((sheet) => (
        <section key={sheet.name} className="mb-4">
          <h2 className="mb-2 text-lg font-medium">{sheet.name}</h2>
          <table className="border-collapse text-sm">
            <tbody>
              {(sheet.cells ?? []).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border border-[#e6e6e3] px-2 py-1">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </article>
  );
}

export function isStudioArtifactPath(filePath: string | null | undefined): boolean {
  return (filePath ?? '').replace(/\\/g, '/').endsWith('.loam/studio.json');
}
