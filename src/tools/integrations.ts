import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { getTask } from '../server/db.js';
import type { Tool, ToolRegistry } from './registry.js';

// Kept outside task workspaces: editing a project file cannot grant access.
function grantFile(taskId: string): string {
  if (!/^task_[a-zA-Z0-9_-]+$/.test(taskId)) throw Error('Invalid task id');
  return path.join(DATA_DIR, 'integration-grants', taskId + '.json');
}
const agentGrantFile = (agentId: string): string => path.join(path.dirname(grantFile('task_x')), '..', 'agent-grants', `${agentId}.json`);

/** Frontier 17: external accounts granted to a COMPANION (survive tasks). */
export function agentIntegrationGrants(agentId: string): string[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(agentGrantFile(agentId), 'utf8'));
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveAgentIntegrationGrants(agentId: string, names: string[], registry: ToolRegistry): void {
  if (names.length > 500 || names.some((name) => !registry.get(name)?.integration)) throw Error('Unknown integration');
  const dir = path.dirname(agentGrantFile(agentId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(agentGrantFile(agentId), JSON.stringify([...new Set(names)], null, 1), 'utf8');
}

/** Effective grants for a run: task grants ∪ the owning companion's grants. */
export function effectiveIntegrationGrants(taskId: string, agentId?: string | null): string[] {
  return [...new Set([...integrationGrants(taskId), ...(agentId ? agentIntegrationGrants(agentId) : [])])];
}

export function integrationGrants(taskId: string): string[] {
  try { const value: unknown = JSON.parse(fs.readFileSync(grantFile(taskId), 'utf8')); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function saveIntegrationGrants(taskId: string, names: string[], registry: ToolRegistry): void {
  const task = getTask(taskId);
  if (!task || task.mode === 'ask') throw Error('Select an execution task, not Explore');
  if (['running', 'queued'].includes(task.status)) throw Error('Stop the task before changing integration access');
  if (names.length > 500 || names.some(name => !registry.get(name)?.integration)) throw Error('Unknown integration');
  const file = grantFile(taskId); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify([...new Set(names)])); fs.renameSync(file + '.tmp', file);
}
export function integrationCatalog(registry: ToolRegistry) {
  return registry.names().flatMap(name => { const tool = registry.get(name)!; return tool.integration ? [{ name, description: tool.description, parameters: tool.parameters }] : []; });
}
export function createIntegrationTools(registry: ToolRegistry): Tool[] {
  return [{
    name: 'integration_list', description: 'List external tools explicitly enabled by the user for this task, with their input schemas. Enable tools in Services > Integrations first.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Filter tool names/descriptions' }, offset: { type: 'number', description: 'Pagination offset; returns up to five tools and nextOffset' } } },
    async run(args, ctx) {
      if (!ctx.taskId || getTask(ctx.taskId)?.mode === 'ask') return { ok: false, content: 'An execution task is required' };
      const granted = new Set(effectiveIntegrationGrants(ctx.taskId, getTask(ctx.taskId)?.agentId ?? null));
      const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
      const matches = integrationCatalog(registry).filter(t => granted.has(t.name) && (t.name + ' ' + t.description).toLowerCase().includes(query));
      return { ok: true, content: JSON.stringify({ tools: matches.slice(offset, offset + 5), total: matches.length, nextOffset: offset + 5 < matches.length ? offset + 5 : null }) };
    },
  }, {
    name: 'integration_call', description: 'Execute an external tool explicitly enabled for this task. Use integration_list to get names and schemas. External services may access their configured shared workspace/accounts.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'] },
    async run(args, ctx) {
      if (!ctx.taskId || !getTask(ctx.taskId) || getTask(ctx.taskId)?.mode === 'ask') return { ok: false, content: 'An execution task is required' };
      const name = typeof args.name === 'string' ? args.name : '';
      if (!registry.get(name)?.integration || !effectiveIntegrationGrants(ctx.taskId, getTask(ctx.taskId)?.agentId ?? null).includes(name)) return { ok: false, content: 'Integration not enabled for this task. Ask the user to enable it in Services > Integrations.' };
      if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) return { ok: false, content: 'arguments must be an object' };
      if (!ctx.cfg.policy.networkEnabled) return { ok: false, content: 'External integrations are disabled by network policy' };
      ctx.signal?.throwIfAborted();
      // Preserve task-mode hook policy; do not re-enter the unrestricted registry's lifecycle hooks.
      return registry.get(name)!.run(args.arguments as Record<string, unknown>, ctx);
    },
  }];
}
