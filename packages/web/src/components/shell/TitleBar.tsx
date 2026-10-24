'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { PanelLeft, ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { isDesktop } from '@/services/desktopApis';
import { useAppDispatch } from '@/store';
import { toggleSidebar } from '@/store';
import { t } from '@/i18n/t';
import { SearchDialog } from '@/components/dialogs/SearchDialog';

export function TitleBar({ children }: { children?: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = usePathname();
  const [nav, setNav] = useState({ back: true, forward: true });
  useEffect(() => {
    // Navigation API where available; otherwise leave both buttons enabled.
    const n = (window as unknown as { navigation?: { canGoBack: boolean; canGoForward: boolean } }).navigation;
    if (n) setNav({ back: n.canGoBack, forward: n.canGoForward });
  }, [pathname]);
  return (
    <header
      className="flex h-titlebar shrink-0 items-center gap-1 pe-2"
      style={{ paddingInlineStart: isDesktop() ? 80 : 12, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          aria-label={t('Toggle sidebar')}
          title={t('Toggle sidebar')}
          onClick={() => dispatch(toggleSidebar())}
          className="flex h-7 w-7 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover"
        >
          <PanelLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t('Back')}
          title={t('Back')}
          disabled={!nav.back}
          onClick={() => window.history.back()}
          className="flex h-7 w-7 items-center justify-center rounded-control text-text-tertiary hover:bg-fill-hover disabled:opacity-30"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t('Forward')}
          title={t('Forward')}
          disabled={!nav.forward}
          onClick={() => window.history.forward()}
          className="flex h-7 w-7 items-center justify-center rounded-control text-text-tertiary hover:bg-fill-hover disabled:opacity-30"
        >
          <ArrowRight className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t('Search')}
          title={t('Search')}
          onClick={() => setSearchOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-control text-text-tertiary hover:bg-fill-hover"
        >
          <Search className="size-4" />
        </button>
        {children}
      </div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
