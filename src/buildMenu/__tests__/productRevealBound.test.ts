/**
 * Product electron/main.cjs reveals an artifact only through the workspace
 * helper. The handler must not show or return a caller-supplied absolute path.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/productRevealBound.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const productMain = fileURLToPath(new URL('../../../electron/main.cjs', import.meta.url));

function revealHandler(source: string): string {
  const marker = 'buildMenu: {';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'product electron/main.cjs has a buildMenu namespace');
  const handlerAt = source.indexOf('revealArtifact:', start);
  assert.ok(handlerAt >= 0, 'product electron/main.cjs has a revealArtifact handler');
  const end = source.indexOf('\n  window:', handlerAt);
  assert.ok(end > handlerAt, 'revealArtifact handler is closed before window');
  return source.slice(handlerAt, end);
}

test('product reveal stays inside the workspace helper', () => {
  const parts = productMain.split(path.sep);
  assert.equal(parts.at(-1), 'main.cjs');
  assert.equal(parts.at(-2), 'electron');
  assert.equal(parts.includes('templates'), false);

  const source = fs.readFileSync(productMain, 'utf8');
  assert.match(
    source,
    /const \{ assertRevealCaller, revealArtifactFile \} = require\("\.\.\/src\/buildMenu\/reveal\.cjs"\);/,
  );

  const handler = revealHandler(source);
  assert.match(handler, /assertRevealCaller\(\{[^}]*body:\s*payload\s*\}/);
  assert.match(
    handler,
    /const workspaceDir = body && body\.project && body\.project\.workspaceDir;/,
  );
  assert.match(
    handler,
    /shell\.showItemInFolder\(\s*revealArtifactFile\(\s*workspaceDir\s*,\s*request\.projectId\s*,\s*request\.artifactId\s*\)\s*\)/,
  );
  assert.equal((handler.match(/shell\.showItemInFolder\(/g) ?? []).length, 1);
  assert.equal((handler.match(/revealArtifactFile\(/g) ?? []).length, 1);

  const afterSignature = handler.replace(/revealArtifact:\s*async\s*\([^)]*\)\s*=>\s*\{/, '');
  const payloadUses = afterSignature.match(/payload/g) ?? [];
  assert.deepEqual(payloadUses, ['payload']);
  assert.equal(/payload\s*\./.test(afterSignature), false);
  assert.equal(/showItemInFolder\(\s*(payload|filePath|absolutePath)\b/.test(handler), false);
  assert.equal(/return\s+(payload|filePath|absolutePath|path)\b/.test(handler), false);
});
