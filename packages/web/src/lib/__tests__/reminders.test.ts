import { describe, it, expect } from 'vitest';
import { isReminderContent, isReminderMessage, visibleMessages } from '../reminders';

describe('web reminder hiding', () => {
  it('recognises a tagged reminder block', () => {
    expect(isReminderContent('<system-reminder>\nhidden\n</system-reminder>')).toBe(true);
    expect(isReminderContent('a normal message')).toBe(false);
  });

  it('only treats user-role tagged blocks as reminders', () => {
    expect(isReminderMessage({ role: 'user', content: '<system-reminder>\nx\n</system-reminder>' })).toBe(true);
    expect(isReminderMessage({ role: 'assistant', content: '<system-reminder>\nx\n</system-reminder>' })).toBe(false);
  });

  it('filters reminders out of a rendered transcript', () => {
    const reminder = { role: 'user', content: '<system-reminder>\nx\n</system-reminder>' };
    const user = { role: 'user', content: 'visible' };
    const assistant = { role: 'assistant', content: 'also visible' };
    expect(visibleMessages([user, reminder, assistant])).toEqual([user, assistant]);
  });
});
