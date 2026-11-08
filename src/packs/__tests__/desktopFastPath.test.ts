import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Config } from '../../config.js';
import type { AgentEvent } from '../../agent/events.js';
import { ToolRegistry } from '../../tools/registry.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-desktop-fast-'));
process.env.MANUS_LOCAL_DATA_DIR = tmp;

const { createTask } = await import('../../server/db.js');
const { ensureTaskWorkspace } = await import('../../server/taskWorkspace.js');
const { createDesktopPackTools } = await import('../desktop/tools.js');
const { runDesktopFastPath, desktopTemplateRequest } = await import('../desktop/fastPath.js');

test('desktop fast path creates the requested template and publishes its real resource', async () => {
  const parent = createTask('Desktop fast path', 'test');
  const workspace = ensureTaskWorkspace(parent.id, tmp);
  const tools = new ToolRegistry();
  tools.registerAll(createDesktopPackTools({
    verify: async (project) => {
      const dist = path.join(project.workspaceDir, project.appDir, 'dist');
      fs.mkdirSync(dist, { recursive: true });
      fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Loam</title>');
      return { ok: true, output: 'acceptance passed' };
    },
    snapshot: async () => ({ number: 1 }),
  }));
  const events: AgentEvent[] = [];
  const result = await runDesktopFastPath({
    cfg: { workspace: tmp } as Config,
    tools,
    emit: (event) => events.push(event),
    prompt: 'Make a habit tracker with reminders and weekly streaks',
    taskId: parent.id,
  });
  assert.equal(result.verified, true);
  assert.match(result.text, /Habit Tracker/);
  assert.match(result.text, /loam-resource:\/\/loam-desktop\/app\//);
  assert.ok(fs.existsSync(path.join(workspace, 'uploads', 'loam-habit-tracker.desktop.json')));
  assert.ok(events.some((event) => event.type === 'done'));
  assert.equal(desktopTemplateRequest('Make a habit tracker with reminders and weekly streaks', 'build'), true);
  assert.equal(desktopTemplateRequest('Build an unfamiliar accounting system', 'build'), false);
});
