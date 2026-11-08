/**
 * startServer recovers remembered jobs and does not list app projects.
 * Job recovery stays before kernel recovery. This file only reads http.ts.
 * It does not import the server, listen, or read config.json.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/startupNoProjectList.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const httpSource = fs.readFileSync(new URL('../../server/http.ts', import.meta.url), 'utf8');

function startupBody(source: string): string {
  const start = source.indexOf('export function startServer');
  assert.ok(start >= 0, 'startServer must exist');
  const server = source.indexOf('http.createServer', start);
  assert.ok(server > start, 'startup must run before the request server');
  return source.slice(start, server);
}

test('startup calls recoverRememberedJobs and does not call listAppProjects', () => {
  const startup = startupBody(httpSource);
  const jobsAt = startup.indexOf('recoverRememberedJobs(');
  const kernelsAt = startup.indexOf('recoverRememberedKernels(');
  assert.ok(jobsAt >= 0);
  assert.match(startup, /recoverRememberedJobs\(activeJobs\)/);
  assert.equal(startup.includes('listAppProjects'), false);
  assert.ok(kernelsAt > jobsAt);
});
