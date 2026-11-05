// Loam Recorder R0 grep gates (EMBED_PLAN section 6). Pure helpers + a CLI.
// Fails when telemetry, self-update, in-app LLM, MCP/CLI or model-download
// code comes back into the vendored tree or the built renderer dist.
//   node scripts/vendor/recorder/gates.mjs <upstreamRoot> [distDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NETWORK_GATES = [
  { id: 'posthog', re: /posthog|phc_[A-Za-z0-9]{8,}/i },
  { id: 'llm-endpoint', re: /api\.anthropic\.com|api\.openai\.com|api\.mistral\.ai|api\.minimax|generativelanguage\.googleapis\.com/i },
  { id: 'huggingface', re: /huggingface\.co\//i },
];

export const FORBIDDEN_DEPS = [
  /^@langchain\//, /^langchain$/, /^@modelcontextprotocol\//, /^electron-updater$/, /^posthog/,
];

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.map']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.vite-cache']);

export function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (TEXT_EXT.has(path.extname(ent.name))) yield p;
  }
}

/** Shipped-code scan: tests are excluded (they never ship). */
export function scanFiles(files, gates = NETWORK_GATES) {
  const hits = [];
  for (const f of files) {
    if (/\.test\.(ts|tsx|mjs|js)$/.test(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const g of gates) {
      const m = text.match(g.re);
      if (m) hits.push({ gate: g.id, file: f, match: m[0] });
    }
  }
  return hits;
}

export function forbiddenDeps(pkg) {
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  return Object.keys(all).filter((d) => FORBIDDEN_DEPS.some((re) => re.test(d)));
}

export function forbiddenLockEntries(lock) {
  return Object.keys(lock.packages || {})
    .map((k) => k.replace(/^.*node_modules\//, ''))
    .filter((d) => d && FORBIDDEN_DEPS.some((re) => re.test(d)));
}

export function removedPathsPresent(root, deletePaths) {
  return deletePaths.filter((p) => fs.existsSync(path.join(root, p)));
}

export function runGates({ root, distDir, deletePaths = [] }) {
  const failures = [];
  for (const p of removedPathsPresent(root, deletePaths)) failures.push(`removed path is back: ${p}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const d of forbiddenDeps(pkg)) failures.push(`forbidden dependency: ${d}`);
  const lockFile = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    for (const d of new Set(forbiddenLockEntries(lock))) failures.push(`forbidden lockfile package: ${d}`);
  }
  const srcFiles = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'electron'))];
  for (const h of scanFiles(srcFiles)) failures.push(`${h.gate}: ${path.relative(root, h.file)} (${h.match})`);
  if (distDir) {
    if (!fs.existsSync(path.join(distDir, 'index.html'))) failures.push('dist has no index.html');
    for (const h of scanFiles([...walk(distDir)])) failures.push(`${h.gate} in dist: ${path.relative(distDir, h.file)} (${h.match})`);
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [root, distDir] = process.argv.slice(2);
  if (!root) { console.error('usage: gates.mjs <upstreamRoot> [distDir]'); process.exit(2); }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { deletePaths } = JSON.parse(fs.readFileSync(path.join(here, 'removals.json'), 'utf8'));
  const failures = runGates({ root, distDir, deletePaths });
  if (failures.length) { console.error(`recorder gates FAILED (${failures.length}):\n- ${failures.join('\n- ')}`); process.exit(1); }
  console.log('recorder gates passed');
}
