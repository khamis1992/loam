import { FileText, Presentation, Table2, Video, Image, FileCode, File, ExternalLink } from 'lucide-react';
import { formatBytes } from '@/utils/format';
import { t } from '@/i18n/t';
import { getApiBase } from '@/services/rpc';

export type AttachmentKind = 'doc' | 'slide' | 'sheet' | 'video' | 'image' | 'svg' | 'file';

export interface AttachmentCardProps {
  name: string;
  kind?: AttachmentKind;
  mime?: string;
  size?: number;
  taskId?: string;
  path?: string;
  onOpen?: () => void;
}

export function kindFromName(name: string): AttachmentKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['docx', 'doc', 'pdf', 'txt', 'md'].includes(ext)) return 'doc';
  if (['pptx', 'ppt'].includes(ext)) return 'slide';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'sheet';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  return 'file';
}

export function kindLabel(kind: AttachmentKind): string {
  switch (kind) {
    case 'doc': return t('Document');
    case 'slide': return t('Slide');
    case 'sheet': return t('Spreadsheet');
    case 'video': return t('Video');
    case 'image': return t('Image');
    case 'svg': return 'SVG';
    default: return t('File');
  }
}

function iconForKind(kind: AttachmentKind) {
  const className = 'size-5 text-white';
  const wrapper = 'flex size-9 shrink-0 items-center justify-center rounded-lg';
  switch (kind) {
    case 'doc':
      return (
        <div className={`${wrapper} bg-[#0081f2]`}>
          <FileText className={className} />
        </div>
      );
    case 'slide':
      return (
        <div className={`${wrapper} bg-[#f59e0b]`}>
          <Presentation className={className} />
        </div>
      );
    case 'sheet':
      return (
        <div className={`${wrapper} bg-[#10b981]`}>
          <Table2 className={className} />
        </div>
      );
    case 'video':
      return (
        <div className={`${wrapper} bg-[#8b5cf6]`}>
          <Video className={className} />
        </div>
      );
    case 'image':
      return (
        <div className={`${wrapper} bg-[#ec4899]`}>
          <Image className={className} />
        </div>
      );
    case 'svg':
      return (
        <div className={`${wrapper} bg-[#14b8a6]`}>
          <FileCode className={className} />
        </div>
      );
    default:
      return (
        <div className={`${wrapper} bg-text-tertiary`}>
          <File className={className} />
        </div>
      );
  }
}

export function mediaUrl(taskId: string, path: string): string {
  const params = new URLSearchParams({ taskId, path });
  return `${getApiBase()}/api/media?${params.toString()}`;
}

export function AttachmentCard({ name, kind, size, taskId, path, onOpen }: AttachmentCardProps) {
  const resolvedKind = kind ?? kindFromName(name);
  const handleOpen = () => {
    if (onOpen) {
      onOpen();
      return;
    }
    if (taskId && path) {
      window.open(mediaUrl(taskId, path), '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-card border border-border-main bg-bg-menu p-3">
      {iconForKind(resolvedKind)}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">{name}</p>
        <p className="text-xs text-text-tertiary">
          {kindLabel(resolvedKind)}
          {size !== undefined && ` · ${formatBytes(size)}`}
        </p>
      </div>
      <button
        type="button"
        onClick={handleOpen}
        disabled={!onOpen && !(taskId && path)}
        className="flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-text-secondary hover:bg-fill-hover disabled:opacity-50"
      >
        <ExternalLink className="size-3.5" />
        {t('Open')}
      </button>
    </div>
  );
}
