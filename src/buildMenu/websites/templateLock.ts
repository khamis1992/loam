import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildMenuError } from '../grants.js';

const TEMPLATE_ROOT = fileURLToPath(new URL('../../../templates/web-app/', import.meta.url));

export const FROZEN_WEBSITE_FILES = ['package.json', 'vite.config.ts'] as const;

export function assertFrozenWebsiteTemplate(workspace: string): void {
  for (const relative of FROZEN_WEBSITE_FILES) {
    const expectedPath = path.join(TEMPLATE_ROOT, relative);
    const actualPath = path.join(workspace, 'app', relative);
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
