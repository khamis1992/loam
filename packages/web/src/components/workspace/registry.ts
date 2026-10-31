import type { WorkspaceEditorDef, WorkspaceFile, WorkspaceKind } from './types';

const editors = new Map<WorkspaceKind, WorkspaceEditorDef>();
const listeners = new Set<() => void>();
let version = 0;

/** localStorage key prefix for the per-extension editor override: `<prefix><ext> = kind`. */
export const EDITOR_OVERRIDE_PREFIX = 'loam.editor.override.';

/**
 * Editor generation rank (the gateway): when several editors claim the same
 * extension, the highest rank opens the file automatically.
 *
 * - 3  `loam-video` (the dedicated video studio) and `craft` (the vendored Loam
 *      Craft apps own every docs/sheets/slides/photo/design format they claim;
 *      the panel falls back to the built-ins inside the craft editor itself).
 * - 2  the built-in web editors (doc/sheet/slides/canvas).
 * - 1  `video`, the basic player that `loam-video` supersedes.
 *
 * Unknown kinds rank lowest so a future registration never beats a known one by
 * accident. Ties keep registration order (first registered wins).
 */
const GENERATION_BY_KIND: Record<WorkspaceKind, number> = {
  video: 1,
  doc: 2,
  sheet: 2,
  slides: 2,
  canvas: 2,
  'loam-video': 3,
  craft: 3,
};

function generationOf(def: WorkspaceEditorDef): number {
  return GENERATION_BY_KIND[def.kind] ?? 0;
}

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

/**
 * Every registered editor claiming one extension, best generation first
 * (registration order breaks ties). This is the «فتح بواسطة» menu's source of truth.
 */
export function listEditorsForPath(filePath: string): WorkspaceEditorDef[] {
  const ext = extensionOf(filePath);
  if (!ext) return [];
  return listEditors()
    .filter((def) => matchesExtension(def, ext))
    .sort((a, b) => generationOf(b) - generationOf(a));
}

/** The stored per-extension editor override, or null when the auto pick applies. */
export function getEditorOverride(ext: string): WorkspaceKind | null {
  const key = ext.replace(/^\./, '').toLowerCase();
  if (!key || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(EDITOR_OVERRIDE_PREFIX + key);
    return raw ? (raw as WorkspaceKind) : null;
  } catch {
    return null;
  }
}

/** Store (kind) or clear (null) the per-extension editor override. */
export function setEditorOverride(ext: string, kind: WorkspaceKind | null): void {
  const key = ext.replace(/^\./, '').toLowerCase();
  if (!key || typeof window === 'undefined') return;
  try {
    if (kind) window.localStorage.setItem(EDITOR_OVERRIDE_PREFIX + key, kind);
    else window.localStorage.removeItem(EDITOR_OVERRIDE_PREFIX + key);
  } catch {
    /* storage may be unavailable (private mode); the override is best-effort */
  }
  // Subscribers (the Workspace panel) re-resolve and refetch so the override
  // applies immediately.
  notify();
}

/**
 * Resolve an editor for a path, in order:
 * 1. the user's per-extension override (`loam.editor.override.<ext>` = kind),
 * 2. the best available editor generation claiming the extension,
 * and null when nothing claims it.
 */
export function getEditorForPath(filePath: string): WorkspaceEditorDef | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  const overrideKind = getEditorOverride(ext);
  if (overrideKind) {
    const override = editors.get(overrideKind);
    if (override) return override;
  }
  return listEditorsForPath(filePath)[0] ?? null;
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
