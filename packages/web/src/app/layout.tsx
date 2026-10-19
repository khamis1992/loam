import type { Metadata } from 'next';
import { Providers } from './providers';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Agent Studio',
  description: 'Desktop AI agent workspace',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" className="light is-desktop" data-interface-density="compact"
      data-accent-color="default"
    >
      <body className="h-screen w-screen overflow-hidden">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
