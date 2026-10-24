import type { ToolUsedEvent } from '@shared/socket';
import { isCorruptedPlaceholder } from '../../utils/placeholders';

export interface ToolLabel {
  verb: string;
  noun: string;
}

const doc = { verb: 'Edited', noun: 'document' };

/** Clean human labels for every known tool. Keys cover Loam tools plus the
 *  capitalized model-native names that some backends surface directly. */
const TOOL_LABEL: Record<string, ToolLabel> = {
  // Files
  file_stat: { verb: 'Read', noun: 'file' },
  file_read: { verb: 'Read', noun: 'file' },
  file_write: { verb: 'Wrote', noun: 'file' },
  file_edit: { verb: 'Edited', noun: 'file' },
  file_search: { verb: 'Searched', noun: 'file' },
  file_list: { verb: 'Listed', noun: 'file' },
  file_mkdir: { verb: 'Created', noun: 'folder' },
  file_move: { verb: 'Moved', noun: 'file' },
  file_delete: { verb: 'Deleted', noun: 'file' },
  file_view_image: { verb: 'Viewed', noun: 'image' },
  file_extract_text: { verb: 'Extracted', noun: 'text' },
  'Write': { verb: 'Wrote', noun: 'file' },
  'Edit': { verb: 'Edited', noun: 'file' },
  'Read': { verb: 'Read', noun: 'file' },
  'NotebookEdit': { verb: 'Edited', noun: 'notebook' },
  text_editor: { verb: 'Edited', noun: 'file' },

  // Terminal
  shell_start: { verb: 'Started', noun: 'terminal' },
  shell_write: { verb: 'Ran', noun: 'command' },
  shell_read: { verb: 'Read', noun: 'terminal' },
  shell_list: { verb: 'Listed', noun: 'terminals' },
  shell_kill: { verb: 'Stopped', noun: 'terminal' },
  pty_start: { verb: 'Started', noun: 'terminal' },
  pty_write: { verb: 'Ran', noun: 'command' },
  pty_read: { verb: 'Read', noun: 'terminal' },
  pty_list: { verb: 'Listed', noun: 'terminals' },
  pty_kill: { verb: 'Stopped', noun: 'terminal' },
  shell_run: { verb: 'Ran', noun: 'command' },
  shell: { verb: 'Ran', noun: 'command' },
  terminal: { verb: 'Ran', noun: 'command' },
  pty_run: { verb: 'Ran', noun: 'command' },
  'Bash': { verb: 'Ran', noun: 'command' },

  // Web & browser
  web_fetch: { verb: 'Fetched', noun: 'page' },
  web_search: { verb: 'Searched', noun: 'query' },
  search: { verb: 'Searched', noun: 'query' },
  'WebFetch': { verb: 'Fetched', noun: 'page' },
  'WebSearch': { verb: 'Searched', noun: 'query' },
  'Grep': { verb: 'Searched', noun: 'text' },
  'Glob': { verb: 'Searched', noun: 'files' },
  browser_navigate: { verb: 'Opened', noun: 'browser' },
  browser_open: { verb: 'Opened', noun: 'browser' },
  browser_goto: { verb: 'Opened', noun: 'browser' },
  browser_screenshot: { verb: 'Captured', noun: 'screenshot' },
  browser_click: { verb: 'Clicked', noun: 'element' },
  browser_type: { verb: 'Typed', noun: 'text' },
  browser_press: { verb: 'Pressed', noun: 'key' },
  browser_eval: { verb: 'Evaluated', noun: 'script' },
  browser_table: { verb: 'Read', noun: 'table' },
  browser_snapshot: { verb: 'Read', noun: 'page' },
  browser_act: { verb: 'Acted', noun: 'action' },
  browser_pages: { verb: 'Listed', noun: 'page' },
  browser_close: { verb: 'Closed', noun: 'browser' },
  browser_trace_start: { verb: 'Started', noun: 'trace' },
  browser_trace_stop: { verb: 'Stopped', noun: 'trace' },
  browser_trace_status: { verb: 'Checked', noun: 'trace' },
  browser_som: { verb: 'Marked', noun: 'page' },
  browser: { verb: 'Used', noun: 'browser' },
  webpage_extract: { verb: 'Extracted', noun: 'page' },
  webdev: { verb: 'Built', noun: 'website' },

  // Lists & previews
  preview_serve: { verb: 'Started', noun: 'preview' },
  preview_status: { verb: 'Checked', noun: 'preview' },
  preview_stop: { verb: 'Stopped', noun: 'preview' },
  preview_screenshot: { verb: 'Captured', noun: 'screenshots' },

  // Routine & task management
  schedule_create: { verb: 'Scheduled', noun: 'routine' },
  schedule_list: { verb: 'Listed', noun: 'routines' },
  schedule_delete: { verb: 'Deleted', noun: 'routine' },
  watch_create: { verb: 'Started', noun: 'watch' },
  watch_list: { verb: 'Listed', noun: 'watches' },
  task_create: { verb: 'Created', noun: 'task' },
  task_list: { verb: 'Listed', noun: 'tasks' },
  task_get: { verb: 'Checked', noun: 'task' },
  task_cancel: { verb: 'Cancelled', noun: 'task' },

  // Scratchpad
  scratchpad_add: { verb: 'Added', noun: 'to-do' },
  scratchpad_complete: { verb: 'Completed', noun: 'to-do' },
  scratchpad_list: { verb: 'Listed', noun: 'to-dos' },

  // Craft editors: office_craft drives Loam Docs / Loam Sheets / Loam Slides /
  // Loam Photo / Loam Design live in the Workspace panel, so the label names the
  // file rather than one document type.
  office_craft: { verb: 'Edited', noun: 'file' },
  office_import: { verb: 'Imported', noun: 'document' },
  office_export: { verb: 'Exported', noun: 'document' },
  office_status: { verb: 'Checked', noun: 'document' },
  loam_document: doc,
  loam_studio: { verb: 'Edited', noun: 'design' },
  loam_dataset: { verb: 'Edited', noun: 'spreadsheet' },
  loam_creative: { verb: 'Generated', noun: 'media' },
  loam_canvas: { verb: 'Painted', noun: 'canvas' },
  loam_mobile: { verb: 'Built', noun: 'mobile app' },
  rork_build: { verb: 'Built', noun: 'app' },
  rork_from_web: { verb: 'Cloned', noun: 'app' },
  lovable_studio: { verb: 'Edited', noun: 'app' },
  creative_export: { verb: 'Exported', noun: 'media' },
  creative_export_status: { verb: 'Checked', noun: 'export' },
  creative_export_result: { verb: 'Fetched', noun: 'export result' },
  creative_timeline: { verb: 'Read', noun: 'timeline' },
  creative_image: { verb: 'Generated', noun: 'image' },

  // Generators & search (N12)
  gen_3d_from_image: { verb: 'Generated', noun: '3D model' },
  gen_music: { verb: 'Composed', noun: 'music' },
  generate_storyboard: { verb: 'Planned', noun: 'storyboard' },
  solve_logic: { verb: 'Solved', noun: 'problem' },
  search_images: { verb: 'Searched', noun: 'images' },
  search_x: { verb: 'Searched', noun: 'posts' },

  // Memory & knowledge
  memory_store: { verb: 'Saved', noun: 'memory' },
  memory_search: { verb: 'Searched', noun: 'memory' },
  memory_list: { verb: 'Listed', noun: 'memories' },
  memory_delete: { verb: 'Deleted', noun: 'memory' },
  session_search: { verb: 'Searched', noun: 'sessions' },
  companion_memory_save: { verb: 'Saved', noun: 'note' },
  companion_memory_search: { verb: 'Searched', noun: 'notes' },
  companion_memory_list: { verb: 'Listed', noun: 'notes' },

  // Device & host control
  device_exec: { verb: 'Ran', noun: 'device command' },
  device_read_file: { verb: 'Read', noun: 'device file' },
  device_write_file: { verb: 'Wrote', noun: 'device file' },
  device_list_files: { verb: 'Listed', noun: 'device files' },
  device_pull_file: { verb: 'Pulled', noun: 'device file' },
  device_push_file: { verb: 'Pushed', noun: 'device file' },
  device_write_secret: { verb: 'Saved', noun: 'device secret' },
  computer_screenshot: { verb: 'Captured', noun: 'screen' },
  computer_list_windows: { verb: 'Listed', noun: 'windows' },
  computer_focus_window: { verb: 'Focused', noun: 'window' },
  computer_ui_tree: { verb: 'Read', noun: 'UI tree' },
  computer_ui_list: { verb: 'Read', noun: 'UI list' },
  computer_ui_click: { verb: 'Clicked', noun: 'control' },
  computer_ui_set_text: { verb: 'Typed', noun: 'text' },
  computer_click: { verb: 'Clicked', noun: 'control' },
  computer_type: { verb: 'Typed', noun: 'text' },
  computer_key: { verb: 'Pressed', noun: 'key' },
  screen_look: { verb: 'Captured', noun: 'screen' },
  screen_watch: { verb: 'Watched', noun: 'screen' },
  screen_stream_start: { verb: 'Started', noun: 'screen stream' },
  screen_stream_status: { verb: 'Checked', noun: 'screen stream' },
  screen_stream_stop: { verb: 'Stopped', noun: 'screen stream' },

  // Security
  pentest_check: { verb: 'Ran', noun: 'security check' },
  pentest_routes: { verb: 'Mapped', noun: 'routes' },
  pentest_report: { verb: 'Reported', noun: 'findings' },
  security_assess: { verb: 'Started', noun: 'security assessment' },
  security_status: { verb: 'Checked', noun: 'assessment' },

  // Skills
  skill_create: { verb: 'Created', noun: 'skill' },
  skill_delete: { verb: 'Deleted', noun: 'skill' },
  skill_install: { verb: 'Installed', noun: 'skill' },
  skill_list: { verb: 'Listed', noun: 'skills' },
  skill_patch: { verb: 'Updated', noun: 'skill' },
  skill_search: { verb: 'Searched', noun: 'skills' },
  skill_view: { verb: 'Read', noun: 'skill' },

  // Companions & swarms
  companion_delegate: { verb: 'Delegated', noun: 'work' },
  companion_delegations: { verb: 'Checked', noun: 'delegations' },
  companion_learn_skill: { verb: 'Captured', noun: 'skill' },
  subagent_list: { verb: 'Listed', noun: 'subagents' },
  delegate_subagent: { verb: 'Delegated', noun: 'subtask' },
  super_swarm: { verb: 'Ran', noun: 'agent swarm' },
  super_quality_gate: { verb: 'Checked', noun: 'quality gate' },
  super_time_travel: { verb: 'Replayed', noun: 'timeline' },
  metagpt_company: { verb: 'Ran', noun: 'virtual team' },
  mirofish_chat: { verb: 'Sent', noun: 'chat message' },

  // Integrations & misc
  integration_list: { verb: 'Listed', noun: 'integrations' },
  integration_call: { verb: 'Called', noun: 'integration' },
  mcp: { verb: 'Used', noun: 'tool' },
  suggestion: { verb: 'Suggested', noun: 'follow-up' },
  map_reduce: { verb: 'Ran', noun: 'parallel subtask' },
};

