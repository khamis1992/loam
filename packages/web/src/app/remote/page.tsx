import type { Metadata, Viewport } from 'next';
import { RemoteView } from '@/components/remote/RemoteView';

/**
 * Loam Remote (/remote): mobile-first PWA served by the local Loam server
 * (same static-export trick as /share and /portal). The page is public; the
 * /api calls it makes carry the install token the user pastes once.
 */
export const metadata: Metadata = {
  title: 'Loam Remote',
  description: 'متابعة مهام Loam والتحكم بها من الهاتف عبر الشبكة المحلية',
  manifest: '/remote/manifest.webmanifest',
  icons: { icon: '/remote/icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d1210',
};

export default function RemotePage() {
  return <RemoteView />;
}
