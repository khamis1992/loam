import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rootAsset } from '../../config.js';
import { BuildMenuError } from '../grants.js';
import { findElectron } from '../toolchain.js';

const TEMPLATE_ROOT = rootAsset('src', 'templates', 'electron-app');

export const FROZEN_ELECTRON_FILES = [
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/notes-preload.cjs',
  'electron/notes.cjs',
  'electron/widget-geometry.cjs',
  'electron/navigation.cjs',
  'electron/userData.cjs',
  'package.json',
] as const;

export function assertFrozenElectronTemplate(workspace: string): void {
  for (const relative of FROZEN_ELECTRON_FILES) {
    const expectedPath = path.join(TEMPLATE_ROOT, ...relative.split('/'));
    const actualPath = path.join(workspace, 'app', ...relative.split('/'));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(actualPath);
    } catch {
      throw new BuildMenuError('invalid_request', 400);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new BuildMenuError('unsafe_path', 400);
    const expected = createHash('sha256').update(fs.readFileSync(expectedPath)).digest('hex');
    const actual = createHash('sha256').update(fs.readFileSync(actualPath)).digest('hex');
    if (expected !== actual) throw new BuildMenuError('invalid_request', 400);
  }
}

export function desktopPreviewLaunch(workspace: string, executable: string): { executable: string; script: string; cwd: string } {
  assertFrozenElectronTemplate(workspace);
  const allowed = findElectron();
  if (!allowed) throw new BuildMenuError('missing_requirement', 400);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(allowed);
  } catch {
    throw new BuildMenuError('missing_requirement', 400);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BuildMenuError('unsafe_path', 400);
  if (path.resolve(executable) !== path.resolve(allowed)) throw new BuildMenuError('invalid_request', 400);
  const cwd = path.resolve(workspace, 'app');
  const script = path.resolve(cwd, 'electron', 'main.cjs');
  const relative = path.relative(cwd, script);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new BuildMenuError('unsafe_path', 400);
  return { executable: path.resolve(allowed), script, cwd };
}
