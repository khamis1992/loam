import { renderHook } from '@testing-library/react';
import { useConversationAutoScroll } from '../useConversationAutoScroll';

describe('useConversationAutoScroll', () => {
  it('scrolls to the latest message on mount and while events stream', () => {
    const conversation = document.createElement('div');
    let scrollHeight = 480;
    Object.defineProperty(conversation, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    const conversationRef = { current: conversation };
    const firstEvent = { id: 'first' };

    const { rerender } = renderHook(
      ({ events }) => useConversationAutoScroll(conversationRef, events),
      { initialProps: { events: [firstEvent] } },
    );

    expect(conversation.scrollTop).toBe(480);

    conversation.scrollTop = 120;
    scrollHeight = 960;
    rerender({ events: [firstEvent, { id: 'latest' }] });

    expect(conversation.scrollTop).toBe(960);
  });
});
