import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { gameProfile, gamesBrief } from '../games/profile.js';
import { gameScene, readGameBrief, writeGameBrief } from '../games/scene.js';
import { checkedTuning } from '../games/tuning.js';
import { gameAssetManifest } from '../games/assets.js';
import { STEP_SOURCE, assertSafeGamePage, gameDocument, startState, type PlayInput, type PlayState } from '../games/page.js';

test('game: fixed capability boundary', () => {
  assert.equal(gameProfile.kind, 'game');
  assert.equal(gameProfile.preview, 'game');
  assert.equal(gameProfile.externalEffects, 'approval-required');
  assert.ok(gameProfile.exports.includes('source-zip'));
  assert.ok(gamesBrief.length > 40);
});

test('game tuning rejects unsafe/NaN values before runtime', () => {
  assert.deepEqual(checkedTuning({ speed: 200, gravity: 700 }), { speed: 200, gravity: 700 });
  assert.throws(() => checkedTuning({ speed: NaN, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 99999, gravity: 700 }), /invalid_tuning/);
});

test('walking off the platform loses, a jump can reach the goal, and R restarts', () => {
  const tuning = checkedTuning({ speed: 200, gravity: 700 });
  const lost = playUntil(tuning, () => ({ left: false, right: true, jump: false }));
  assert.equal(lost.status, 'loss');
  const won = playUntil(tuning, (state) => ({ left: false, right: true, jump: state.x > 420 && state.y >= 500 }));
  assert.equal(won.status, 'goal');
  const again = run(STEP_SOURCE, 'restart()') as PlayState;
  assert.equal(again.x, 70);
  assert.equal(again.y, 500);
  assert.equal(again.status, 'play');
  assert.equal(runStep(won, { left: false, right: true, jump: false }, tuning).status, 'goal');
});

test('a near goal is reached on foot and a far goal is not', () => {
  const tuning = checkedTuning({ speed: 200, gravity: 700 });
  const near = playUntil({ ...tuning, goalX: 420 }, () => ({ left: false, right: true, jump: false }));
  assert.equal(near.status, 'goal');
  assert.equal(near.x > 420 && near.x < 540, true);
  const far = playUntil({ ...tuning, goalX: 600 }, () => ({ left: false, right: true, jump: false }));
  assert.equal(far.status, 'loss');
});

function playUntil(tuning: { speed: number; gravity: number; goalX?: number }, inputFor: (state: PlayState) => PlayInput): PlayState {
  let state = startState();
  for (let frame = 0; frame < 400 && state.status === 'play'; frame += 1) {
    state = runStep(state, inputFor(state), tuning);
  }
  return state;
}

function runStep(state: PlayState, input: PlayInput, tuning: { speed: number; gravity: number; goalX?: number }): PlayState {
  return run(STEP_SOURCE, `step(${JSON.stringify(state)}, ${JSON.stringify(input)}, ${JSON.stringify(tuning)})`) as PlayState;
}

function run(source: string, expression: string): unknown {
  const context = vm.createContext({});
  vm.runInContext(`${source}; result = ${expression};`, context);
  return (context as { result: unknown }).result;
}

