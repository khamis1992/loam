'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import type { WorkspaceFile } from '../types';

/** د3 client: joins the doc's collab room, keeps presence, sends local edit
 *  intents and applies remote patches. Remote edits land through the SAME
 *  tracked-changes model as local ones — just another author in the runs.
 *
 *  v1 honest limits: accept/reject and comment threads stay local; the synced
 *  unit is the typed edit (insert/delete at a visible offset), the server is
 *  canonical, and a stale op (409) asks the caller to re-sync the document. */

export interface CollabMember { clientId: string; name: string; color: string }

export type CollabOp =
  | { kind: 'insert'; paragraphId: string; offset: number; text: string }
  | { kind: 'delete'; paragraphId: string; offset: number; direction: 'backward' | 'forward' };

interface UseCollabOptions {
  file: WorkspaceFile;
  enabled: boolean;
  /** Display name for this client (document identity name). */
  displayName: string;
  /** Called for every remote patch (own echoes filtered by clientId). */
  onPatch: (patch: { clientId: string; authorName: string; op: CollabOp }) => void;
  /** Called when the server rejects a stale op — re-sync the document. */
  onConflict: () => void;
}

export function useCollab({ file, enabled, displayName, onPatch, onConflict }: UseCollabOptions) {
  const [members, setMembers] = useState<CollabMember[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientIdRef = useRef('');
  const seqRef = useRef(0);
  const colorRef = useRef<string | null>(null);
  const headersRef = useRef<Record<string, string> | null>(null);
  const membersRef = useRef<CollabMember[]>([]);
  const patchCbRef = useRef(onPatch);
  patchCbRef.current = onPatch;
  const conflictCbRef = useRef(onConflict);
  conflictCbRef.current = onConflict;
  const fileRef = useRef(file);
  fileRef.current = file;

  const apiBase = useMemo(() => getApiBase(), []);

  const sendOp = useCallback((op: CollabOp) => {
    const headers = headersRef.current;
    if (!headers || !clientIdRef.current) return;
    void fetch(`${apiBase}/api/collab/op`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: fileRef.current.taskId,
        path: fileRef.current.path,
        clientId: clientIdRef.current,
        op,
        baseSeq: seqRef.current,
      }),
    })
      .then(async (res) => {
        if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as { seq?: number };
          if (typeof body.seq === 'number') seqRef.current = Math.max(seqRef.current, body.seq);
          conflictCbRef.current();
        }
      })
      .catch(() => undefined);
  }, [apiBase]);

  useEffect(() => {
    if (!enabled || !file.taskId) return;
    let cancelled = false;
    const controller = new AbortController();
    clientIdRef.current = crypto.randomUUID();

    void (async () => {
      try {
        headersRef.current = (await getApiHeaders()) as Record<string, string>;

        // 1) join → room seq + members + our color.
        const joinRes = await fetch(`${apiBase}/api/collab/join`, {
          method: 'POST',
          headers: { ...headersRef.current, 'content-type': 'application/json' },
          body: JSON.stringify({ taskId: file.taskId, path: file.path, clientId: clientIdRef.current, name: displayName }),
        });
        if (!joinRes.ok) throw new Error(`join ${joinRes.status}`);
        const join = (await joinRes.json()) as { seq?: number; members?: CollabMember[]; color?: string };
        if (cancelled) return;
        seqRef.current = Number(join.seq) || 0;
        colorRef.current = typeof join.color === 'string' ? join.color : null;
        membersRef.current = Array.isArray(join.members) ? join.members : [];
        setMembers(membersRef.current);
        setConnected(true);
        setError(null);

        // 2) SSE stream: presence + patches (hello/catch-up happen server-side).
        const params = new URLSearchParams({
          taskId: file.taskId, path: file.path,
          clientId: clientIdRef.current, afterSeq: String(join.seq),
        });
        const stream = await fetch(`${apiBase}/api/collab/stream?${params}`, {
          headers: headersRef.current,
          signal: controller.signal,
        });
        if (!stream.ok || !stream.body) throw new Error(`stream ${stream.status}`);
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            const eventName = /^event: (.+)$/m.exec(frame)?.[1] ?? 'message';
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            let data: Record<string, unknown>;
            try { data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>; }
            catch { continue; }
            if (eventName === 'presence') {
              membersRef.current = Array.isArray(data.members) ? (data.members as CollabMember[]) : [];
              setMembers(membersRef.current);
            } else if (eventName === 'patch') {
              seqRef.current = Math.max(seqRef.current, Number(data.seq) || 0);
              const patch = data as unknown as { clientId: string; op: CollabOp };
              if (patch.clientId === clientIdRef.current) continue; // own echo
              const author = membersRef.current.find((m) => m.clientId === patch.clientId);
              patchCbRef.current({
                clientId: patch.clientId,
                authorName: author?.name ?? patch.clientId,
                op: patch.op,
              });
            }
          }
          if (cancelled) break;
        }
      } catch (reason) {
        if (!cancelled && !(reason instanceof DOMException && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setConnected(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (!clientIdRef.current) return;
      void fetch(`${apiBase}/api/collab/leave`, {
        method: 'POST',
        headers: { ...(headersRef.current ?? {}), 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: file.taskId, path: file.path, clientId: clientIdRef.current }),
      }).catch(() => undefined);
      clientIdRef.current = '';
      setConnected(false);
      setMembers([]);
    };
  }, [enabled, file.taskId, file.path, displayName, apiBase]);

  return { members, connected, error, selfColor: colorRef.current, sendOp };
}
