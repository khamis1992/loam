'use client';

import { Suspense } from 'react';
import { PortalView } from '@/components/portal/PortalView';

/**
 * Public read-only client portal. `/portal?t=<token>` and `/portal/<token>`
 * both render the same view; PortalView resolves the token from the query or
 * the path. This page is what the static export emits as `out/portal.html`,
 * which src/server/http.ts serves for every /portal/<token> request — mirroring
 * how /share works.
 */
export default function PortalPage() {
  return (
    <Suspense fallback={<div className="grid h-screen place-items-center text-text-secondary">…</div>}>
      <PortalView />
    </Suspense>
  );
}
