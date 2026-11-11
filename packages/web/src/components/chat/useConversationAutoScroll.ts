import { useEffect, type RefObject } from 'react';

export function useConversationAutoScroll(
  conversationRef: RefObject<HTMLDivElement | null>,
  events: readonly unknown[],
) {
  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    conversation.scrollTop = conversation.scrollHeight;
  }, [conversationRef, events]);
}
