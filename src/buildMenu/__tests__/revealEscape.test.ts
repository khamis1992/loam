import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { revealArtifactFile } = require('../reveal.cjs') as {
  revealArtifactFile(workspace: string, projectId: string, artifactId: string): string;
};

const projectId = 'app_bcdfghjkmnpq';
const otherProjectId = 'app_zzzzzzzzzzzz';
const artifactId = 'art_01234567-89ab-cdef-0123-456789abcdef';

function artifactsDir(root: string): string {
  return path.join(root, '.loam', 'build-menu', 'artifacts');
}

function filenameFor(extension: string): string {
  return `${artifactId}.${extension}`;
}

function allowedRelative(filename: string): string {
  return `.loam/build-menu/artifacts/${filename}`;
}

function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function assertNothing(run: () => string, pattern?: RegExp): void {
  let value: string | undefined = 'pending';
  if (pattern) assert.throws(() => { value = run(); }, pattern);
  else assert.throws(() => { value = run(); });
  assert.equal(value, 'pending');
}

function assertInside(root: string, revealed: string, filename: string): void {
  const rootReal = fs.realpathSync(root);
  const fileReal = fs.realpathSync(revealed);
  const rel = path.relative(rootReal, fileReal);
  assert.equal(rel === '' || rel.startsWith('..') || path.isAbsolute(rel), false);
  assert.equal(samePath(rel, path.join('.loam', 'build-menu', 'artifacts', filename)), true);
  const stat = fs.lstatSync(fileReal);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(path.basename(fileReal), filename);
  const dirReal = fs.realpathSync(artifactsDir(root));
  assert.equal(samePath(path.relative(dirReal, fileReal), filename), true);
}

