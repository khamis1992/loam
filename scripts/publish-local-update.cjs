// Copy the freshly built NSIS installer into the desktop app's local update
// channel (%APPDATA%\Loam\updates, or the legacy manus-local folder).
// The running app serves that folder and the sidebar "Check for updates"
// button installs it. A newer package.json version is required; the same
// version is treated as already installed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const releaseDir = path.join(__dirname, '..', 'release');
const latestYml = path.join(releaseDir, 'latest.yml');

function userDataDir() {
  if (process.env.LOAM_USER_DATA_DIR) return path.resolve(process.env.LOAM_USER_DATA_DIR);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const legacy = path.join(appData, 'manus-local');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(appData, 'Loam');
}

function artifactNames(yaml) {
  const names = new Set(['latest.yml']);
  for (const match of yaml.matchAll(/^\s*(?:path|url):\s*['"]?([^'"\s]+)['"]?\s*$/gm)) {
    const name = path.basename(match[1]);
    if (!name || name === '.' || name === '..') continue;
    names.add(name);
    names.add(`${name}.blockmap`);
  }
  return names;
}

function main() {
  if (!fs.existsSync(latestYml)) {
    console.error('[publish-local-update] release/latest.yml is missing. The installer build did not finish.');
    process.exit(1);
  }
  const yaml = fs.readFileSync(latestYml, 'utf8');
  const names = artifactNames(yaml);
  const dest = path.join(userDataDir(), 'updates');
  fs.mkdirSync(dest, { recursive: true });

  const copied = [];
  for (const name of names) {
    const from = path.join(releaseDir, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dest, name));
    copied.push(name);
  }
  if (!copied.includes('latest.yml')) {
    console.error('[publish-local-update] failed to copy latest.yml');
    process.exit(1);
  }

  for (const existing of fs.readdirSync(dest)) {
    if (copied.includes(existing)) continue;
    if (/^(?:Loam|manus-local)-Setup-.+\.exe(?:\.blockmap)?$/.test(existing)) {
      fs.rmSync(path.join(dest, existing), { force: true });
    }
  }

  const version = (yaml.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m) || [])[1] || 'unknown';
  console.log(`[publish-local-update] version ${version} is ready in ${dest}`);
  console.log('[publish-local-update] Open Loam and use Check for updates. The version number must be higher than the installed one.');
}

main();
