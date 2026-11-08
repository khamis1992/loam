import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gameScene, readGameBrief, writeGameBrief } from '../games/scene.js';

const BRIEF = 'هدف محلي mailto:user@example.test';
const NEEDLE = 'mailto:user@example.test';

interface Paths {
  root: string;
  workspace: string;
  outside: string;
}

function isUnsafe(error: unknown): boolean {
  return error instanceof Error && error.message === 'unsafe_path';
}

function makeRoot(): Paths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-44-brief-'));
  const workspace = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'local note');
  return { root, workspace, outside };
}

function briefFile(workspace: string): string {
  return path.join(workspace, 'app', 'brief.txt');
}

function unlinkIfLink(file: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
  } catch {
    // The path was not created.
  }
}

function cleanup(paths: Paths): void {
  const app = path.join(paths.workspace, 'app');
  unlinkIfLink(app);
  unlinkIfLink(briefFile(paths.workspace));
  fs.rmSync(paths.root, { recursive: true, force: true });
}

function relativeFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile()) found.push(path.relative(root, absolute));
    }
  };
  visit(root);
  return found.sort();
}

function filesContaining(root: string, needle: string): string[] {
  return relativeFiles(root).filter((relative) => fs.readFileSync(path.join(root, relative), 'utf8').includes(needle));
}

function isAppBrief(workspace: string, file: string): boolean {
  const expected = path.join('app', 'brief.txt');
  const logical = path.relative(path.resolve(workspace), path.resolve(file));
  const physical = path.relative(fs.realpathSync(workspace), fs.realpathSync(file));
  return logical === expected && physical === expected;
}

function refuse(setup: (paths: Paths) => void, check: (paths: Paths) => void): void {
  const paths = makeRoot();
  try {
    setup(paths);
    assert.throws(() => writeGameBrief(paths.workspace, BRIEF), isUnsafe);
    assert.deepEqual(filesContaining(paths.root, NEEDLE), []);
    assert.equal(fs.readFileSync(path.join(paths.outside, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'notes.txt'), 'utf8'), 'local note');
    check(paths);
  } finally {
    cleanup(paths);
  }
}

test('a mailto brief is stored only in app/brief.txt', () => {
  assert.equal(gameScene('هدف قريب').goalX, 420);
  assert.equal(gameScene('هدف بعيد').goalX, 600);
  assert.equal(gameScene(BRIEF).goalX, 600);
  const paths = makeRoot();
  try {
    fs.mkdirSync(path.join(paths.workspace, 'app'));
    fs.writeFileSync(path.join(paths.workspace, 'app', 'page.txt'), 'page');
    writeGameBrief(paths.workspace, `  ${BRIEF}  `);
    const file = briefFile(paths.workspace);
    assert.equal(fs.readFileSync(file, 'utf8'), BRIEF);
    assert.equal(readGameBrief(paths.workspace), BRIEF);
    assert.equal(isAppBrief(paths.workspace, file), true);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(filesContaining(paths.root, NEEDLE), [path.join('project', 'app', 'brief.txt')]);
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'app', 'page.txt'), 'utf8'), 'page');
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'notes.txt'), 'utf8'), 'local note');
    assert.equal(fs.readFileSync(path.join(paths.outside, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(paths.outside, 'brief.txt')), false);
    assert.deepEqual(relativeFiles(paths.workspace), [path.join('app', 'brief.txt'), path.join('app', 'page.txt'), 'notes.txt'].sort());
  } finally {
    cleanup(paths);
  }
});

test('a directory link outside app/brief.txt is not followed', () => {
  refuse((paths) => {
    fs.writeFileSync(path.join(paths.outside, 'brief.txt'), 'keep-outside');
    fs.symlinkSync(paths.outside, path.join(paths.workspace, 'app'), 'junction');
  }, (paths) => {
    assert.equal(fs.readFileSync(path.join(paths.outside, 'brief.txt'), 'utf8'), 'keep-outside');
    assert.equal(fs.lstatSync(path.join(paths.workspace, 'app')).isSymbolicLink(), true);
  });
  refuse((paths) => {
    fs.symlinkSync(paths.outside, path.join(paths.workspace, 'app'), 'junction');
  }, (paths) => {
    assert.equal(fs.existsSync(path.join(paths.outside, 'brief.txt')), false);
    assert.equal(fs.lstatSync(path.join(paths.workspace, 'app')).isSymbolicLink(), true);
  });
  refuse((paths) => {
    const other = path.join(paths.workspace, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'brief.txt'), 'internal-keep');
    fs.symlinkSync(other, path.join(paths.workspace, 'app'), 'junction');
  }, (paths) => {
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'other', 'brief.txt'), 'utf8'), 'internal-keep');
    assert.equal(fs.lstatSync(path.join(paths.workspace, 'app')).isSymbolicLink(), true);
  });
});

test('a brief file link is not followed and mailto is not written', () => {
  refuse((paths) => {
    fs.mkdirSync(path.join(paths.workspace, 'app'));
    fs.writeFileSync(path.join(paths.outside, 'brief.txt'), 'keep-outside');
    fs.symlinkSync(path.join(paths.outside, 'brief.txt'), briefFile(paths.workspace), 'file');
  }, (paths) => {
    assert.equal(fs.readFileSync(path.join(paths.outside, 'brief.txt'), 'utf8'), 'keep-outside');
    assert.equal(fs.lstatSync(briefFile(paths.workspace)).isSymbolicLink(), true);
  });
  refuse((paths) => {
    fs.mkdirSync(path.join(paths.workspace, 'app'));
    fs.symlinkSync(path.join(paths.outside, 'missing-brief.txt'), briefFile(paths.workspace), 'file');
  }, (paths) => {
    assert.equal(fs.existsSync(path.join(paths.outside, 'missing-brief.txt')), false);
    assert.equal(fs.lstatSync(briefFile(paths.workspace)).isSymbolicLink(), true);
  });
  refuse((paths) => {
    fs.mkdirSync(path.join(paths.workspace, 'app'));
    fs.writeFileSync(path.join(paths.outside, 'brief.txt'), 'keep-outside');
    fs.linkSync(path.join(paths.outside, 'brief.txt'), briefFile(paths.workspace));
    const stat = fs.lstatSync(briefFile(paths.workspace));
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink > 1, true);
  }, (paths) => {
    assert.equal(fs.readFileSync(path.join(paths.outside, 'brief.txt'), 'utf8'), 'keep-outside');
    assert.equal(fs.readFileSync(briefFile(paths.workspace), 'utf8'), 'keep-outside');
  });
  refuse((paths) => {
    fs.writeFileSync(path.join(paths.workspace, 'app'), 'not-a-folder');
  }, (paths) => {
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'app'), 'utf8'), 'not-a-folder');
    assert.equal(fs.existsSync(briefFile(paths.workspace)), false);
  });
});
