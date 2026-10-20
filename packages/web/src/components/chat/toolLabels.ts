import type { ToolUsedEvent } from '@shared/socket';

export interface ToolLabel {
  verb: string;
  noun: string;
}

const TOOL_LABEL: Record<string, ToolLabel> = {
  file_stat: { verb: 'Read', noun: 'file' },
  file_read: { verb: 'Read', noun: 'file' },
  file_write: { verb: 'Wrote', noun: 'file' },
  file_edit: { verb: 'Edited', noun: 'file' },
  file_search: { verb: 'Searched', noun: 'file' },
  file_list: { verb: 'Listed', noun: 'file' },
  shell_run: { verb: 'Ran', noun: 'command' },
  shell: { verb: 'Ran', noun: 'command' },
  terminal: { verb: 'Ran', noun: 'command' },
  pty_run: { verb: 'Ran', noun: 'command' },
  web_fetch: { verb: 'Fetched', noun: 'page' },
  web_search: { verb: 'Searched', noun: 'query' },
  browser_navigate: { verb: 'Opened', noun: 'browser' },
  browser_open: { verb: 'Opened', noun: 'browser' },
  browser_goto: { verb: 'Opened', noun: 'browser' },
  browser_screenshot: { verb: 'Captured', noun: 'screenshot' },
  browser_click: { verb: 'Clicked', noun: 'element' },
  browser_type: { verb: 'Typed', noun: 'text' },
  browser_eval: { verb: 'Evaluated', noun: 'script' },
  browser_table: { verb: 'Read', noun: 'page' },
  browser_snapshot: { verb: 'Read', noun: 'page' },
  browser_act: { verb: 'Acted', noun: 'action' },
  browser_pages: { verb: 'Listed', noun: 'page' },
  browser_close: { verb: 'Closed', noun: 'browser' },
  browser_trace_start: { verb: 'Started', noun: 'trace' },
  browser_trace_stop: { verb: 'Stopped', noun: 'trace' },
  browser_trace_status: { verb: 'Checked', noun: 'trace' },
  browser_som: { verb: 'Marked', noun: 'page' },
  search: { verb: 'Searched', noun: 'query' },
  text_editor: { verb: 'Edited', noun: 'file' },
  webpage_extract: { verb: 'Extracted', noun: 'page' },
  webdev: { verb: 'Built', noun: 'website' },
  preview_serve: { verb: 'Started', noun: 'preview' },
  preview_status: { verb: 'Checked', noun: 'preview' },
  preview_stop: { verb: 'Stopped', noun: 'preview' },
  mcp: { verb: 'Used', noun: 'tool' },
  suggestion: { verb: 'Suggested', noun: 'follow-up' },
  map_reduce: { verb: 'Ran', noun: 'parallel subtask' },
};

export function getToolLabel(tool: string): ToolLabel {
  return TOOL_LABEL[tool] ?? TOOL_LABEL[tool.replace(/^\w+_/, '')] ?? { verb: tool.replace(/_/g, ' '), noun: 'time' };
}

export function humanizeToolName(tool: string): string {
  const label = getToolLabel(tool);
  return `${label.verb} ${label.noun}`;
}

export function pluralizeNoun(noun: string, count: number): string {
  if (count === 1) return noun;
  if (noun.endsWith('y') && !/[aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/s$|x$|z$|ch$|sh$/i.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

export function formatToolSummary(tool: string, count: number): string {
  const label = getToolLabel(tool);
  return formatToolSummaryByLabel(label, count);
}

export function formatToolSummaryByLabel(label: ToolLabel, count: number): string {
  return `${label.verb} ${count} ${pluralizeNoun(label.noun, count)}`;
}

export function summarizeTools(events: ToolUsedEvent[]): string {
  const counts = new Map<string, { label: ToolLabel; count: number }>();
  for (const e of events) {
    if (e.tool === 'suggestion') continue;
    const label = getToolLabel(e.tool);
    const key = `${label.verb}-${label.noun}`;
    const entry = counts.get(key) ?? { label, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return Array.from(counts.values())
    .map((e) => formatToolSummaryByLabel(e.label, e.count))
    .join(' · ');
}
