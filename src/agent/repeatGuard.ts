/**
 * Stops a run from calling the same failing tool with the same arguments
 * after that call said retry:false. A later successful call, or a new run,
 * clears the block.
 */
const blocked = new Map<string, Set<string>>();

function taskKey(taskId: string | undefined): string {
  return taskId && taskId.trim() ? taskId : "_";
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = stable(record[key]);
    return out;
  }
  return value;
}

export function toolFingerprint(name: string, args: unknown): string {
  return `${name}\n${JSON.stringify(stable(args))}`;
}

function retryFalse(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { retry?: unknown };
    if (parsed && typeof parsed === "object" && parsed.retry === false) return true;
  } catch {
    /* plain text */
  }
  return /"retry"\s*:\s*false/.test(content);
}

export function repeatBlockReason(taskId: string | undefined, name: string, args: unknown): string | null {
  const set = blocked.get(taskKey(taskId));
  if (!set?.has(toolFingerprint(name, args))) return null;
  return `Blocked: ${name} already failed with retry:false for these arguments. Use the alternative named in that result (loam_studio, office_export, or office_craft with fallback:true). Do not call it again unchanged.`;
}

export function noteToolOutcome(taskId: string | undefined, name: string, args: unknown, ok: boolean, content: string): void {
  const id = taskKey(taskId);
  const fp = toolFingerprint(name, args);
  const set = blocked.get(id) ?? new Set<string>();
  if (ok) {
    if (set.has(fp)) set.delete(fp);
    else set.clear();
    if (set.size === 0) blocked.delete(id);
    else blocked.set(id, set);
    return;
  }
  if (retryFalse(content)) {
    set.add(fp);
    blocked.set(id, set);
  }
}

export function clearRepeatBlocks(taskId?: string): void {
  if (taskId) blocked.delete(taskKey(taskId));
  else blocked.clear();
}
