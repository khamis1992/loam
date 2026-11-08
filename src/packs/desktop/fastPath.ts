import type { Config } from '../../config.js';
import type { Emit, Usage } from '../../agent/events.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { requireTaskWorkspace } from '../../server/taskWorkspace.js';
import { completePackTask } from '../../tools/finishTools.js';
import type { AppProject } from '../../appbuilder/types.js';
import { desktopTemplateForPrompt, desktopTemplateTitle } from './catalog.js';

export function desktopTemplateRequest(prompt: string, mode: string): boolean {
  return mode === 'build' && desktopTemplateForPrompt(prompt) !== undefined;
}

interface DesktopFastPathOptions {
  cfg: Config;
  tools: ToolRegistry;
  emit: Emit;
  prompt: string;
  taskId: string;
  signal?: AbortSignal;
}

export interface DesktopFastPathResult {
  text: string;
  steps: number;
  model: string;
  usage: Usage;
  verified: true;
}

export async function runDesktopFastPath(opts: DesktopFastPathOptions): Promise<DesktopFastPathResult> {
  const template = desktopTemplateForPrompt(opts.prompt);
  if (!template) throw new Error('desktop_template_request_unknown');
  const root = requireTaskWorkspace(opts.taskId, opts.cfg.workspace);
  const usage: Usage = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    opts.emit({ type: 'tool_call', name, args });
    const result = await opts.tools.exec(name, args, {
      cfg: opts.cfg,
      workspace: root,
      emit: opts.emit,
      taskId: opts.taskId,
      packId: 'loam-desktop',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.emit({ type: 'tool_result', name, ok: result.ok, summary: result.content.slice(0, 1200) });
    if (!result.ok) throw new Error(result.content);
    return result.content;
  };

  const initialized = await call('desktop_init', { title: desktopTemplateTitle(template), template, prompt: opts.prompt });
  const project = (JSON.parse(initialized) as { project: AppProject }).project;
  const verification = JSON.parse(await call('desktop_verify', { projectId: project.id })) as { artifact: string };
  const completion = await completePackTask({ cfg: opts.cfg, workspace: root, emit: opts.emit, taskId: opts.taskId, packId: 'loam-desktop', ...(opts.signal ? { signal: opts.signal } : {}) }, [verification.artifact]);
  if (!completion.ok) throw new Error(`desktop_present failed: ${completion.content}`);
  const resourceUri = completion.pack?.ok ? completion.pack.uri : '';
  const text = `Created and verified ${project.title} as a real Electron desktop app.\n\n${verification.artifact}${resourceUri ? `\n\n${resourceUri}` : ''}`;
  opts.emit({ type: 'verify', verdict: 'pass', reason: `${template} passed its real Electron acceptance test and App Builder version snapshot.` });
  opts.emit({ type: 'assistant_message', text });
  opts.emit({ type: 'done', text, steps: 2, model: 'loam-desktop' });
  return { text, steps: 2, model: 'loam-desktop', usage, verified: true };
}
