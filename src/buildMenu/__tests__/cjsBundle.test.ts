import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('build menu modules evaluate in the CommonJS server bundle format', async () => {
  const result = await build({
    stdin: {
      contents: [
        "import './src/buildMenu/websites/templateLock.ts';",
        "import './src/buildMenu/desktop/templateLock.ts';",
        "import './src/buildMenu/notebooks/kernel.ts';",
        "import './src/buildMenu/notebooks/view.ts';",
        "import './src/buildMenu/mobile/simulation.ts';",
        "import './src/buildMenu/kindRuntime.ts';",
        "import './src/buildMenu/widget/running.ts';",
        "import './src/server/routes/buildMenu.ts';",
        'process.exit(0);',
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'build-menu-cjs-smoke.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    external: [
      'esbuild',
      'playwright',
      'node-pty',
      '@modelcontextprotocol/sdk',
      'sharp',
      '@nut-tree-fork/nut-js',
      '@napi-rs/canvas',
      'pdfjs-dist',
      'tesseract.js',
      'tesseract.js-core',
      '@myriaddreamin/typst-ts-node-compiler',
      '@myriaddreamin/typst-ts-node-compiler-win32-x64-msvc',
    ],
  });
  const output = result.outputFiles?.[0]?.text;
  assert.ok(output);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-cjs-bundle-'));
  const bundle = path.join(tempDir, 'bundle.cjs');
  try {
    fs.writeFileSync(bundle, output);
    const child = spawnSync(process.execPath, [bundle], {
      cwd: ROOT,
      env: { ...process.env, LOAM_ROOT: ROOT, MANUS_LOCAL_ROOT: ROOT },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
