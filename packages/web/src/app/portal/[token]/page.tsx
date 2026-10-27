import { Suspense } from 'react';
import { PortalView } from '@/components/portal/PortalView';

/**
 * Public read-only client portal — path form: `/portal/<token>`.
 *
 * The web app is statically exported (`output: 'export'`), so an unbounded
 * dynamic route cannot be pre-rendered for every token. One placeholder param
 * is emitted at build time and the Loam server / desktop fallback serve that
 * file for any token (see the /portal branch in src/server/http.ts, which maps
 * /portal/<token> to /portal.html exactly like /share); PortalView reads the
 * real token from the URL path or query.
 */
export function generateStaticParams() {
  return [{ token: 'client' }];
}

export default function PortalTokenPage(_props: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<div className="grid h-screen place-items-center text-text-secondary">…</div>}>
      <PortalView />
    </Suspense>
  );
}
