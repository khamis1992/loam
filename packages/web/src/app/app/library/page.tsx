'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileText, Loader2, AlertCircle } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getLoamAuthHeaders } from '@/services/rpc';

interface FileItem {
  name: string;
  path?: string;
  size?: number;
  updatedAt?: string;
}

export default function LibraryPage() {
  const router = useRouter();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/files`, {
          headers: getLoamAuthHeaders(),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { files?: FileItem[] };
        if (mounted) setFiles(data.files ?? []);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
        // eslint-disable-next-line no-console
        console.error('failed to load library files', e);
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
        <h1 className="text-title-lg text-text-primary">{t('Library')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-function-error">
            <AlertCircle className="size-6" />
            <p className="text-sm">{t('Failed to load library')}</p>
            <p className="max-w-[320px] text-center text-xs">{error}</p>
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-tertiary">
            <p className="text-sm">{t('No files in library.')}</p>
            <p className="max-w-[320px] text-center text-xs">{t('Task outputs and uploads will appear here once the backend indexes them.')}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-fill-hover">
                <FileText className="size-4 text-text-tertiary" />
                <span className="flex-1 truncate text-sm text-text-primary">{f.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
