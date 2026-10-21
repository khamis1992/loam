/** Client helper for the sheet workspace editor: mirrors the server's JSON sheet model. */
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { SheetDoc } from './sheetModel';

export * from './sheetModel';

export function sheetUrl(file: { taskId: string; path: string }, format?: 'raw'): string {
  const params = new URLSearchParams({ taskId: file.taskId, path: file.path });
  if (format) params.set('format', format);
  return `${getApiBase()}/api/workspace/sheet/file?${params.toString()}`;
}

export async function loadSheetDoc(file: { taskId: string; path: string }): Promise<SheetDoc> {
  const res = await fetch(sheetUrl(file), { headers: await getApiHeaders() });
  if (!res.ok) {
    const message = await res.json().catch(() => ({}));
    throw new Error(typeof message.error === 'string' ? message.error : `HTTP ${res.status}`);
  }
  return (await res.json()) as SheetDoc;
}

/** Direct PUT used when the panel delegates save itself; onSave is preferred. */
export async function saveSheetDoc(file: { taskId: string; path: string }, body: string): Promise<void> {
  const res = await fetch(sheetUrl(file), {
    method: 'PUT',
    headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const message = await res.json().catch(() => ({}));
    throw new Error(typeof message.error === 'string' ? message.error : `HTTP ${res.status}`);
  }
}
