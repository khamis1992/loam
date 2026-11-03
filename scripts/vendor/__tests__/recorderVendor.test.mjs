// Unit tests for the Loam Recorder R0 vendor pipeline (scripts/vendor/recorder).
// No network, no npm: pure helpers + a synthetic upstream tree.
//   node --test scripts/vendor/__tests__/recorderVendor.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { auditSeverities, parseArgs, pruneLock, rewritePackageJson } from '../recorder/build-recorder.mjs';
import { forbiddenDeps, forbiddenLockEntries, runGates } from '../recorder/gates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, '../recorder/manifest.json'), 'utf8'));
const removals = JSON.parse(fs.readFileSync(path.join(here, '../recorder/removals.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-vendor-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function tree(files) {
  const root = fs.mkdtempSync(path.join(tmp, 't-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

describe('manifest pin', () => {
  it('pins khamis1992/openscreen at 8ecc76b with the Loam Recorder name', () => {
    assert.equal(manifest.rev, '8ecc76b7735efcc17866929cdc05a7d877b17008');
    assert.equal(manifest.short, '8ecc76b');
    assert.equal(manifest.repo, 'https://github.com/khamis1992/openscreen');
    assert.equal(manifest.name, 'Loam Recorder');
  });
});

describe('removals', () => {
  it('cover telemetry, self-update, LLM, MCP/CLI, star prompt and model download', () => {
    for (const p of ['electron/usage-ping.ts', 'electron/auto-updater.ts', 'electron/background-update.ts',
      'electron/update-checker.ts', 'electron/install-channel.ts', 'electron/star-prompt.ts',
      'electron/ai-edition', 'electron/mcp', 'electron/cli', 'electron/stt/modelManager.ts']) {
      assert.ok(removals.deletePaths.includes(p), p);
    }
  });

  it('rewritePackageJson drops forbidden deps and install hooks, bumps tiptap, keeps others', () => {
    const pkg = {
      name: 'openscreen',
      scripts: { prepare: 'husky', build: 'x' },
      dependencies: { langchain: '1', '@langchain/core': '1', '@modelcontextprotocol/sdk': '1', 'electron-updater': '6', react: '18', zod: '^4.1.12', '@tiptap/react': '^3.27.1' },
      devDependencies: { husky: '9', vite: '7' },
      build: { appId: 'x' },
    };
    const out = rewritePackageJson(pkg, removals);
    assert.deepEqual(forbiddenDeps(out), []);
    assert.equal(out.scripts.prepare, undefined);
    assert.equal(out.scripts.build, 'x');
    assert.equal(out.dependencies.react, '18');
    assert.equal(out.dependencies.zod, '^4.6.7');
    assert.equal(out.dependencies['@tiptap/react'], '^3.32.2');
    assert.equal(out.devDependencies.husky, undefined);
    assert.equal(out.overrides['prosemirror-view'], '^1.42.9');
    assert.equal(out.build, undefined);
    assert.equal(pkg.dependencies.langchain, '1', 'input not mutated');
  });

  it('pruneLock removes bumped packages at any depth', () => {
    const lock = { packages: { '': {}, 'node_modules/@tiptap/core': {}, 'node_modules/a/node_modules/nanoid': {}, 'node_modules/react': {} } };
    assert.deepEqual(Object.keys(pruneLock(lock, removals.lockPrune).packages), ['', 'node_modules/react']);
  });
});

describe('gates', () => {
  const clean = { 'package.json': JSON.stringify({ dependencies: { react: '18' } }), 'src/a.ts': 'export const x = 1;', 'dist/index.html': '<html></html>' };

  it('pass on a clean tree', () => {
    const root = tree(clean);
    assert.deepEqual(runGates({ root, distDir: path.join(root, 'dist'), deletePaths: removals.deletePaths }), []);
  });

  it('fail on telemetry, LLM endpoints and huggingface downloads in shipped code and dist', () => {
    const root = tree({ ...clean,
      'src/t.ts': 'fetch("https://us.i.posthog.com/capture")',
      'electron/l.ts': 'const u = "https://api.openai.com/v1"',
      'dist/assets/x.js': 'fetch("https://huggingface.co/m")' });
    const f = runGates({ root, distDir: path.join(root, 'dist'), deletePaths: [] }).join('\n');
    assert.match(f, /posthog: src\/t\.ts/);
    assert.match(f, /llm-endpoint: electron\/l\.ts/);
    assert.match(f, /huggingface in dist/);
  });

  it('ignore test files (never shipped)', () => {
    const root = tree({ ...clean, 'src/t.test.ts': 'posthog' });
    assert.deepEqual(runGates({ root, deletePaths: [] }), []);
  });

  it('fail when a removed path or forbidden dependency comes back', () => {
    const root = tree({ ...clean, 'electron/usage-ping.ts': '', 'package-lock.json': JSON.stringify({ packages: { 'node_modules/@langchain/core': {} } }) });
    const f = runGates({ root, deletePaths: removals.deletePaths }).join('\n');
    assert.match(f, /removed path is back: electron\/usage-ping\.ts/);
    assert.match(f, /forbidden lockfile package: @langchain\/core/);
    assert.deepEqual(forbiddenLockEntries({ packages: { 'node_modules/electron-updater': {} } }), ['electron-updater']);
  });

  it('fail when dist has no index.html', () => {
    const root = tree({ 'package.json': '{}', 'dist/x.js': '' });
    assert.match(runGates({ root, distDir: path.join(root, 'dist') }).join(), /no index\.html/);
  });
});

describe('cli + audit helpers', () => {
  it('parseArgs', () => {
    const a = parseArgs(['--src', 's', '--work', 'w', '--skip-native', '--write-manifest']);
    assert.equal(a.src, 's'); assert.equal(a.work, 'w'); assert.equal(a.skipNative, true); assert.equal(a.writeManifest, true);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  });
  it('auditSeverities reads npm audit metadata', () => {
    assert.deepEqual(auditSeverities({ metadata: { vulnerabilities: { high: 2, critical: 1, total: 3 } } }), { critical: 1, high: 2, moderate: 0, low: 0, total: 3 });
    assert.deepEqual(auditSeverities({}), { critical: 0, high: 0, moderate: 0, low: 0, total: 0 });
  });
});
