/**
 * Neo N13: the node-action data contract for the canvas.
 *
 * The graph (`types.ts`) describes the *graph*. These types describe what a single
 * node can do once it has been produced: its version history and line diff (G18),
 * the "Add to Knowledge Base" preview and result, and the webpage-node artifact
 * actions (G19). They mirror the replies of `src/server/routes/graphNodes.ts`, so
 * a payload from the server and the object the node detail sheet renders cannot
 * drift apart.
 *
 * Every field the UI reads is coerced by hand rather than trusted, so a partial or
 * older reply still renders something honest instead of crashing the sheet.
 */

/** One stored snapshot of a node's document. */
export interface CanvasVersion {
  /** 1-based version number. */
  version: number;
  /** Human title of the document at capture time. */
  title: string;
  /** Where the snapshot came from: the agent, or the user's canvas edit. */
  source: 'agent' | 'user';
  /** Wall-clock capture time (ms). */
  created: number;
  /** ISO string kept for display. */
  createdAt: string;
  /** Which revision of the run node this text was read from. */
  nodeVersion: number;
  /** The node kind at capture time. */
  type: string;
  /** Full text of this version. */
  content: string;
}

/** A captured file beside the page (kept so the archive stays complete). */
export interface CanvasFileVersion extends CanvasVersion {
  /** Archive path the file would take. */
  name?: string;
}

/** The server's GET /nodes/:id/versions reply. */
export interface CanvasVersionList {
  nodeId: string;
  runId: string;
  type: string;
  /** Highest version number (0 when nothing was captured). */
  current: number;
  versions: CanvasVersion[];
  files: CanvasFileVersion[];
}

/** How one diff line is aligned. */
export type CanvasDiffOp = 'equal' | 'delete' | 'insert';

/** One line of an aligned pair, as the diff view colours it. */
export interface CanvasDiffLine {
  op: CanvasDiffOp;
  /** Line text without its trailing newline. */
  text: string;
  /** 1-based line number in the older version; null for an inserted line. */
  oldLine: number | null;
  /** 1-based line number in the newer version; null for a removed line. */
  newLine: number | null;
}

/** The server's GET /nodes/:id/diff reply. */
export interface CanvasDiff {
  nodeId: string;
  from: number;
  to: number;
  added: number;
  removed: number;
  unchanged: number;
  /** True when nothing changed. */
  empty: boolean;
  lines: CanvasDiffLine[];
}

/** One seed the node would produce, as the preview lists it. */
export interface CanvasSeedPreview {
  title: string;
  body: string;
  tags: string[];
}

/** The server's GET /nodes/:id/knowledge/preview reply. */
export interface CanvasKnowledgePreview {
  nodeId: string;
  baseName: string;
  count: number;
  seeds: CanvasSeedPreview[];
  warnings: string[];
}

/** Provenance recorded on every node-sourced seed. */
export interface CanvasSeedProvenance {
  source: string;
  ref?: string;
  runId?: string;
  split?: string;
  nodeType?: string;
  nodeVersion?: number;
}

/** One seed that was actually written by "Add to Knowledge Base". */
export interface CanvasIngestedSeed {
  id: string;
  title: string;
  body: string;
  tags: string[];
  provenance?: CanvasSeedProvenance;
}

/** The server's POST /nodes/:id/knowledge reply. */
export interface CanvasKnowledgeResult {
  ok: boolean;
  baseId: string;
  baseName: string;
  smartSplit: boolean;
  seeds: CanvasIngestedSeed[];
  warnings: string[];
}

/** The server's GET /nodes/:id/artifact reply. */
export interface CanvasArtifactInfo {
  nodeId: string;
  runId: string;
  /** Absolute directory the page lives in (server-side; never opened by the UI). */
  dir: string;
  /** Page to open first, relative to `dir`. */
  entry: string;
  /** True when the directory came from the node payload. */
  explicit: boolean;
  /** Preview tab URL the sheet opens. */
  url: string;
  /** ZIP download URL the sheet hands to the browser. */
  zipUrl: string;
}

