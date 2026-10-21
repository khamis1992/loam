import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { WorkspaceFile } from '../types';

export interface DocLoad {
  html: string;
  session: string;
  mtimeMs: number;
  editable: boolean;
  warnings: string[];
}

export interface DocMeta {
  mtimeMs: number;
  size: number;
}

function base(file: WorkspaceFile, extra = ''): string {
  return `${getApiBase()}/api/workspace/doc/file?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}${extra}`;
}

export async function loadDoc(file: WorkspaceFile): Promise<DocLoad> {
  const response = await fetch(base(file), { headers: await getApiHeaders() });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as DocLoad;
}

export async function loadDocMeta(file: WorkspaceFile): Promise<DocMeta> {
  const response = await fetch(base(file, '&metaOnly=1'), { headers: await getApiHeaders() });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as DocMeta;
}