function writeMetadata(root: string, extension: string, metadataProject: string, relativePath: string): void {
  const dir = artifactsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${artifactId}.json`), JSON.stringify({
    artifactId,
    projectId: metadataProject,
    relativePath,
  }));
}

function plant(root: string, extension: 'zip' | 'ipynb' | 'apk'): string {
  const filename = filenameFor(extension);
  const filePath = path.join(artifactsDir(root), filename);
  writeMetadata(root, extension, projectId, allowedRelative(filename));
  fs.writeFileSync(filePath, `bytes-${extension}`);
  return filePath;
}

function withRoot(prefix: string, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('reveal returns a regular zip, ipynb, or apk inside the artifacts directory', () => {
  for (const extension of ['zip', 'ipynb', 'apk'] as const) {
    withRoot('loam-reveal-ok-', (root) => {
      const filename = filenameFor(extension);
      plant(root, extension);
      assert.equal(path.isAbsolute(root), true);
      const revealed = revealArtifactFile(root, projectId, artifactId);
      assertInside(root, revealed, filename);
      assert.equal(fs.readFileSync(revealed, 'utf8'), `bytes-${extension}`);
    });
  }
});

test('a metadata path that escapes the workspace throws and returns nothing', () => {
  withRoot('loam-reveal-meta-', (root) => {
    const filename = filenameFor('zip');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-reveal-out-'));
    const outsideFile = path.join(outsideDir, filename);
    const rootFile = path.join(root, filename);
    try {
      fs.writeFileSync(outsideFile, 'outside-secret');
      fs.writeFileSync(rootFile, 'root-secret');
      plant(root, 'zip');
      const escapes = [
        outsideFile,
        rootFile,
        path.win32.join('C:\\secret', filename),
        path.join('..', '..', filename),
        `.loam/build-menu/artifacts/../../${filename}`,
        `.loam/build-menu/foo/../../../.loam/build-menu/artifacts/${filename}`,
        `/tmp/${filename}`,
        `\\\\server\\share\\${filename}`,
        path.posix.join('.loam', 'build-menu', 'artifacts', '..', '..', filename),
      ];
      for (const relativePath of escapes) {
        assert.equal(relativePath === allowedRelative(filename), false);
        assert.equal(path.basename(relativePath), filename);
        writeMetadata(root, 'zip', projectId, relativePath);
        assertNothing(() => revealArtifactFile(root, projectId, artifactId), /invalid_request/);
        assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside-secret');
        assert.equal(fs.readFileSync(rootFile, 'utf8'), 'root-secret');
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test('a symlink metadata file throws and returns nothing', () => {
  withRoot('loam-reveal-symlink-meta-', (root) => {
    const metaPath = path.join(artifactsDir(root), `${artifactId}.json`);
    plant(root, 'zip');
    const original = fs.lstatSync.bind(fs);
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: fs.StatOptions) => {
      if (samePath(path.resolve(String(target)), path.resolve(metaPath))) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true } as fs.Stats;
      }
      return options === undefined ? original(target) : original(target, options);
    }) as typeof fs.lstatSync });
    try {
      const seen = fs.lstatSync(metaPath);
      assert.equal(seen.isFile(), true);
      assert.equal(seen.isSymbolicLink(), true);
      assertNothing(() => revealArtifactFile(root, projectId, artifactId), /unsafe_path/);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: original });
    }
  });
});

test('a symlink artifacts directory throws and returns nothing', () => {
  withRoot('loam-reveal-symlink-dir-', (root) => {
    const dir = artifactsDir(root);
    plant(root, 'zip');
    const original = fs.lstatSync.bind(fs);
    Object.defineProperty(fs, 'lstatSync', { value: ((target: fs.PathLike, options?: fs.StatOptions) => {
      if (samePath(path.resolve(String(target)), path.resolve(dir))) {
        return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => true } as fs.Stats;
      }
      return options === undefined ? original(target) : original(target, options);
    }) as typeof fs.lstatSync });
    try {
      assertNothing(() => revealArtifactFile(root, projectId, artifactId), /unsafe_path/);
    } finally {
      Object.defineProperty(fs, 'lstatSync', { value: original });
    }
  });
});

test('a resolved artifact path outside the workspace throws and returns nothing', () => {
  withRoot('loam-reveal-real-', (root) => {
    const filename = filenameFor('zip');
    const filePath = plant(root, 'zip');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-reveal-real-out-'));
    const outsideFile = path.join(outsideDir, filename);
    fs.writeFileSync(outsideFile, 'resolved-secret');
    const dir = artifactsDir(root);
    const original = fs.realpathSync.bind(fs);
    fs.realpathSync = ((target: fs.PathLike) => {
      const resolved = path.resolve(String(target));
      if (samePath(resolved, path.resolve(dir))) return outsideDir;
      if (samePath(resolved, path.resolve(filePath))) return outsideFile;
      return original(target);
    }) as typeof fs.realpathSync;
    try {
      assertNothing(() => revealArtifactFile(root, projectId, artifactId), /unsafe_path/);
      assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'resolved-secret');
    } finally {
      fs.realpathSync = original;
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test('a mismatched project id throws and returns nothing', () => {
  withRoot('loam-reveal-project-', (root) => {
    plant(root, 'ipynb');
    writeMetadata(root, 'ipynb', otherProjectId, allowedRelative(filenameFor('ipynb')));
    assertNothing(() => revealArtifactFile(root, projectId, artifactId), /not_found/);
    writeMetadata(root, 'ipynb', projectId, allowedRelative(filenameFor('ipynb')));
    assertNothing(() => revealArtifactFile(root, otherProjectId, artifactId), /not_found/);
    const revealed = revealArtifactFile(root, projectId, artifactId);
    assertInside(root, revealed, filenameFor('ipynb'));
  });
});

test('an absolute path from the caller throws and returns nothing', () => {
  withRoot('loam-reveal-abs-', (root) => {
    const filename = filenameFor('apk');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-reveal-abs-out-'));
    const outsideFile = path.resolve(outsideDir, filename);
    try {
      fs.writeFileSync(outsideFile, 'caller-secret');
      plant(root, 'apk');
      assert.equal(path.isAbsolute(outsideFile), true);
      assertNothing(() => revealArtifactFile(root, projectId, outsideFile), /invalid_request/);
      assertNothing(() => revealArtifactFile(root, outsideFile, artifactId), /invalid_request/);
      assertNothing(() => revealArtifactFile(outsideFile, projectId, artifactId));
      assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'caller-secret');
      const revealed = revealArtifactFile(root, projectId, artifactId);
      assertInside(root, revealed, filename);
      assert.equal(samePath(path.resolve(revealed), outsideFile), false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

test('a hard-linked artifact stays the regular file inside the artifacts directory', () => {
  withRoot('loam-reveal-hard-', (root) => {
    const filename = filenameFor('zip');
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-reveal-hard-out-'));
    const outsideFile = path.join(outsideDir, filename);
    const inside = path.join(artifactsDir(root), filename);
    try {
      fs.writeFileSync(outsideFile, 'linked-secret');
      writeMetadata(root, 'zip', projectId, allowedRelative(filename));
      fs.linkSync(outsideFile, inside);
      const stat = fs.lstatSync(inside);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.nlink > 1, true);
      const revealed = revealArtifactFile(root, projectId, artifactId);
      assertInside(root, revealed, filename);
      assert.equal(samePath(path.resolve(revealed), path.resolve(outsideFile)), false);
      assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'linked-secret');
      assert.equal(fs.readFileSync(revealed, 'utf8'), 'linked-secret');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
