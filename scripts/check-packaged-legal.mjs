import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron, chromium } from 'playwright';
import { createElectronTestExecutable } from './lib/electronTestExecutable.mjs';

const testExecutable = await createElectronTestExecutable(path.resolve(process.argv[2] || 'release/win-unpacked/Loam.exe'));
const executable = testExecutable.executablePath;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'loam-legal-packaged-'));
const configPath = path.join(profile, 'config.json');
await fs.writeFile(configPath, JSON.stringify({
  legal: { enabled: true },
  workspace: path.join(profile, 'workspace'),
  memory: { file: path.join(profile, 'data', 'memory.json') },
  computerUse: { screenshotDir: path.join(profile, 'workspace', '.screenshots') },
}));
const port = 13949;
const env = { ...process.env, LOAM_USER_DATA_DIR: profile, LOAM_CONFIG: configPath, LOAM_PORT: String(port), LOAM_MCP_BRIDGE_PORT: '13013' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MANUS_LOCAL_CONFIG;
delete env.LOAM_DATA_DIR;
delete env.MANUS_LOCAL_DATA_DIR;
let app;
let browser;
let win;
let diagnostics = '';
try {
  browser = await chromium.launch({ headless: true });
  const imagePage = await browser.newPage({ viewport: { width: 1000, height: 250 } });
  await imagePage.setContent('<html><body style="background:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:Arial;font-size:72px">هذا عقد قانوني</body></html>');
  const image = await imagePage.screenshot({ type: 'png' });
  await browser.close();
  browser = undefined;

  app = await electron.launch({ executablePath: executable, env, timeout: 90000 });
  app.process().stdout?.on('data', (chunk) => { diagnostics += chunk.toString(); });
  app.process().stderr?.on('data', (chunk) => { diagnostics += chunk.toString(); });
  const deadline = Date.now() + 90000;
  while (!win) {
    win = app.windows().find((candidate) => candidate.url().startsWith('app://agent/') || candidate.url().startsWith(`http://127.0.0.1:${port}/`));
    if (Date.now() > deadline) throw new Error('Main Loam window not found');
    if (!win) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  win.on('pageerror', (error) => console.error('Legal UI error:', error.message));
  win.on('console', (message) => { if (message.type() === 'error') console.error('Legal browser:', message.text()); });
  win.on('requestfailed', (request) => console.error('Legal request failed:', request.url(), request.failure()?.errorText));
  win.on('response', (response) => { if (response.status() >= 400 && response.url().includes('/api/legal')) void response.text().then((body) => console.error('Legal API error:', response.status(), response.url(), body)); });
  await win.goto('app://agent/legal');
  await win.getByText('Local encrypted processing', { exact: true }).waitFor({ timeout: 30000 });
  await win.getByPlaceholder('Matter title').fill('Packaged OCR synthetic matter');
  await win.getByRole('button', { name: 'New matter' }).click();
  await win.getByRole('link', { name: /Packaged OCR synthetic matter/ }).click();
  const uploadResponse = win.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/documents'));
  await win.locator('input[type=file]').first().setInputFiles({ name: 'arabic-contract.png', mimeType: 'image/png', buffer: image });
  assert.equal((await uploadResponse).status(), 201);
  await win.getByRole('tab', { name: 'evidence', exact: true }).click();
  await win.getByText('arabic-contract.png', { exact: true }).first().waitFor({ timeout: 90000 });
  await win.getByRole('tab', { name: 'document', exact: true }).click();
  await win.getByText(/هذا عقد قانوني/).first().waitFor({ timeout: 90000 });
  await win.screenshot({ path: path.resolve('release/loam-legal-packaged.png'), fullPage: true });
  console.log('PASS packaged Legal: enabled route, DPAPI key handoff, encrypted matter creation, Arabic UI evidence, local Arabic OCR.');
} catch (error) {
  if (win) {
    console.error(await win.locator('body').innerText());
    await win.screenshot({ path: path.resolve('release/loam-legal-error.png'), fullPage: true });
  }
  console.error(diagnostics.slice(-7000));
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  await testExecutable.cleanup();
  await fs.rm(profile, { recursive: true, force: true });
}