/** Words that are verbs or placeholders on their own; a brief made only of
 *  these carries no information beyond the humanized label. */
const GENERIC_BRIEF_WORDS = new Set([
  'file', 'files', 'folder', 'page', 'text', 'query', 'command', 'tool',
  'browser', 'element', 'action', 'memory', 'task', 'tasks', 'write',
  'edit', 'read', 'run', 'list', 'add', 'create', 'delete', 'update',
  'check', 'search', 'open', 'close',
]);

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** snake_case / camelCase / random tool id -> human sentence ("scratchpad_add"
 *  -> "Scratchpad add"), collapsing duplicate words so a verb never repeats. */
export function sentenceFromToolName(tool: string): string {
  const words = tool
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() && w.length <= 3 ? w : w.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  if (out.length === 0) return tool;
  return [capitalize(out[0]), ...out.slice(1)].join(' ');
}

export function getToolLabel(tool: string): ToolLabel {
  const direct = TOOL_LABEL[tool];
  if (direct) return direct;
  const stripped = tool.replace(/^\w+_/, '');
  const strippedMatch = stripped ? TOOL_LABEL[stripped] : undefined;
  if (strippedMatch) return strippedMatch;
  return { verb: sentenceFromToolName(tool), noun: '' };
}

export function humanizeToolName(tool: string): string {
  const label = getToolLabel(tool);
  if (!label.noun) return label.verb;
  return `${label.verb} ${label.noun}`;
}

export function pluralizeNoun(noun: string, count: number): string {
  if (!noun) return '';
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
  if (!label.noun) return `${label.verb} ${count}`;
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

export { isCorruptedPlaceholder };
