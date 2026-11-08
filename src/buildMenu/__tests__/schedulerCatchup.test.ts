/**
 * startScheduler must not open remembered routines or run build-menu catch-up.
 * The Monday 09:00 Asia/Qatar cron stays in the routine sources and is not fired.
 * This file only reads source text. It does not import the scheduler, open the
 * schedule database, or enable the build menu.
 *
 * Run: node --import tsx --test --test-concurrency=1 --test-force-exit --test-reporter=tap src/buildMenu/__tests__/schedulerCatchup.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const schedulerSource = fs.readFileSync(new URL('../../server/scheduler.ts', import.meta.url), 'utf8');
const catchupSource = fs.readFileSync(new URL('../automations/catchup.ts', import.meta.url), 'utf8');
const materializeSource = fs.readFileSync(new URL('../materialize.ts', import.meta.url), 'utf8');

function functionBody(source: string, name: string): string {
  const marker = `export function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start);
}

test('startScheduler does not call openRememberedRoutines or build-menu catch-up', () => {
  const body = functionBody(schedulerSource, 'startScheduler');
  assert.match(body, /export function startScheduler\(deps: SchedulerDeps\)/);
  assert.equal(schedulerSource.includes('openRememberedRoutines'), false);
  assert.equal(schedulerSource.includes('catchUpLocalReport'), false);
  assert.equal(schedulerSource.includes('catchup'), false);
  assert.equal(schedulerSource.includes('buildMenu'), false);
  assert.equal(schedulerSource.includes('automations/open'), false);
  assert.equal(schedulerSource.includes('automations/catchup'), false);
  assert.equal(body.includes('openRememberedRoutines('), false);
  assert.equal(body.includes('catchUpLocalReport('), false);
  assert.equal(schedulerSource.includes('startScheduler({'), false);
});

test('build-menu cron stays 0 9 * * 1 Asia/Qatar and the scheduler does not fire it', () => {
  assert.match(catchupSource, /spec\.cron !== '0 9 \* \* 1'/);
  assert.match(catchupSource, /spec\.timezone !== 'Asia\/Qatar'/);
  assert.match(materializeSource, /const cron = '0 9 \* \* 1'/);
  assert.match(materializeSource, /0 9 \* \* 1 Asia\/Qatar/);
  assert.match(materializeSource, /timezone: DEFAULT_TIMEZONE/);
  assert.equal(schedulerSource.includes('0 9 * * 1'), false);
  assert.equal(schedulerSource.includes('Asia/Qatar'), false);
  assert.equal(schedulerSource.includes('nextCronRun'), false);
  assert.equal(schedulerSource.includes('catchUpLocalReport('), false);
  assert.equal(schedulerSource.includes('openRememberedRoutines('), false);
});
