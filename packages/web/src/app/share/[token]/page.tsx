import { Suspense } from 'react';
import { ShareReplay } from '@/components/share/ShareReplay';

/**
 * Public read-only share replay (option #11) — path form: `/share/<token>`.
 *
 * The web app is statically exported (`output: 'export'`), so an unbounded
 * dynamic route cannot be pre-rendered for every token. One placeholder param
 * is emitted at build time and the Loam server / desktop fallback serve that
 * file for any token; ShareReplay reads the real token from the URL path.
 */
export function generateStaticParams() {
  return [{ token: 'shared' }];
}

export default function ShareTokenPage(_props: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<div className="grid h-screen place-items-center text-text-secondary">…</div>}>
      <ShareReplay />
    </Suspense>
  );
}