test('a brief stays inside the project and a file named app is not overwritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-brief-'));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  try {
    writeGameBrief(workspace, 'هدف قريب');
    assert.equal(readGameBrief(workspace), 'هدف قريب');
    assert.equal(fs.existsSync(path.join(outside, 'brief.txt')), false);

    const blocked = path.join(root, 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'app'), 'not-a-folder');
    assert.throws(() => writeGameBrief(blocked, 'هدف قريب'), /unsafe_path/);
    assert.equal(fs.readFileSync(path.join(blocked, 'app'), 'utf8'), 'not-a-folder');
    assert.equal(fs.existsSync(path.join(outside, 'brief.txt')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a brief containing javascript: and a protocol-relative URL is not an executable src or href', () => {
  const brief = 'javascript:alert(1) //evil.example/a.js </script><script src="//evil.example/a.js"></script><img src="//evil.example/a.png" onerror="alert(1)">';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-brief-url-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  try {
    writeGameBrief(workspace, brief);
    const stored = readGameBrief(workspace);
    assert.equal(stored, brief);
    const page = gameDocument('لعبة', gameScene(stored), stored);
    assert.equal(page.includes('<canvas'), true);
    assert.equal(page.includes('requestAnimationFrame'), true);
    assert.equal(page.includes('const GOAL=600'), true);
    assert.equal(gameDocument('لعبة', gameScene('هدف قريب')).includes('const GOAL=420'), true);
    assert.equal(page.includes('<p id="brief">javascript:alert(1) //evil.example/a.js &lt;/script&gt;&lt;script src=&quot;//evil.example/a.js&quot;&gt;&lt;/script&gt;&lt;img src=&quot;//evil.example/a.png&quot; onerror=&quot;alert(1)&quot;&gt;</p>'), true);
    assert.equal(page.includes('<img'), false);
    assert.equal(page.includes('<script src'), false);
    assert.equal(page.includes('src="//'), false);
    assert.equal(page.includes('href="//'), false);
    assert.equal(page.includes('src="javascript:'), false);
    assert.equal(page.includes('href="javascript:'), false);
    assert.equal(page.includes("src='javascript:"), false);
    assert.equal(page.includes("href='javascript:"), false);
    const tags = page.match(/<[^>]+>/g) ?? [];
    assert.equal(tags.some((tag) => /\son[a-z]+\s*=/i.test(tag)), false);
    assert.equal(tags.some((tag) => /(?:\ssrc|\shref)\s*=\s*['"]?\s*(?:javascript:|\/\/)/i.test(tag)), false);
    const script = page.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
    assert.equal(script.includes('javascript:'), false);
    assert.equal(script.includes('//evil.example'), false);
    assert.equal(/fetch\s*\(\s*['"]\s*(?:javascript:|\/\/)/i.test(script), false);
    assertSafeGamePage(page);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pictured asset that leaves the game folder is rejected', () => {
  const page = gameDocument('لعبة');
  assert.equal(page.includes('<canvas'), true);
  assert.equal(page.includes('requestAnimationFrame'), true);
  assertSafeGamePage(page);
  assert.equal(gameAssetManifest([{ path: 'index.html', text: page }]).includes('index.html'), true);
  assertSafeGamePage('<img src="assets/hero.png">');
  for (const html of [
    '<img src="../secret.png">',
    '<img src="assets/../../secret.png">',
    '<img src="%2e%2e/secret.png">',
    '<img src="//evil.example/a.png">',
    '<img src="file:///c:/secret.png">',
    '<audio src="//evil.example/a.mp3">',
    '<iframe src="//evil.example/"></iframe>',
    '<object data="../secret.swf"></object>',
    '<div style="background:url(../secret.png)">',
  ]) {
    assert.throws(() => assertSafeGamePage(html), /unsafe_path/);
    assert.throws(() => gameAssetManifest([{ path: 'index.html', text: html }]), /unsafe_path/);
  }
});

test('game: fixed capability boundary', () => {
  assert.equal(gameProfile.kind, 'game');
  assert.equal(gameProfile.preview, 'game');
  assert.equal(gameProfile.externalEffects, 'approval-required');
  assert.ok(gameProfile.exports.includes('source-zip'));
  assert.ok(gamesBrief.length > 40);
});

test('game tuning rejects unsafe/NaN values before runtime', () => {
  assert.deepEqual(checkedTuning({ speed: 200, gravity: 700 }), { speed: 200, gravity: 700 });
  assert.throws(() => checkedTuning({ speed: NaN, gravity: 700 }), /invalid_tuning/);
  assert.throws(() => checkedTuning({ speed: 99999, gravity: 700 }), /invalid_tuning/);
});
