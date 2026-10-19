import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OfflineBanner } from './OfflineBanner.js';
import * as useOnlineModule from '../../hooks/useOnline.js';

describe('OfflineBanner', () => {
  beforeEach(() => {
    vi.spyOn(useOnlineModule, 'useOnline').mockReturnValue({
      online: false,
      showBanner: true,
      wasOffline: true,
      retry: () => {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the offline toast in English', () => {
    document.documentElement.lang = 'en';
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent("You're offline. Reconnecting…");
  });

  it('renders the offline toast in Arabic', () => {
    document.documentElement.lang = 'ar';
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('أنت غير متصل. جارٍ إعادة الاتصال…');
  });

  it('returns null when not offline long enough', () => {
    vi.spyOn(useOnlineModule, 'useOnline').mockReturnValue({
      online: true,
      showBanner: false,
      wasOffline: false,
      retry: () => {},
    });
    const { container } = render(<OfflineBanner />);
    expect(container.firstChild).toBeNull();
  });
});
