import { isDesktop } from '@/services/desktopApis';

export function TitleBar({ children }: { children?: React.ReactNode }) {
  return (
    <header
      className="flex h-titlebar shrink-0 items-center gap-1 pe-2"
      style={{ paddingInlineStart: isDesktop() ? 80 : 8, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {children}
      </div>
    </header>
  );
}
