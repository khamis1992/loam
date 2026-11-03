import type { ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { Spinner } from '@/components/ui/Button';
import { humanizeToolName, isCorruptedPlaceholder } from './toolLabels';
import { toolFamilyIcon } from './toolIcons';

function StatusIcon({ s }: { s: ToolUsedEvent['status'] }) {
  if (s === 'running' || s === 'pending' || s === 'streaming' || s === 'argumentsFinished') return <Spinner className="size-3.5" />;
  const glyph = { success: '✓', error: '✕', failed: '✕', cancelled: '◼', stopped: '◼', rollback: '↶' }[s] ?? '•';
  return <span aria-label={s} className={s === 'success' ? 'text-func-success' : 'text-text-tertiary'}>{glyph}</span>;
}

function briefDuplicatesLabel(tool: string, brief: string): boolean {
  if (isCorruptedPlaceholder(brief)) return true;
  const label = t(humanizeToolName(tool)).toLowerCase();
  const raw = tool.toLowerCase();
  const value = brief.trim().toLowerCase();
  if (!value) return true;
  if (value === raw || value.replace(/[ _-]/g, '') === raw.replace(/_/g, '')) return true;
  const labelWords = new Set(label.split(/\s+/).filter(Boolean));
  // Also count every word of the raw tool name (e.g. "edit", "write", "add")
  // as label vocabulary so a brief that merely repeats the tool verb/spec is
  // suppressed instead of surfacing "Edited file Write"-style rows.
  for (const token of raw.split(/[^a-z0-9]+/)) {
    if (token) labelWords.add(token);
  }
  const briefWords = value.split(/[^a-z0-9]+/).filter(Boolean);
  return briefWords.length > 0 && briefWords.every((word) => labelWords.has(word) || GENERIC_TOOL_WORDS.has(word));
}

/** Words so generic that repeating them next to the humanized label adds nothing. */
const GENERIC_TOOL_WORDS = new Set(['write', 'edit', 'read', 'run', 'file', 'command']);

export function ToolUsedRow({ e }: { e: ToolUsedEvent }) {
  const commands = e.detail?.suggestion?.commands;
  if (e.tool === 'suggestion' && commands && commands.length > 0) {
    return (
      <div className="flex flex-col">
        {commands.map((c, i) => (
          <button key={i} className="flex h-9 items-center gap-2 border-b border-border-main px-2 text-sm text-text-secondary hover:bg-fill-tsp">
            <span className="text-text-tertiary">💬</span> {c.content}
            <span className="ms-auto">→</span>
          </button>
        ))}
      </div>
    );
  }
  const showBrief = e.brief && !briefDuplicatesLabel(e.tool, e.brief);
  const FamilyIcon = toolFamilyIcon(e.tool);
  return (
    <div className="flex h-row-sm w-full items-center gap-2 rounded-control bg-fill-tsp px-2 text-start text-sm text-text-secondary hover:bg-fill-hover"
    >
      <FamilyIcon className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
      <span className="truncate">{t(humanizeToolName(e.tool))} {showBrief && <code className="text-xs">{e.brief}</code>}</span>
      <span className="ms-auto"><StatusIcon s={e.status} /></span>
    </div>
  );
}
