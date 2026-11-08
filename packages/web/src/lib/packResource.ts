import type { WorkspaceOpenTarget } from '@/components/workspace/autoOpen';
import { mediaUrl } from '@/components/chat/AttachmentCard';
import { craftAppForExtension } from '@/components/workspace/craft';

export interface PackResource {
  packId: string;
  kind: string;
  projectId: string;
}

export function parsePackResource(value: string): PackResource | null {
  const match = /^loam-resource:\/\/(loam-[a-z-]+)\/([a-z-]+)\/([^/?#]+)$/.exec(value.trim());
  if (!match) return null;
  const packId = match[1]!;
  const kind = match[2]!;
  const projectId = decodeURIComponent(match[3]!);
  if (!projectId) return null;
  return { packId, kind, projectId };
}

export function packResourceTarget(resource: PackResource, path: string): WorkspaceOpenTarget | null {
  if (resource.packId === 'loam-slides') return { kind: 'craft', craftApp: 'slides', path };
  if (resource.packId === 'loam-video') return { kind: 'loam-video', path };
  if (resource.packId === 'loam-desktop') return { kind: 'electron-window', path };
  if (resource.packId === 'loam-image') return { kind: 'craft', craftApp: 'photo', path };
  if (resource.packId === 'loam-localfile' || resource.packId === 'loam-office') {
    const craftApp = craftAppForExtension(path.split('.').pop() ?? '');
    if (craftApp) return { kind: 'craft', craftApp, path };
    if (/\.(?:md|markdown|txt|json|csv|html?|css|jsx?|tsx?|xml|ya?ml)$/i.test(path)) return { kind: 'doc', path };
  }
  return null;
}

export function packResourceMediaUrl(resource: PackResource, path: string): string {
  return mediaUrl(resource.projectId, path);
}
