import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chromium, type Browser } from "playwright";
import { checkCreativeMedia } from './creative-media-checks.mjs';
import { checkCreativeTimeline } from './creative-timeline-checks.mjs';
import { checkAssetModel, checkCreativeAssets } from './creative-assets-ui.mjs';
import { checkAssetLibraryUI } from './creative-asset-library-ui.mjs';
import { checkEditingToolsModel, checkEditingToolsUI } from './creative-editing-v2-ui.mjs';
import { checkAssetOperationsUI } from './creative-assets-ops-ui.mjs';
import { checkAudioModel, checkAudioUI } from './creative-audio-ui.mjs';
import { checkAudioAdvancedModel, checkAudioAdvancedUI } from './creative-audio2-ui.mjs';
import { checkFxModel, checkFxUI } from './creative-fx-checks.mjs';
import { checkBlendModel, checkBlendUI } from './creative-blend-checks.mjs';
import { checkLutModel, checkLutUI } from './creative-lut-checks.mjs';
import { checkIdentityModel, checkIdentityUI } from './creative-identity-checks.mjs';

const root = process.cwd();
const installed = process.argv.includes('--installed');
const serverRoot = installed ? path.join(process.env.LOCALAPPDATA!, 'Programs', 'loam', 'resources', 'app') : root;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-creative-http-"));
const workspace = path.join(tmp, "workspace"); fs.mkdirSync(workspace);
const scene = {
  version: 1, title: "Live product scene", nodes: [{ id: "product", name: "Product", type: "box", position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: { color: "#7755ff", metalness: .5, roughness: .3 }, visible: true, spin: .5 }],
  environment: { background: "#101020", lightIntensity: 3, exposure: 1, grid: true }, camera: { position: [4, 3, 5], target: [0, 1, 0], fov: 45 }, duration: 8,
};
let nativeCalls = 0;
const model = http.createServer(async (req, res) => {
  if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "test-model" }] })); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0]?.content ?? "";
  let content = "", tool_calls: unknown[] = [];
  if (system.includes("planner role")) content = JSON.stringify({ goal: "Create a live 3D scene", trivial: false, steps: [{ id: "create", title: "Create scene", instruction: "Use loam_creative to save a product scene", success_criteria: "creative.json exists" }] });
  else if (system.includes("ONE executed plan step")) content = JSON.stringify({ verdict: "pass", reason: "Scene saved in task workspace" });
  else if (system.includes("COMPLETED task as a whole")) { if (body.tools?.length && messages.at(-1)?.role !== "tool") tool_calls = [{ function: { name: "file_list", arguments: {} } }]; else content = JSON.stringify({ verdict: "pass", reason: "Scene saved in task workspace" }); }
  else if (messages.at(-1)?.role === "tool") content = "Created the live 3D scene.";
  else { nativeCalls++; tool_calls = [{ function: { name: "loam_creative", arguments: { action: "replace", expectedRevision: 0, scene } } }]; }
  res.setHeader("content-type", "application/x-ndjson");
  res.end(JSON.stringify({ model: "test-model", message: { role: "assistant", content, tool_calls }, done: true }) + "\n");
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const modelPort = (model.address() as import("node:net").AddressInfo).port;
const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = (probe.address() as import("node:net").AddressInfo).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const base = `http://127.0.0.1:${port}`, config = path.join(tmp, "config.json");
fs.writeFileSync(config, JSON.stringify({ model: "test-model", fallbackModel: "test-model", ollamaUrl: `http://127.0.0.1:${modelPort}`, workspace, computerUse: { enabled: false, screenshotDir: path.join(tmp, "screenshots") }, memory: { enabled: false }, screen: { enabled: false }, selfImprove: { enabled: false }, mcpServers: {} }));
let child: ChildProcess | undefined, browser: Browser | undefined, logs = "";
const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out\n${logs.slice(-4000)}`);
};
const start = async (): Promise<void> => {
  logs = "";
  child = spawn(process.execPath, installed || process.argv.includes("--bundle") ? ["dist/server.cjs"] : ["--import", "tsx", "src/index.ts"], { cwd: serverRoot, windowsHide: true, env: { ...process.env, MANUS_LOCAL_CONFIG: config, MANUS_LOCAL_DATA_DIR: path.join(tmp, "data"), MANUS_LOCAL_PORT: String(port), MANUS_LOCAL_EVALS_DIR: path.join(tmp, "evals"), MANUS_LOCAL_SKILLS_DIR: path.join(tmp, "skills") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", chunk => { logs += chunk; }); child.stderr?.on("data", chunk => { logs += chunk; });
  await waitFor(async () => { if (child?.exitCode != null) throw new Error(logs); return fetch(base + "/api/tasks").then(r => r.ok).catch(() => false); });
};
const stop = async (): Promise<void> => { if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; } };
const post = (url: string, body: unknown) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async (taskId: string) => await (await fetch(`${base}/api/creative?taskId=${taskId}`)).json() as { scene: typeof scene & { revision: number } | null };
function glb(json: object): Uint8Array<ArrayBuffer> {
  const raw = JSON.stringify(json), data = Buffer.from(raw + " ".repeat((4 - Buffer.byteLength(raw) % 4) % 4));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + data.length, 8); header.writeUInt32LE(data.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([header, data]));
}
try {
  await start();
  const draft = async (mode: string): Promise<{ id: string }> => ((await (await post("/api/tasks/draft", { mode })).json()) as { task: { id: string } }).task;
  const first = await draft("media"), second = await draft("media"), denied = await draft("ask");
  assert.equal((await fetch(base + "/api/creative")).status, 400);
  assert.equal((await read(first.id)).scene, null);
  const chat = await post("/api/chat", { taskId: first.id, mode: "media", prompt: "Create a live product scene using loam_creative", attachments: [] });
  assert.equal(chat.status, 200); await chat.text();
  await waitFor(async () => ((await (await fetch(`${base}/api/tasks/${first.id}`)).json()) as { task: { status: string } }).task.status === "done");
  assert.equal(nativeCalls, 1); assert.equal((await read(first.id)).scene?.nodes[0]?.name, "Product");
  assert.equal((await post("/api/creative", { taskId: first.id, scene: { ...scene, title: "Manual edit" }, expectedRevision: 1 })).status, 200);
  const conflict = await post("/api/creative", { taskId: first.id, scene, expectedRevision: 1 });
  assert.equal(conflict.status, 409); assert.equal(((await conflict.json()) as { scene: { revision: number } }).scene.revision, 2);
  assert.equal((await post("/api/creative", { taskId: denied.id, scene, expectedRevision: 0 })).status, 403);
  assert.equal((await fetch(`${base}/api/creative?taskId=${denied.id}`)).status, 403);
  assert.equal((await read(second.id)).scene, null);
  const good = glb({ asset: { version: "2.0" }, scenes: [{ nodes: [] }], scene: 0 });
  const upload = await fetch(`${base}/api/creative/asset?taskId=${first.id}`, { method: "POST", body: good });
  assert.equal(upload.status, 201);
  const asset = (await upload.json()) as { path: string; bytes: number };
  assert.equal(asset.bytes, good.byteLength); assert.match(asset.path, /^assets\/creative\/[\da-f-]+\.glb$/);
  const media = await fetch(`${base}/api/media?taskId=${first.id}&path=${encodeURIComponent(asset.path)}`);
  assert.equal(media.status, 200); assert.deepEqual(new Uint8Array(await media.arrayBuffer()), good);
  assert.equal((await fetch(`${base}/api/media?taskId=${second.id}&path=${encodeURIComponent(asset.path)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/media?taskId=${first.id}&path=../config.json`)).status, 400);
  const modelScene = { ...scene, title: "Imported model", nodes: [{ ...scene.nodes[0]!, type: "model", asset: asset.path }] };
  assert.equal((await post("/api/creative", { taskId: first.id, scene: modelScene, expectedRevision: 2 })).status, 200);
  assert.equal((await post("/api/creative", { taskId: second.id, scene: modelScene, expectedRevision: 0 })).status, 400);
  assert.equal((await fetch(`${base}/api/creative/asset?taskId=${denied.id}`, { method: "POST", body: good })).status, 403);
  for (const uri of ["https://example.org/texture.png", "../secret.bin", "file:///etc/passwd"]) {
    const bad = glb({ asset: { version: "2.0" }, images: [{ uri }] });
    assert.equal((await fetch(`${base}/api/creative/asset?taskId=${first.id}`, { method: "POST", body: bad })).status, 400);
  }
  assert.equal((await fetch(`${base}/api/creative/asset?taskId=${first.id}`, { method: "POST", body: "invalid" })).status, 400);
  for (const file of ["three.module.js", "three.core.js", "addons/controls/OrbitControls.js", "addons/controls/TransformControls.js", "addons/loaders/GLTFLoader.js", "addons/exporters/GLTFExporter.js"]) {
    const response = await fetch(`${base}/vendor/three/${file}`); assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type") ?? "", /javascript/); assert.ok((await response.text()).length > 100);
  }
  assert.equal((await fetch(`${base}/vendor/three/package.json`)).status, 404);
  await stop(); await start();
  assert.equal((await read(first.id)).scene?.title, "Imported model"); assert.equal((await read(first.id)).scene?.revision, 3);
  assert.equal((await read(second.id)).scene, null);
  assert.equal((await fetch(`${base}/api/media?taskId=${first.id}&path=${encodeURIComponent(asset.path)}`)).status, 200);
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#/studios/creative`);
  await page.locator(".creative-viewport canvas").waitFor({ state: "visible", timeout: 20_000 }).catch(async error => { throw new Error(`${String(error)}\nPage errors: ${JSON.stringify(errors)}\nUI: ${(await page.locator("body").innerText()).slice(-5000)}`); });
  const savedResponse = page.waitForResponse(r => r.url().endsWith("/api/creative") && r.request().method() === "POST" && r.status() === 200);
  await page.locator('.creative-studio [data-action="add"]').click();
  await page.locator('.creative-studio [data-action="save"]').click();
  const saved = await savedResponse, uiTaskId = saved.request().postDataJSON().taskId as string;
  assert.equal((await read(uiTaskId)).scene?.nodes.length, 1);
  assert.equal(await page.locator(".creative-object").count(), 1);
  await page.goto(`${base}/#/tasks/${uiTaskId}`);
  await page.locator(".creative-viewport canvas").waitFor({ state: "visible" });
  await page.locator(".creative-object").waitFor({ state: "visible" });
  assert.equal(await page.locator(".creative-object").count(), 1);
  // Exercise the full editor against real task storage, not the UI fixture server.
  const field = async (selector: string, value: string | number) => {
    await page.locator(selector).fill(String(value)); await page.locator(selector).press('Tab');
  };
  const saveUI = async () => {
    await page.locator('[data-action=save]').click();
    await page.waitForFunction("(() => /^(محفوظ|تم تنزيل)/.test(document.querySelector('[data-creative-status]')?.textContent ?? ''))();");
    return (await read(uiTaskId)).scene!;
  };
  await field('[data-creative-title]', 'QA · تصميم محفوظ');
  for (const type of ['sphere', 'cylinder', 'torus', 'plane', 'cone']) {
    await page.locator('[data-primitive]').selectOption(type); await page.locator('[data-action=add]').click();
  }
  assert.deepEqual((await saveUI()).nodes.map(n => n.type), ['box','sphere','cylinder','torus','plane','cone']);
  await field('[data-node-prop=name]', 'QA cone');
  for (const [prop, values] of Object.entries({position:[2,3,1],rotation:[15,30,45],scale:[1.2,.8,1.5]})) {
    for(let i=0;i<3;i++) await field(`[data-vector=${prop}][data-axis="${i}"]`,values[i]!);
  }
  let current=await saveUI(); assert.deepEqual(current.nodes[5]!.position,[2,3,1]);
  assert.deepEqual(current.nodes[5]!.scale,[1.2,.8,1.5]);assert.ok(Math.abs(current.nodes[5]!.rotation[1]!-Math.PI/6)<1e-6);
  for(const [preset,roughness] of [['ceramic',.28],['metal',.2],['gold',.24],['clay',.9],['plastic',.45]] as const){
    await page.locator('[data-material-preset]').selectOption(preset);assert.equal((await saveUI()).nodes[5]!.material.roughness,roughness);
  }
  await page.locator('[data-node-prop=visible]').uncheck();assert.equal((await saveUI()).nodes[5]!.visible,false);
  await page.locator('[data-node-prop=visible]').check();
  await field('[data-environment=lightIntensity]',4);await field('[data-environment=exposure]',1.3);
  await page.locator('[data-environment=grid]').uncheck();await field('[data-camera-fov]',60);await field('[data-duration]',12);await field('[data-node-prop=spin]',45);
  for(const view of ['front','side','top','perspective']){
    await page.locator('[data-view]').selectOption(view);await page.locator('[data-action=camera-save]').click();
    assert.ok((await saveUI()).camera.position.every(Number.isFinite));
  }
  await page.locator('[data-focus]').click();await page.locator('[data-action=frame]').click();await page.locator('[data-action=camera-save]').click();
  await page.locator('[data-space]').selectOption('local');await page.locator('[data-snap]').check();
  for(const mode of ['translate','rotate','scale']){await page.locator(`[data-transform=${mode}]`).click();assert.equal(await page.locator(`[data-transform=${mode}]`).getAttribute('aria-pressed'),'true');}
  await page.locator('[data-space]').selectOption('world');await page.locator('[data-snap]').uncheck();
  await page.locator('[data-object-search]').fill('QA cone');assert.equal(await page.locator('[data-select]:visible').count(),1);await page.locator('[data-object-search]').fill('');
  await page.locator('.creative-studio').focus();await page.keyboard.press('Control+d');assert.equal(await page.locator('[data-select]').count(),7);
  await page.locator('.creative-studio').focus();await page.keyboard.press('Control+z');assert.equal(await page.locator('[data-select]').count(),6);
  await page.locator('.creative-studio').focus();await page.keyboard.press('Control+Shift+z');assert.equal(await page.locator('[data-select]').count(),7);
  await page.locator('.creative-studio').focus();await page.keyboard.press('Delete');assert.equal(await page.locator('[data-select]').count(),6);
  await page.locator('[data-action=play]').click();await page.waitForFunction("(() => parseFloat(document.querySelector('[data-time]').textContent) > .1)();");
  await page.locator('[data-action=stop]').click();await page.waitForFunction("(() => document.querySelector('[data-time]').textContent === '0.0 s')();");
  await page.locator('[data-scrub]').fill('2.5');await page.locator('[data-scrub]').dispatchEvent('input');
  await page.waitForFunction("(() => document.querySelector('[data-time]').textContent === '2.5 s')();");await page.locator('[data-action=stop]').click();
  const download=async(format:string)=>{await page.locator('[data-export]').selectOption(format);const pending=page.waitForEvent('download');await page.locator('[data-action=export]').click();return fs.readFileSync((await (await pending).path())!);};
  for(const width of [1920,3840]){await page.locator('[data-resolution]').selectOption(String(width));const png=await download('png');assert.equal(png.readUInt32BE(16),width);assert.equal(png.readUInt32BE(20),width*9/16);assert.ok(png.length>15000);}
  const binary=await download('glb');assert.equal(binary.readUInt32LE(0),0x46546c67);
  const gltf=JSON.parse(binary.subarray(20,20+binary.readUInt32LE(12)).toString());assert.equal(gltf.meshes.length,6);assert.ok(gltf.animations?.length,JSON.stringify((await read(uiTaskId)).scene?.nodes));
  assert.equal(JSON.parse((await download('json')).toString()).nodes.length,6);
  await page.locator('[data-import]').setInputFiles({name:'broken.glb',mimeType:'model/gltf-binary',buffer:Buffer.from('broken')});
  await page.waitForFunction("(() => !document.querySelector('[data-creative-status]').textContent.includes('جارٍ'))();");
  assert.equal(await page.locator('[data-select]').count(),6);
  const mediaLoaded=page.waitForResponse(r=>r.url().includes('/api/media?')&&r.status()===200);
  const chooser=page.waitForEvent('filechooser');await page.locator('[data-action=import]').click();
  await (await chooser).setFiles({name:'roundtrip.glb',mimeType:'model/gltf-binary',buffer:binary});
  await page.waitForFunction("(() => document.querySelectorAll('[data-select]').length === 7)();");
  await mediaLoaded;
  current=await saveUI();assert.equal(current.nodes[6]!.type,'model');
  const snapshot=JSON.parse(JSON.stringify(current));
  await page.reload();await page.locator('.creative-viewport canvas').waitFor();
  await page.waitForFunction("(() => document.querySelectorAll('[data-select]').length === 7)();");
  assert.deepEqual((await read(uiTaskId)).scene,snapshot);
  await stop();await start();await page.reload();await page.locator('.creative-viewport canvas').waitFor();
  await page.waitForFunction("(() => document.querySelectorAll('[data-select]').length === 7)();");
  assert.deepEqual((await read(uiTaskId)).scene,snapshot,'UI changes survive a real server restart');
  await page.waitForTimeout(500);const reexported=await download('glb');assert.equal(reexported.readUInt32LE(0),0x46546c67);
  const reimported=JSON.parse(reexported.subarray(20,20+reexported.readUInt32LE(12)).toString());
  const materials=(document: {materials: Array<{pbrMetallicRoughness: unknown}>})=>document.materials.map(m=>JSON.stringify(m.pbrMetallicRoughness));
  const originalMaterials=materials(gltf);
  assert.ok(materials(reimported).every(m=>originalMaterials.includes(m)),'GLB roundtrip preserves original colors, metalness and roughness');
  const portable=await download('json');const portableScene=JSON.parse(portable.toString());assert.equal(Object.keys(portableScene.assets).length,1);
  await page.goto(`${base}/#/modes/media`);await page.locator('.creative-viewport canvas').waitFor();
  const importedSave=page.waitForResponse(r=>r.url().endsWith('/api/creative')&&r.request().method()==='POST'&&r.status()===200);
  const jsonChooser=page.waitForEvent('filechooser');await page.locator('[data-action=import]').click();
  await(await jsonChooser).setFiles({name:'scene.json',mimeType:'application/json',buffer:portable});
  const importedResponse=await importedSave,newTaskId=importedResponse.request().postDataJSON().taskId;
  assert.notEqual(newTaskId,uiTaskId);const newScene=(await read(newTaskId)).scene!;
  assert.equal(newScene.revision,1);assert.equal(newScene.nodes.length,7);assert.notEqual((newScene.nodes[6]! as {asset?:string}).asset,(snapshot.nodes[6]! as {asset?:string}).asset);
  await page.goto(`${base}/#/tasks/${newTaskId}`);await page.locator('.creative-viewport canvas').waitFor();await page.waitForFunction("(() => document.querySelectorAll('[data-select]').length === 7)();");
  await page.locator('[data-select]').first().click();await field('[data-node-prop=name]','Edited after JSON import');await page.locator('[data-action=save]').click();
  await page.waitForFunction("(() => document.querySelector('[data-creative-status]').textContent.startsWith('محفوظ'))();");
  assert.equal((await read(newTaskId)).scene!.nodes[0]!.name,'Edited after JSON import');
  assert.equal(JSON.parse((await download('json')).toString()).nodes[0]!.name,'Edited after JSON import');
  await page.locator('[data-import]').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"version":7}')});
  await page.waitForFunction("(() => document.querySelector('[data-creative-status]').textContent.includes('غير') || document.querySelector('[data-creative-status]').textContent.includes('ليس'))();");
  assert.equal(await page.locator('[data-select]').count(),7);
  const legacy={...portableScene,title:'Legacy primitive scene',nodes:[portableScene.nodes[0]!],assets:undefined};
  await page.locator('[data-import]').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
  await page.locator('#confirmDialog button[value=cancel]').click();assert.equal(await page.locator('[data-select]').count(),7);
  await page.waitForFunction("!document.querySelector('[data-action=import]').disabled");
  await page.locator('[data-import]').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
  await page.locator('#confirmDialog button[value=confirm]').click();
  await page.waitForFunction("(() => document.querySelectorAll('[data-select]').length === 1 && document.querySelector('[data-creative-status]').textContent.startsWith('محفوظ'))();");
  assert.equal((await read(newTaskId)).scene!.title,'Legacy primitive scene');
  await page.locator('[data-action=undo]').click();await page.locator('[data-action=save]').click();
  await page.waitForFunction("(() => document.querySelectorAll('[data-select]').length === 7 && document.querySelector('[data-creative-status]').textContent.startsWith('محفوظ'))();");
  const mediaFixtures=await checkCreativeMedia(page);
  const timelineFiles=await checkCreativeTimeline(page,mediaFixtures);
  try { checkAssetModel(); await checkCreativeAssets(page, mediaFixtures, { taskId: newTaskId, workspace, base }); await checkAssetLibraryUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); checkEditingToolsModel(); await checkEditingToolsUI(page, mediaFixtures); await checkAssetOperationsUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); checkAudioModel(); await checkAudioUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); checkAudioAdvancedModel(); await checkAudioAdvancedUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); checkFxModel(); await checkFxUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); checkBlendModel(); await checkBlendUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); checkLutModel(); await checkLutUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); checkIdentityModel(); await checkIdentityUI(page, mediaFixtures, { taskId: newTaskId, workspace, base }); }
  catch (error) { throw new Error(`${String(error)}\nSTACK: ${(error instanceof Error ? error.stack ?? "" : '').split('\n').slice(0, 5).join(' | ')}\nUI: ${(await page.locator("body").innerText()).slice(-800)}`); }
  await stop();await start();await page.reload();await page.locator('.creative-viewport canvas').waitFor();
  await page.locator('[data-timeline-open]').click();await page.waitForFunction("!document.querySelector('.creative-timeline-editor fieldset').disabled");
  await page.locator('[data-tl-list]').click();await page.waitForFunction("!document.querySelector('.creative-timeline-editor fieldset').disabled");
  await page.locator('[data-tl-saved]').selectOption(timelineFiles.projectPath);await page.waitForFunction("!document.querySelector('.creative-timeline-editor fieldset').disabled");
  assert.equal(await page.locator('[data-clip]').count(),5,'saved multitrack project reopens after server restart');
  assert.equal((await fetch(`${base}/api/media?taskId=${newTaskId}&path=${encodeURIComponent(timelineFiles.outputPath)}`)).status,200,'queued MP4 survives restart');
  await page.locator('[data-tl-close]').click();
  assert.deepEqual(errors, []);
  fs.mkdirSync(path.join(root, "release"), { recursive: true });
  await page.screenshot({ path: path.join(root, "release", "loam-creative-integrated.png"), fullPage: true });
  console.log("PASS creative real HTTP + Edge UI: six primitives, numeric transforms, five materials, views/camera, environment, search, shortcuts/history, animation, PNG HD/4K, GLB/JSON downloads, file chooser GLB roundtrip, invalid import, reload and server restart persistence; API conflicts, task isolation and GLB safety; asset thumbnails/integrity report, portable package round-trip, missing-asset relink; import preview with range/folder/tags + ffmpeg metadata, library search/filters, proxy + variable preview quality with full-resolution export; cancellable proxy jobs with retry, persistent thumbnail cache + disk-space panel + orphan cleanup, source/license metadata; roll/slip/slide/ripple tools, multi-select group editing, subtitle editor with SRT/VTT export; EQ/compressor/ducking shaping exports, WAV+LUFS normalization, stems ZIP, audio devices, subtitle styling; Bézier keyframes with drag dots + ease editor, effects panel with chroma key and masks in preview and export; blend modes + adjustment layers + scopes + wipe/direction/curve transitions in preview and exported MP4; .cube LUT import with strength + color match between clips; identity package applied to titles + logo, five editable templates, platform sizes/aspect convert + safe-area guides");
} finally {
  await browser?.close();
  await stop(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
