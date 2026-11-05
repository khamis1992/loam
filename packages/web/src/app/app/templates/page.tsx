'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { APP_TEMPLATE_PREVIEWS, type TemplatePreview } from '@/components/home/TemplatePreviewDialog';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { t } from '@/i18n/t';

export default function TemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplatePreview[]>(APP_TEMPLATE_PREVIEWS);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/studio-templates`, { headers: await getApiHeaders() });
        if (!res.ok) return;
        const data = await res.json() as { appTemplates?: TemplatePreview[] };
        if (mounted && Array.isArray(data.appTemplates) && data.appTemplates.length > 0) setTemplates(data.appTemplates);
      } catch {
        // The bundled app templates remain available offline.
      }
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto bg-bg-main p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-3">
          <button type="button" onClick={() => router.push('/app')} aria-label={t('Back')} className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover">
            <ArrowLeft className="size-4 rtl:rotate-180" />
          </button>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{t('App templates')}</h1>
            <p className="text-sm text-text-tertiary">{t('Start with a working app, then make it yours.')}</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => router.push(`/app/templates/${template.id}`)}
              className="group overflow-hidden rounded-card border border-border-main bg-bg-menu text-start hover:bg-fill-hover"
            >
              <div className="relative aspect-video bg-fill-tsp">
                <Image src={template.imageSrc} alt={t(template.imageAlt)} fill sizes="(max-width: 768px) 50vw, 320px" className="object-cover" unoptimized />
              </div>
              <div className="p-4">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-text-primary">{t(template.title)}</h2>
                  <ArrowUpRight className="size-4 shrink-0 text-text-tertiary group-hover:text-text-primary" />
                </div>
                <p className="text-xs leading-5 text-text-tertiary">{t(template.description)}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
