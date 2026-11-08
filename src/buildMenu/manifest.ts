import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BuildManifest } from '../../packages/shared/src/buildMenu.js';
import { BuildMenuError } from './grants.js';

export const selectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('website'), subtype: z.enum(['landing', 'store', 'booking', 'chatbot']) }),
  z.object({ kind: z.enum(['desktop', 'widget', 'automation', 'notebook', 'mobile', 'chrome-extension', 'safari-extension', 'game']) }),
]);

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(/^app_[a-z2-7]{12}$/),
  revision: z.number().int().positive(),
  selection: selectionSchema,
  title: z.string().trim().min(1).max(80),
  sourceDir: z.literal('app'),
  template: z.object({
    id: z.string().min(1).max(80),
    revision: z.string().min(1).max(40).refine((value) => value.toLowerCase() !== 'latest'),
    lockSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  consent: z.object({
    autostart: z.union([z.literal(false), z.object({ approvedAt: z.string().min(1).max(40) }).strict()]),
    publish: z.literal(false),
  }).strict(),
}).strict();

const locks = new Map<string, Promise<unknown>>();
let revisionGuard: ((workspace: string) => boolean) | null = null;

export function configureRevisionGuard(guard: (workspace: string) => boolean): void {
  revisionGuard = guard;
}

function manifestPath(workspace: string): string {
  return path.join(workspace, '.loam', 'build-menu', 'manifest.json');
}

function assertContained(workspace: string): string {
  const root = path.resolve(workspace);
  const target = manifestPath(root);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_path');
  let cursor = root;
  for (const part of ['.loam', 'build-menu', 'manifest.json']) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) continue;
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('unsafe_path');
  }
  return target;
}

function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  locks.set(key, result.then(() => undefined, () => undefined));
  return result;
}

function assertManifestNotHardLinked(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT') return;
    throw error;
  }
  if (stat.nlink > 1) throw new Error('unsafe_path');
}

function workspaceIsStopping(workspace: string): boolean {
  const file = path.join(path.resolve(workspace), '.loam', 'build-menu', 'active-job.json');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) throw new Error('unsafe_path');
  if (!stat.isFile()) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { phase?: unknown };
    return parsed.phase === 'stopping';
  } catch {
    return false;
  }
}

export function readManifest(workspace: string): BuildManifest | null {
  const target = assertContained(workspace);
  if (!fs.existsSync(target)) return null;
  assertManifestNotHardLinked(target);
  const parsed = manifestSchema.safeParse(JSON.parse(fs.readFileSync(target, 'utf8')));
  if (!parsed.success) throw new Error('invalid_request');
  return parsed.data as BuildManifest;
}

export async function saveManifest(workspace: string, next: BuildManifest, expectedRevision: number): Promise<BuildManifest> {
  const parsed = manifestSchema.safeParse(next);
  if (!parsed.success) throw new Error('invalid_request');
  const manifest = parsed.data as BuildManifest;
  return withLock(path.resolve(workspace), async () => {
    const target = assertContained(workspace);
    const current = fs.existsSync(target) ? readManifest(workspace) : null;
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision || manifest.revision !== expectedRevision + 1) throw new Error('stale_revision');
    if (workspaceIsStopping(workspace) || revisionGuard?.(workspace)) throw new BuildMenuError('busy', 409);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assertManifestNotHardLinked(target);
    if (current) {
      const backup = path.join(path.dirname(target), `manifest.${current.revision}.bak.json`);
      assertManifestNotHardLinked(backup);
      fs.copyFileSync(target, backup);
    }
    const temp = path.join(path.dirname(target), `manifest.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
    assertManifestNotHardLinked(target);
    fs.renameSync(temp, target);
    return manifest;
  });
}
