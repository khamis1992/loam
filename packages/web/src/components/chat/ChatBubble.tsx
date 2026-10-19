import type { ChatMessageEvent } from '@shared/socket';
import { AttachmentChip } from './AttachmentChip';

export function UserBubble({ event }: { event: ChatMessageEvent }) {
  return (
    <div className="ms-auto flex max-w-[80%] flex-col items-end gap-2">
      {event.attachments.map((a) => (
        <AttachmentChip key={a.id} name={a.filename} kind={a.contentType} size={a.contentLength} />
      ))}
      <div className="rounded-card border border-border-main bg-bg-menu px-3 py-2 text-base text-text-primary">
        {event.content}
      </div>
    </div>
  );
}
