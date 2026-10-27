'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { LegalWorkspace } from '@/components/legal/LegalWorkspace';

function MatterWorkspace() {
  const matterId = useSearchParams().get('id');
  return matterId ? <LegalWorkspace matterId={matterId} /> : null;
}

export default function LegalMatterPage() {
  return <Suspense fallback={null}><MatterWorkspace /></Suspense>;
}
