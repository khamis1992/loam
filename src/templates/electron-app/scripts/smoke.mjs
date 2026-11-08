import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const rootRequire = createRequire(path.join(process.env.LOAM_ROOT ?? process.cwd(), 'package.json'));
const { chromium } = rootRequire('playwright');
const electronPath = process.env.LOAM_ELECTRON_BINARY || rootRequire('electron');
const debugPort = Number(process.env.LOAM_ACCEPTANCE_DEBUG_PORT ?? 19222);
const configPath = path.join(process.cwd(), 'desktop-app.json');
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : { scenario: 'file-organizer', title: 'Loam File Organizer' };
const { default: accept } = await import(`./acceptance/${config.scenario}.mjs`);
const env = { ...process.env, LOAM_USER_DATA_DIR: path.join(process.cwd(), '.loam/runtime') };
delete env.ELECTRON_RUN_AS_NODE;

const application = spawn(electronPath, [`--remote-debugging-port=${debugPort}`, '.'], {
  cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
});
let diagnostics = '';
application.stdout.on('data', (chunk) => { diagnostics += chunk.toString(); });
application.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPage() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (application.exitCode !== null) throw new Error(`Electron exited before opening a window.\n${diagnostics}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        if (pages.some((page) => page.type === 'page' && page.url.startsWith('file://'))) return;
      }
    } catch {
      // DevTools is not listening yet.
    }
    await delay(150);
  }
  throw new Error(`Electron did not expose its app window.\n${diagnostics}`);
}

async function stopApplication() {
  if (application.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(application.pid), '/T', '/F'], { windowsHide: true });
    await new Promise((resolve) => killer.once('close', resolve));
  } else application.kill('SIGTERM');
}

let browser;
try {
  await waitForPage();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file://'));
  if (!page) throw new Error('Electron file window was not found');
  const result = await accept(page);
  const screenshotDir = path.join(process.cwd(), '..', '.loam', 'verify');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshot = `.loam/verify/electron-smoke-${config.scenario}.png`;
  await page.screenshot({ path: path.join(process.cwd(), '..', screenshot), fullPage: true });
  if (config.scenario === 'password-manager') {
    const vault = fs.readFileSync(path.join(process.cwd(), 'fixtures/vault/.loam-vault.json'), 'utf8');
    if (vault.includes('not-a-real-password-123')) throw new Error('Vault contains a plaintext secret');
  }
  if (config.scenario === 'photo-sorter' && fs.readdirSync(path.join(process.cwd(), 'fixtures/photos/sorted')).length !== 3) throw new Error('Photo sort output is incomplete');
  console.log(JSON.stringify({ title: await page.title(), scenario: config.scenario, ...result, screenshot }));
} finally {
  await browser?.close();
  await stopApplication();
}
