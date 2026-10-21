import type { WorkspaceEditorDef, WorkspaceFile } from "./types";

const editors = new Map<string, WorkspaceEditorDef>();

/** Register one workspace editor kind (called from side-effect register.ts files). */
export function registerEditor(def: WorkspaceEditorDef): void {
  editors.set(def.kind, def);
}

function matches(def: WorkspaceEditorDef, file: WorkspaceFile): boolean {
  const lower = file.path.toLowerCase();
  return (def.extensions ?? []).some((ext) => lower.endsWith(ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
}

export function getEditorForFile(file: WorkspaceFile): WorkspaceEditorDef | undefined {
  if (editors.has(file.kind)) {
    const def = editors.get(file.kind)!;
    if (matches(def, file)) return def;
  }
  return [...editors.values()].find((def) => def.kind === file.kind && matches(def, file));
}

export function listEditors(): WorkspaceEditorDef[] {
  return [...editors.values()];
}
