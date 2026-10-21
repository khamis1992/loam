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

/** Resolve an editor primarily by extension, falling back to the declared kind. */
export function getEditorForPath(filePath: string): WorkspaceEditorDef | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  for (const def of editors.values()) {
    const extensions = def.extensions.map((e) => e.replace(/^\./, '').toLowerCase());
    if (extensions.includes(ext)) return def;
  }
  return null;
}

export function getEditorForFile(file: WorkspaceFile): WorkspaceEditorDef | null {
  const byPath = getEditorForPath(file.path);
  if (byPath && byPath.kind === file.kind) return byPath;
  const byKind = getEditorForKind(file.kind);
  if (byKind) return byKind; // kind matches even when the extension drifted (e.g. renamed file)
  return byPath;
}

/** Subscribe to late registrations (dynamic imports). Returns an unsubscribe fn. */
export function subscribeWorkspaceEditors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function workspaceEditorsVersion(): number {
  return version;
}
