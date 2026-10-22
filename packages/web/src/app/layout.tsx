import type { Metadata } from 'next';
import { StoreProvider } from '@/components/providers/StoreProvider';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import '@/styles/tokens.css';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Loam',
  description: 'Desktop AI-agent workspace',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr" className="light is-desktop" data-interface-density="compact" data-accent-color="default">
      <body className="min-h-screen bg-bg-main">
        <StoreProvider>
          {children}
          <SettingsDialog />
        </StoreProvider>
      </body>
    </html>
  );
}
