'use client';

import type { ComponentType } from 'react';
import { Eye, FileText, Folder, FolderOpen, Globe, Monitor, Palette, Search, Terminal } from 'lucide-react';

/** M3: one icon vocabulary for tool families, shared by the chat tool rows
 *  and the computer panel tabs so a tool looks the same in both places. */

export type ToolFamily = 'terminal' | 'editor' | 'browser' | 'preview' | 'files' | 'studio' | 'workspace' | 'live';

export type StudioMode = 'media' | 'office';

export function getStudioMode(tool: string): StudioMode | null {
  const name = tool.toLowerCase();
  if (
    name.startsWith('creative_') ||
    name === 'loam_creative' ||
    name === 'loam_canvas'
  )
    return 'media';
  if (
    name.startsWith('office_') ||
    name === 'loam_studio' ||
    name === 'loam_document' ||
    name === 'loam_dataset' ||
    name === 'data_chart'
  )
    return 'office';
  return null;
}

export function getToolFamily(tool: string): ToolFamily {
  const name = tool.toLowerCase();
  if (getStudioMode(tool)) return 'studio';
  if (name === 'terminal' || name.startsWith('shell_') || name.startsWith('pty_')) return 'terminal';
  if (name === 'text_editor' || name.startsWith('file_')) return 'editor';
  if (name.startsWith('browser_') || name === 'browser' || name === 'web_fetch' || name === 'webpage_extract') return 'browser';
  if (name.startsWith('preview_') || name === 'webdev') return 'preview';
  return 'files';
}

export const TOOL_FAMILY_ICONS: Record<ToolFamily, ComponentType<{ className?: string }>> = {
  terminal: Terminal,
  editor: FileText,
  browser: Globe,
  preview: Eye,
  files: Folder,
  studio: Palette,
  workspace: FolderOpen,
  live: Monitor,
};

/** Icon for a tool row: family icon, with search tools getting the magnifier
 *  even though search is not a panel tab. */
export function toolFamilyIcon(tool: string): ComponentType<{ className?: string }> {
  const name = tool.toLowerCase();
  if (name.startsWith('search') || name.startsWith('web_search') || name.includes('_search')) return Search;
  return TOOL_FAMILY_ICONS[getToolFamily(tool)];
}
