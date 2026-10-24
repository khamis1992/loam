import { describe, it, expect } from 'vitest';

import {
  getToolLabel,
  humanizeToolName,
  sentenceFromToolName,
  summarizeTools,
  isCorruptedPlaceholder,
} from '../toolLabels';
import type { ToolUsedEvent } from '@shared/socket';

function toolEvent(tool: string): ToolUsedEvent {
  return {
    id: 'e1',
    type: 'toolUsed',
    timestamp: 0,
    tool: tool as ToolUsedEvent['tool'],
    actionId: 'a1',
    status: 'success',
  };
}

describe('tool humanizer', () => {
  it('maps file tools to clean past-tense labels', () => {
    expect(humanizeToolName('file_write')).toBe('Wrote file');
    expect(humanizeToolName('file_edit')).toBe('Edited file');
    expect(humanizeToolName('file_read')).toBe('Read file');
  });

  it('maps model-native capitalized tool names', () => {
    expect(humanizeToolName('Write')).toBe('Wrote file');
    expect(humanizeToolName('Edit')).toBe('Edited file');
    expect(humanizeToolName('Bash')).toBe('Ran command');
  });

  it('maps scratchpad and schedule tools', () => {
    expect(humanizeToolName('scratchpad_add')).toBe('Added to-do');
    expect(humanizeToolName('scratchpad_list')).toBe('Listed to-dos');
    expect(humanizeToolName('schedule_create')).toBe('Scheduled routine');
    expect(humanizeToolName('schedule_delete')).toBe('Deleted routine');
  });

  it('maps office tools to document labels', () => {
    expect(humanizeToolName('office_craft')).toBe('Edited file');
    expect(humanizeToolName('office_import')).toBe('Imported document');
    expect(humanizeToolName('office_export')).toBe('Exported document');
    expect(humanizeToolName('office_status')).toBe('Checked document');
  });

  it('maps task and memory tools', () => {
    expect(humanizeToolName('task_create')).toBe('Created task');
    expect(humanizeToolName('memory_store')).toBe('Saved memory');
    expect(humanizeToolName('integration_call')).toBe('Called integration');
  });

  it('falls back to a sentence-cased snake_case label', () => {
    expect(getToolLabel('custom_widget_mounter').noun).toBe('');
    expect(humanizeToolName('custom_widget_mounter')).toBe('Custom widget mounter');
  });

  it('never repeats a word in the fallback sentence', () => {
    expect(sentenceFromToolName('run_run_report')).toBe('Run report');
    expect(humanizeToolName('browser_browser_thing')).toBe('Browser thing');
  });

  it('summarizes several tools with distinct labels', () => {
    expect(summarizeTools([toolEvent('file_write'), toolEvent('file_write'), toolEvent('scratchpad_add')]))
      .toBe('Wrote 2 files · Added 1 to-do');
  });

  it('flags lossy question-mark placeholder text', () => {
    expect(isCorruptedPlaceholder('?????')).toBe(true);
    expect(isCorruptedPlaceholder(' ? ? ')).toBe(true);
    expect(isCorruptedPlaceholder('مهمة')).toBe(false);
    expect(isCorruptedPlaceholder('')).toBe(false);
  });
});
