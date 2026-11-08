/**
 * startServer may open remembered routines by itself. That call stays outside
 * startScheduler. http.ts must not run build-menu catch-up from the scheduler,
 * and the Monday 09:00 Asia/Qatar cron stays in the routine sources.
 * This file only reads source text. It does not import the scheduler or start one.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/schedulerUnhooked.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const httpSource = fs.readFileSync(new URL('../../server/http.ts', import.meta.url), 'utf8');
const catchupSource = fs.readFileSync(new URL('../automations/catchup.ts', import.meta.url), 'utf8');
const materializeSource = fs.readFileSync(new URL('../materialize.ts', import.meta.url), 'utf8');
const timezoneSource = fs.readFileSync(new URL('../../server/scheduleTime.ts', import.meta.url), 'utf8');

function balanced(source: string, openAt: number, open: string, close: string): string {
  let depth = 0;
  for (let index = openAt; index < source.length; index += 1) {
    const char = source[index];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openAt, index + 1);
    }
  }
  return source.slice(openAt);
}

function startSchedulerRegions(source: string): string[] {
  const regions: string[] = [];
  const call = /startScheduler\s*\(/g;
  for (const match of source.matchAll(call)) {
    const at = match.index ?? -1;
    if (at < 0) continue;
    const openAt = at + match[0].length - 1;
    regions.push(source.slice(at, openAt) + balanced(source, openAt, '(', ')'));
  }
  const declaration = 'function startScheduler';
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(declaration, from);
    if (at < 0) break;
    const brace = source.indexOf('{', at);
    assert.ok(brace >= 0, 'startScheduler must have a body');
    regions.push(source.slice(at, brace) + balanced(source, brace, '{', '}'));
    from = at + declaration.length;
  }
  return regions;
}

function refusesBuildMenuCatchUp(region: string): void {
  assert.equal(region.includes('openRememberedRoutines'), false);
  assert.equal(region.includes('catchUpLocalReport'), false);
  assert.equal(region.includes('catchup'), false);
  assert.equal(region.includes('catch-up'), false);
  assert.equal(region.includes('build-menu'), false);
  assert.equal(region.includes('0 9 * * 1'), false);
  assert.equal(region.includes('Asia/Qatar'), false);
}

test('http startScheduler does not open remembered routines or run build-menu catch-up', () => {
  const regions = startSchedulerRegions(httpSource);
  for (const region of regions) refusesBuildMenuCatchUp(region);
  assert.equal(regions.length, 0);
  assert.equal(httpSource.includes('startScheduler'), false);
  assert.equal(httpSource.includes('scheduler.js'), false);
  assert.equal(httpSource.includes('catchUpLocalReport'), false);
  assert.equal(httpSource.includes('automations/catchup'), false);

  const serverAt = httpSource.indexOf('export function startServer');
  assert.ok(serverAt >= 0);
  const openAt = httpSource.indexOf('openRememberedRoutines(', serverAt);
  assert.ok(openAt > serverAt);
  const openCall = httpSource.slice(openAt, openAt + 'openRememberedRoutines'.length)
    + balanced(httpSource, openAt + 'openRememberedRoutines'.length, '(', ')');
  assert.match(openCall, /^openRememberedRoutines\(/);
  assert.equal(openCall.includes('startScheduler'), false);
  assert.equal(openCall.includes('catchUpLocalReport'), false);
  assert.equal(openCall.includes('0 9 * * 1'), false);
  assert.equal(openCall.includes('Asia/Qatar'), false);
  assert.equal(httpSource.slice(serverAt, openAt).includes('startScheduler'), false);
});

test('Monday 09:00 Asia/Qatar cron stays in routine sources and http does not fire it', () => {
  assert.equal(httpSource.includes('0 9 * * 1'), false);
  assert.equal(httpSource.includes('Asia/Qatar'), false);
  assert.equal(httpSource.includes('nextCronRun'), false);
  assert.equal(httpSource.includes('dueSchedules'), false);
  assert.match(timezoneSource, /export const DEFAULT_TIMEZONE = "Asia\/Qatar"/);
  assert.match(catchupSource, /spec\.cron !== '0 9 \* \* 1'/);
  assert.match(catchupSource, /spec\.timezone !== 'Asia\/Qatar'/);
  assert.match(materializeSource, /const cron = '0 9 \* \* 1'/);
  assert.match(materializeSource, /0 9 \* \* 1 Asia\/Qatar/);
  assert.equal(catchupSource.includes('startScheduler'), false);
  assert.equal(materializeSource.includes('startScheduler'), false);
});