/** The server's GET /nodes/:id/preview reply. */
export interface CanvasPreviewStart {
  url: string;
  root: string;
}

/** Coerce an unknown payload into one version; undefined when unusable. */
function coerceVersion(value: unknown): CanvasVersion | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.version !== 'number' || !Number.isFinite(raw.version)) return undefined;
  return {
    version: raw.version,
    title: typeof raw.title === 'string' ? raw.title : '',
    source: raw.source === 'user' ? 'user' : 'agent',
    created: typeof raw.created === 'number' && Number.isFinite(raw.created) ? raw.created : 0,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    nodeVersion: typeof raw.nodeVersion === 'number' && Number.isFinite(raw.nodeVersion) ? raw.nodeVersion : 1,
    type: typeof raw.type === 'string' ? raw.type : 'document',
    content: typeof raw.content === 'string' ? raw.content : '',
  };
}

/** Coerce an unknown payload into a version list; undefined when unusable. */
export function coerceCanvasVersionList(value: unknown): CanvasVersionList | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.nodeId !== 'string') return undefined;
  const versions = Array.isArray(raw.versions)
    ? raw.versions.map(coerceVersion).filter((v): v is CanvasVersion => v !== undefined)
    : [];
  const files = Array.isArray(raw.files)
    ? raw.files.map(coerceVersion).filter((v): v is CanvasVersion => v !== undefined)
    : [];
  return {
    nodeId: raw.nodeId,
    runId: typeof raw.runId === 'string' ? raw.runId : '',
    type: typeof raw.type === 'string' ? raw.type : 'document',
    current: typeof raw.current === 'number' && Number.isFinite(raw.current) ? raw.current : versions.length,
    versions,
    files,
  };
}

/** Coerce an unknown payload into a diff; undefined when unusable. */
export function coerceCanvasDiff(value: unknown): CanvasDiff | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.from !== 'number' || typeof raw.to !== 'number') return undefined;
  const lines: CanvasDiffLine[] = Array.isArray(raw.lines)
    ? raw.lines
        .map((line): CanvasDiffLine | undefined => {
          if (typeof line !== 'object' || line === null) return undefined;
          const l = line as Record<string, unknown>;
          const op = l.op === 'insert' || l.op === 'delete' ? l.op : 'equal';
          return {
            op,
            text: typeof l.text === 'string' ? l.text : '',
            oldLine: typeof l.oldLine === 'number' ? l.oldLine : null,
            newLine: typeof l.newLine === 'number' ? l.newLine : null,
          };
        })
        .filter((l): l is CanvasDiffLine => l !== undefined)
    : [];
  return {
    nodeId: typeof raw.nodeId === 'string' ? raw.nodeId : '',
    from: raw.from,
    to: raw.to,
    added: typeof raw.added === 'number' ? raw.added : 0,
    removed: typeof raw.removed === 'number' ? raw.removed : 0,
    unchanged: typeof raw.unchanged === 'number' ? raw.unchanged : 0,
    empty: raw.empty === true,
    lines,
  };
}

/** Coerce an unknown payload into a knowledge preview; undefined when unusable. */
export function coerceCanvasKnowledgePreview(value: unknown): CanvasKnowledgePreview | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.nodeId !== 'string') return undefined;
  const seeds = Array.isArray(raw.seeds)
    ? raw.seeds
        .map((seed) => {
          if (typeof seed !== 'object' || seed === null) return undefined;
          const s = seed as Record<string, unknown>;
          return {
            title: typeof s.title === 'string' ? s.title : '',
            body: typeof s.body === 'string' ? s.body : '',
            tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
          };
        })
        .filter((s): s is CanvasSeedPreview => s !== undefined)
    : [];
  return {
    nodeId: raw.nodeId,
    baseName: typeof raw.baseName === 'string' ? raw.baseName : '',
    count: typeof raw.count === 'number' ? raw.count : seeds.length,
    seeds,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
}
