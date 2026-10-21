'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import {
  Archive,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Info,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { t } from '@/i18n/t';

interface AgentContextMenuProps {
  x: number;
  y: number;
  agentName: string;
  pinned?: boolean;
  hidden?: boolean;
  onOpen?: () => void;
  onInfo?: () => void;
  onRename?: () => void;
  onTogglePin?: () => void;
  onToggleHide?: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 200;
const MENU_HEIGHT = 380;

/**
 * Context menu for agent rows and the info pane header.
 * Pin/Hide currently close without action until their owning streams wire them.
 */
export function AgentContextMenu({
  x,
  y,
  agentName,
  pinned,
  hidden,
  onOpen,
  onInfo,
  onRename,
  onTogglePin,
  onToggleHide,
  onEdit,
  onDuplicate,
  onArchive,
  onDelete,
  onClose,
}: AgentContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (action?: () => void) => {
    onClose();
    action?.();
  };

  const confirmDelete = () => {
    onClose();
    if (window.confirm(t('Delete {name} permanently? This cannot be undone.', { name: agentName }))) {
      onDelete?.();
    }
  };

  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8));

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] max-w-[240px] rounded-card border border-border-main bg-bg-menu py-1 shadow-menu"
      style={{ left, top }}
    >
      {onOpen && (
        <Item icon={<ExternalLink className="size-4" />} label={t('Open')} onClick={() => run(onOpen)} />
      )}
      {onInfo && (
        <Item icon={<Info className="size-4" />} label={t('Info')} onClick={() => run(onInfo)} />
      )}
      {onRename && (
        <Item icon={<Pencil className="size-4" />} label={t('Rename')} onClick={() => run(onRename)} />
      )}
      <Item
        icon={pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        label={pinned ? t('Unpin') : t('Pin')}
        onClick={() => run(onTogglePin)}
      />
      <Item
        icon={hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
        label={hidden ? t('Unhide') : t('Hide')}
        onClick={() => run(onToggleHide)}
      />
      {(onEdit || onDuplicate || onArchive) && <div className="my-1 border-t border-border-main" />}
      {onEdit && (
        <Item icon={<Pencil className="size-4" />} label={t('Edit')} onClick={() => run(onEdit)} />
      )}
      {onDuplicate && (
        <Item icon={<Copy className="size-4" />} label={t('Duplicate')} onClick={() => run(onDuplicate)} />
      )}
      {onArchive && (
        <Item icon={<Archive className="size-4" />} label={t('Archive')} onClick={() => run(onArchive)} />
      )}
      {onDelete && (
        <>
          <div className="my-1 border-t border-border-main" />
          <Item
            icon={<Trash2 className="size-4" />}
            label={t('Delete')}
            className="text-function-error"
            onClick={confirmDelete}
          />
        </>
      )}
    </div>
  );
}

function Item({ icon, label, onClick, className }: { icon: ReactNode; label: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={['flex w-full items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-fill-hover', className ?? ''].join(' ')}
    >
      <span className="text-text-secondary">{icon}</span>
      {label}
    </button>
  );
}
