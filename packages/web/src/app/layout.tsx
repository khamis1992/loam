import type { Metadata, Viewport } from 'next';
import { StoreProvider } from '@/store';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Agent Studio',
  description: 'Desktop AI agent workspace',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f8f8f7',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      className="light is-desktop"
      data-accent-color="default"
      data-interface-density="compact"
      style={{ '--ui-font-scale': '1' } as React.CSSProperties}
    >
      <body className="min-h-screen overflow-hidden">
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
