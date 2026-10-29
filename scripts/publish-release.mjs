#!/usr/bin/env node
/** Phase-2 W1 (P0.2): publish a locally built, locally signed release to the
 *  GitHub update channel. CI (.github/workflows/release.yml) does the same on
 *  tag push; this script is the local path for builds signed with the cert on
 *  this machine (dist leaves latest.yml + Loam-Setup-<v>.exe(.blockmap) in
 *  release/). Requires the `gh` CLI, authenticated.
 *
 *  Usage: node scripts/publish-release.mjs [v1.2.3] [--dry-run] [--notes "…"]
 *  - tag defaults to v<package.json version>
 *  - refuses to publish when latest.yml version ≠ package.json version
 *  - creates the release when missing, then uploads with --clobber */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const notesIndex = args.indexOf('--notes');
const notes = notesIndex >= 0 ? (args[notesIndex + 1] ?? '') : '';
const explicitTag = args.find((a) => /^v\d/.test(a));
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = explicitTag ?? `v${pkg.version}`;
const releaseDir = path.join(root, 'release');

function gh(...cliArgs) {
  if (dryRun) { console.log('[dry-run] gh', cliArgs.join(' ')); return ''; }
  return execFileSync('gh', cliArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

const ymlPath = path.join(releaseDir, 'latest.yml');
if (!fs.existsSync(ymlPath)) {
  console.error(`لا يوجد ${ymlPath} — شغّل npm run dist أولًا.`);
  process.exit(1);
}
const yml = fs.readFileSync(ymlPath, 'utf8');
const feedVersion = (/^version:\s*(\S+)/m.exec(yml) ?? [])[1];
if (feedVersion !== pkg.version) {
  console.error(`عدم تطابق الإصدار: latest.yml يقول ${feedVersion} بينما package.json يقول ${pkg.version}.`);
  process.exit(1);
}
const artifacts = fs.readdirSync(releaseDir)
  .filter((name) => /^(latest\.yml|(?:Loam|manus-local)-Setup-[\d.]+\.exe(?:\.blockmap)?)$/.test(name))
  .map((name) => path.join(releaseDir, name));
if (artifacts.length < 3) {
  console.error(`المخرجات ناقصة في release/ (وجدت ${artifacts.length}: ${artifacts.map((p) => path.basename(p)).join(', ')}) — المتوقع latest.yml + exe + blockmap.`);
  process.exit(1);
}

const repo = gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner') || 'khamis1992/loam';
const existing = dryRun ? '' : (() => { try { return gh('release', 'view', tag, '--repo', repo, '--json', 'name', '-q', '.name'); } catch { return ''; } })();
if (!existing) gh('release', 'create', tag, '--title', tag, '--notes', notes || `إصدار ${tag} — قناة التحديث التلقائي (latest.yml + المثبّت + blockmap).`, '--repo', repo);
for (const artifact of artifacts) gh('release', 'upload', tag, artifact, '--clobber', '--repo', repo);
console.log(`${dryRun ? '[dry-run] ' : ''}نُشر ${tag} على ${repo}: ${artifacts.map((p) => path.basename(p)).join('، ')}`);
console.log(`رابط التغذية للتطبيقات المثبّتة: https://github.com/${repo}/releases/latest/download/`);
