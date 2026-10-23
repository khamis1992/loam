import type { WorkspaceEditorDef, WorkspaceFile, WorkspaceKind } from './types';

const editors = new Map<WorkspaceKind, WorkspaceEditorDef>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a listener failure must not break registration */
    }
  }
}

export function registerEditor(def: WorkspaceEditorDef): void {
  editors.set(def.kind, def);
  notify();
}

export function listEditors(): WorkspaceEditorDef[] {
  return [...editors.values()];
}

export function getEditorForKind(kind: WorkspaceKind): WorkspaceEditorDef | null {
  return editors.get(kind) ?? null;
}

export function extensionOf(filePath: string): string {
  const clean = filePath.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function matchesExtension(def: WorkspaceEditorDef, ext: string): boolean {
  return def.extensions.map((e) => e.replace(/^\./, '').toLowerCase()).includes(ext);
}

/** Resolve an editor primarily by extension, falling back to the declared kind. */
export function getEditorForPath(filePath: string): WorkspaceEditorDef | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  // The Loam Video studio is the primary video surface; the built-in `video`
  // editor is its fallback. Registration order is async, so prefer it explicitly.
  const loamVideo = editors.get('loam-video');
  if (loamVideo && matchesExtension(loamVideo, ext)) return loamVideo;
  for (const def of editors.values()) {
    if (matchesExtension(def, ext)) return def;
  }
  return null;
}

export function getEditorForFile(file: WorkspaceFile): WorkspaceEditorDef | null {
  // The path extension is the stronger signal; the declared kind is the fallback.
  return getEditorForPath(file.path) ?? getEditorForKind(file.kind);
}

/** Subscribe to late registrations (dynamic imports). Returns an unsubscribe fn. */
export function subscribeWorkspaceEditors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function workspaceEditorsVersion(): number {
  return version;
}
