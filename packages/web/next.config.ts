import fs from 'node:fs';
import path from 'node:path';

import type { NextConfig } from 'next';

function computeRoot(): string {
  const here = path.resolve(__dirname);
  try {
    const real = fs.realpathSync(path.join(here, 'node_modules', 'next'));
    const hereParts = here.split(path.sep);
    const realParts = real.split(path.sep);
    const common: string[] = [];
    const limit = Math.min(hereParts.length, realParts.length);
    for (let i = 0; i < limit; i++) {
      if (hereParts[i].toLowerCase() === realParts[i].toLowerCase()) {
        common.push(hereParts[i]);
      } else {
        break;
      }
    }
    let result = common.join(path.sep);
    if (/^[a-zA-Z]:$/.test(result)) {
      result += path.sep;
    }
    // The root must contain ../shared (aliased as @shared/*), so never go deeper than the monorepo root.
    const repoRoot = path.resolve(here, '..', '..');
    if (!result || repoRoot.toLowerCase().startsWith(result.toLowerCase())) return result || repoRoot;
    return repoRoot;
  } catch {
    return here;
  }
}

const nextConfig: NextConfig = {
  output: 'export',
  distDir: 'out',
  images: { unoptimized: true },
  turbopack: {
    root: computeRoot(),
  },
};

export default nextConfig;
