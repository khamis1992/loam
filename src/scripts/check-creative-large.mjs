import {inspectTiming,inspectAudioSeams} from './creative-render-precision.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, _electron as electron } from 'playwright';
const desktop=process.argv.includes('--desktop');let desktopApp;
const root = process.cwd(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-large-')), workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace);
const probe = http.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(r => probe.close(() => r()));
const base = `http://127.0.0.1:${port}`;
const config = path.join(tmp, 'config.json');
fs.writeFileSync(config, JSON.stringify({ workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, 'shots') }, screen: { enabled: false }, memory: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {} }));
let child, browser, logs = '';
const poll = async (fn, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) {
    if (await fn())
        return;
    await new Promise(r => setTimeout(r, 200));
} throw Error('Timeout ' + logs.slice(-3000)); };
const serverRoot = (process.argv.includes('--installed')||desktop) ? path.join(process.env.LOCALAPPDATA, 'Programs/loam/resources/app') : root;
async function start() { if(desktop){const env={...process.env,LOAM_USER_DATA_DIR:tmp,LOAM_PORT:String(port),LOAM_MCP_BRIDGE_PORT:String(port+1),LOAM_DISABLE_BRIDGE:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.LOAM_CONFIG;delete env.MANUS_LOCAL_CONFIG;delete env.LOAM_DATA_DIR;delete env.MANUS_LOCAL_DATA_DIR;desktopApp=await electron.launch({executablePath:path.join(process.env.LOCALAPPDATA,'Programs/loam/Loam.exe'),env,timeout:90000});desktopApp.process().stdout?.on('data',d=>logs+=d);desktopApp.process().stderr?.on('data',d=>logs+=d);await poll(async()=>fetch(base+'/api/tasks').then(r=>r.ok).catch(()=>false),60000);return;} child = spawn(process.execPath, ['dist/server.cjs'], { cwd: serverRoot, windowsHide: true, env: { ...process.env, LOAM_ROOT: serverRoot, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, 'data'), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, 'skills'), MANUS_LOCAL_EVALS_DIR: path.join(tmp, 'evals') }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout?.on('data', d => logs += d); child.stderr?.on('data', d => logs += d); await poll(async () => fetch(base + '/api/tasks').then(r => r.ok).catch(() => false), 25000); }
async function stop() { if(desktopApp){await desktopApp.close();desktopApp=undefined;await poll(async()=>fetch(base+'/api/tasks').then(()=>false).catch(()=>true),15000);} if (child && child.exitCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGKILL');
    await done;
} }
const post = (route, value) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
try {
    await start();
    const { task } = await (await post('/api/tasks/draft', { mode: 'media' })).json();
    if(!desktop)browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
    let page = (desktop?await desktopApp.firstWindow():await browser.newPage({ viewport: { width: 1440, height: 1000 } }));
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/#/tasks/' + task.id);
    await page.locator('[data-timeline-open]').click();
    const idle = () => page.waitForFunction(() => !document.querySelector('.creative-timeline-editor fieldset').disabled);
    await idle();
    const wav = Buffer.alloc(44 + 48000 * 2 * 2 * 300);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(192000, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    for (let i = 0; i < 48000 * 13; i++) {
        const v = Math.round(Math.sin(i * 440 * 2 * Math.PI / 48000) * 4000);
        wav.writeInt16LE(v, 44 + i * 4);
        wav.writeInt16LE(v, 46 + i * 4);
    }
    const wavFile = path.join(tmp, 'large.wav');
    fs.writeFileSync(wavFile, wav);
    assert.ok(wav.length > 45 * 1024 * 1024);
    await page.locator('[data-tl-files]').setInputFiles(wavFile);
    await page.waitForFunction(() => { const button = document.querySelector('.creative-import-dialog [data-import-apply]'); return button && !button.disabled; }, undefined, { timeout: 300000 });
    await page.locator('.creative-import-dialog [data-import-apply]').click();
    await page.waitForFunction(() => !document.querySelector('.creative-import-dialog'), undefined, { timeout: 300000 });
    await idle();
    assert.equal(await page.locator('[data-clip]').count(), 1, await page.locator('[data-tl-status]').innerText());
    await page.locator('[data-clip-field=duration]').fill('12');
    await page.locator('[data-clip-field=duration]').press('Tab');
    await idle();
    const image = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const ctx = c.getContext('2d'); ctx.fillStyle = '#20dd70'; ctx.fillRect(0, 0, 640, 360); return c.toDataURL(); });
    await page.locator('[data-pick-track]').first().click();
    await page.locator('[data-tl-files]').setInputFiles({ name: 'green.png', mimeType: 'image/png', buffer: Buffer.from(image.split(',')[1], 'base64') });
    await page.waitForFunction(() => { const button = document.querySelector('.creative-import-dialog [data-import-apply]'); return button && !button.disabled; }, undefined, { timeout: 120000 });
    await page.locator('.creative-import-dialog [data-import-apply]').click();
    await page.waitForFunction(() => !document.querySelector('.creative-import-dialog'), undefined, { timeout: 120000 });
    await idle();
    await page.locator('[data-clip-field=duration]').fill('12');
    await page.locator('[data-clip-field=duration]').press('Tab');
    await idle();
    const saved = page.waitForResponse(r => r.url().includes('/api/timeline/project') && r.request().method() === 'POST');
    await page.locator('[data-tl-save]').click();
    const saveResponse = await saved;
    assert.equal(saveResponse.status(), 201, await saveResponse.text());
    const save = await saveResponse.json();
    await idle();
    const file = await (await fetch(`${base}/api/media?taskId=${task.id}&path=${save.path}`)).text(), project = JSON.parse(file);
    assert.ok(file.length < 10000);
    assert.equal(project.assets.length, 2);
    assert.ok(project.assets.every((a) => a.path && !a.data));
    const asset = project.assets[0];
    const range = await fetch(`${base}/api/media?taskId=${task.id}&path=${asset.path}`, { headers: { range: 'bytes=0-43' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 44);
    await page.locator('[data-tl-list]').click();
    await idle();
    await page.locator('[data-tl-saved]').selectOption(save.path);
    await idle();
    assert.equal(await page.locator('[data-clip]').count(), 2);
    await page.locator('[data-tl-project]').setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.from(file) });
    await idle();
    assert.equal(await page.locator('[data-clip]').count(), 2);
    await page.locator('[data-tl-export]').click();
    await idle();
    await page.locator('[data-job]').waitFor();
    const id = await page.locator('[data-job]').getAttribute('data-job');
    await page.locator('[data-tl-close]').click();
    assert.equal(await page.locator('.creative-timeline-editor').isVisible(), false);
    if(desktop)await page.goto(base);else await page.close();
    const jobs = async () => await (await fetch(`${base}/api/timeline/jobs?taskId=${task.id}`)).json();
    await poll(async () => { const j = (await jobs()).jobs[0]; if (j.state === 'failed')
        throw Error(j.message); return j.completed >= 1; });
    const before = (await jobs()).jobs[0];
    assert.ok(before.completed < 3, 'interruption before completion');
    const detail = await (await fetch(base + '/api/tasks/' + task.id)).json();
    const checkpoint = path.join(detail.task.workspace, '.timeline-jobs', id, '0.mp4'), mtime = fs.statSync(checkpoint).mtimeMs;
    await browser?.close();
    browser = undefined;
    await stop();
    await start();
    if(!desktop)browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
    page = (desktop?await desktopApp.firstWindow():await browser.newPage({ viewport: { width: 1440, height: 1000 } }));
    await page.goto(base + '/#/tasks/' + task.id);
    await page.locator('[data-timeline-open]').click();
    await idle();
    await page.locator('.tl-export-jobs summary').click();
    await page.locator('[data-job]').waitFor();
    assert.equal(await page.locator('[data-job]').getAttribute('data-job'), id);
    await poll(async () => { const j = (await jobs()).jobs[0]; if (j.state === 'failed')
        throw Error(j.message); return j.state === 'done'; });
    assert.equal(fs.statSync(checkpoint).mtimeMs, mtime, 'completed segment reused after restart');
    await page.locator('[data-job-download]').waitFor();
    let output;
    if(desktop){const target=path.join(tmp,'desktop-result.mp4');await desktopApp.evaluate(({session},target)=>{globalThis.loamTestDownload=null;session.defaultSession.once('will-download',(_event,item)=>{item.setSavePath(target);item.once('done',(_event,state)=>{globalThis.loamTestDownload=state;});});},target);await page.locator('[data-job-download]').click();await poll(async()=>{const state=await desktopApp.evaluate(()=>globalThis.loamTestDownload);if(state&&state!=='completed')throw Error('Desktop download '+state);return state==='completed';});output=fs.readFileSync(target);}
    else{const downloadPromise=page.waitForEvent('download');await page.locator('[data-job-download]').click();const downloaded=await downloadPromise;output=fs.readFileSync(await downloaded.path());}
    assert.equal(output.subarray(4, 8).toString(), 'ftyp');
    const result = await page.evaluate(async (encoded) => { const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' })), video = document.createElement('video'); video.src = url; await new Promise((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = reject; }); video.currentTime = 6; await new Promise(resolve => video.onseeked = () => resolve()); const c = document.createElement('canvas'); c.width = 1280; c.height = 720; c.getContext('2d').drawImage(video, 0, 0); const pixel = Array.from(c.getContext('2d').getImageData(100, 100, 1, 1).data), context = new AudioContext(); const audio = await context.decodeAudioData(bytes.buffer), samples = audio.getChannelData(0); let sum = 0; for (const value of samples)
        sum += value * value; await context.close(); URL.revokeObjectURL(url); return { duration: video.duration, pixel, rms: Math.sqrt(sum / samples.length) }; }, output.toString('base64'));
    assert.ok(Math.abs(result.duration - 12) < .3, JSON.stringify(result));
    assert.ok(result.pixel[1] > 180, JSON.stringify(result));
    assert.ok(result.rms > .03, JSON.stringify(result));
    fs.mkdirSync('output/verification', { recursive: true });
    fs.writeFileSync('output/verification/creative-large-resumed.mp4', output);const exactTiming=inspectTiming('output/verification/creative-large-resumed.mp4',30,360),audioSeams=inspectAudioSeams('output/verification/creative-large-resumed.mp4',12);assert.ok(Math.abs(result.duration-12)<.001,'exact container duration');assert.ok(Math.abs(result.pixel[1]-221)<=4,'BT.709 color roundtrip');
    await page.screenshot({ path: 'output/verification/creative-large-resumed.png' });
    fs.writeFileSync('output/verification/creative-large-report.json', JSON.stringify({ desktop, installed:serverRoot!==root, assetBytes: wav.length, manifestBytes: Buffer.byteLength(file), checkpointReused: true,exactTiming,audioSeams, completedBeforeRestart: before.completed, result, errors }, null, 2));
    assert.deepEqual(errors, []);
    console.log('PASS large project UI: 57.6 MB source, streamed assets, range seeking, compact manifest save/open/import, background export after closing editor/browser, server restart resumes checkpoints, UI result download with decoded MP4 video/audio', result);
}
finally {
    await browser?.close();
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
}
