import { FileText } from 'lucide-react';
import { formatBytes } from '@/utils/format';

export function AttachmentChip({ name, kind, size }: { name: string; kind?: string; size?: number }) {
  return (
    <div className="flex h-12 w-[240px] items-center gap-2 rounded-card border border-border-main bg-bg-menu px-2">
      <div className="flex size-7 shrink-0 items-center justify-center rounded bg-[#0081f2] text-white">
        <FileText className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">{name}</p>
        <p className="text-xs text-text-tertiary">{kind || 'Text'}{size !== undefined && ` · ${formatBytes(size)}`}</p>
      </div>
    </div>
  );
}
