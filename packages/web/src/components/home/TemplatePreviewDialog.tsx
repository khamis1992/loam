'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { AppWindow, ChevronLeft, ChevronRight, ExternalLink, Image as ImageIcon, Video, X } from 'lucide-react';
import { t } from '@/i18n/t';
import { BudgetApp } from '@/components/templates/BudgetApp';
import { FocusTimerApp, HabitTrackerApp, KanbanApp } from '@/components/templates/ProductivityApps';
import { APP_TEMPLATE_PREVIEWS, BUDGET_TEMPLATE, type TemplatePreview } from './appTemplateData';

export type { TemplatePreview } from './appTemplateData';
export { APP_TEMPLATE_PREVIEWS } from './appTemplateData';

export const TEMPLATE_PREVIEWS: TemplatePreview[] = [
  {
    id: 'anime',
    kind: 'Video',
    title: 'Create an anime short',
    description: 'A quiet seaside journey with a cyclist, soft summer clouds and warm hand-drawn light.',
    prompt: 'Create an original anime short about a cyclist following a seaside road at sunset. Use soft hand-drawn scenery, a passing train and a hopeful closing moment.',
    imageSrc: '/templates/anime.png',
    imageAlt: 'Create an anime short',
    previewSrc: '/template-previews/anime-preview.mp4',
    related: [
      { title: 'Create a fashion film', image: '/template-previews/video-fashion-film.png' },
      { title: 'Create a product ad for a sparkling drink', image: '/template-previews/video-product-ad.png' },
      { title: 'Create a hype reel esports final', image: '/template-previews/video-esports-reel.png' },
    ],
  },
  BUDGET_TEMPLATE,
  {
    id: 'fashion',
    kind: 'Image',
    title: 'Shoot a fashion editorial',
    description: 'An original editorial set of desert outfits with flowing silhouettes, natural linen and warm shadows.',
    prompt: 'Create an original fashion editorial with three scenes: a flowing linen dress on desert dunes, a tailored suit on an adobe staircase, and a close-up of natural fabric texture. Use warm neutral colors and soft film lighting.',
    imageSrc: '/templates/fashion.png',
    imageAlt: 'Shoot a fashion editorial',
    previewSrc: '/template-previews/fashion-1.png',
    related: [
      { title: 'Visualise interior design concepts for a café', image: '/template-previews/image-interior.png' },
      { title: "Illustrate a children's picture book", image: '/template-previews/image-children-book.png' },
      { title: 'Create concept art for a fantasy game', image: '/template-previews/image-fantasy.png' },
    ],
  },
];

const KIND_ICONS = { Video, App: AppWindow, Image: ImageIcon };

export function TemplatePreviewDialog({
  template,
  onClose,
  onUse,
  onOpenTemplate,
}: {
  template: TemplatePreview;
  onClose: () => void;
  onUse: (prompt: string) => void;
  onOpenTemplate?: (template: TemplatePreview) => void;
}) {
  const router = useRouter();
  const [slide, setSlide] = useState(0);
  const Icon = KIND_ICONS[template.kind];
  const images = template.id === 'fashion'
    ? ['/template-previews/fashion-1.png', '/template-previews/fashion-2.png', '/template-previews/fashion-3.png']
    : [template.previewSrc];

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t(template.title)}
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-[20px] bg-bg-menu p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2">
          <Icon className="size-4 text-text-secondary" />
          <h2 className="flex-1 text-sm font-semibold text-text-primary">{t(template.title)}</h2>
          <button type="button" onClick={onClose} aria-label={t('Close')} className="rounded-control p-1.5 text-text-tertiary hover:bg-fill-hover">
            <X className="size-4" />
          </button>
        </header>
        <p className="mt-1 text-sm leading-5 text-text-secondary">{t(template.description)}</p>

        {template.id === 'anime' && (
          <video
            src={template.previewSrc}
            poster="/template-previews/anime-preview.png"
            controls
            autoPlay
            muted
            loop
            playsInline
            aria-label={t(template.title)}
            className="mt-3 aspect-video w-full rounded-card bg-black"
          />
        )}

        {template.id === 'budget' && (
          <div className="relative mt-3 aspect-video overflow-hidden rounded-card bg-[#08111f]">
            <BudgetApp compact />
          </div>
        )}

        {template.id === 'focus-timer' && (
          <div className="relative mt-3 aspect-video overflow-hidden rounded-card bg-[#10182a]">
            <FocusTimerApp compact />
          </div>
        )}

        {template.id === 'habit-tracker' && (
          <div className="relative mt-3 aspect-video overflow-hidden rounded-card bg-[#f5f7fb]">
            <HabitTrackerApp compact />
          </div>
        )}

        {template.id === 'kanban' && (
          <div className="relative mt-3 aspect-video overflow-hidden rounded-card bg-[#111827]">
            <KanbanApp compact />
          </div>
        )}

        {template.id === 'fashion' && (
          <>
            <div className="relative mx-auto mt-3 h-[430px] w-full overflow-hidden rounded-card bg-fill-tsp">
              <Image src={images[slide]} alt={t(template.title)} fill sizes="768px" className="object-contain" unoptimized />
              <button
                type="button"
                aria-label={t('Previous image')}
                onClick={() => setSlide((slide + images.length - 1) % images.length)}
                className="absolute start-4 top-1/2 rounded-full bg-black/50 p-2 text-white"
              >
                <ChevronLeft className="size-4 rtl:rotate-180" />
              </button>
              <button
                type="button"
                aria-label={t('Next image')}
                onClick={() => setSlide((slide + 1) % images.length)}
                className="absolute end-4 top-1/2 rounded-full bg-black/50 p-2 text-white"
              >
                <ChevronRight className="size-4 rtl:rotate-180" />
              </button>
              <span className="absolute bottom-3 end-3 rounded-control bg-black/55 px-2 py-1 text-xs text-white">{slide + 1} / {images.length}</span>
            </div>
            <div className="mt-2 flex gap-2">
              {images.map((image, index) => (
                <button key={image} type="button" onClick={() => setSlide(index)} aria-label={t('Show image {index}', { index: index + 1 })} className="relative h-10 w-12 overflow-hidden rounded-control">
                  <Image src={image} alt="" fill sizes="48px" className="object-cover" unoptimized />
                </button>
              ))}
            </div>
          </>
        )}

        <div className="mt-3 flex justify-end gap-2">
          {template.kind === 'App' && (
            <button
              type="button"
              onClick={() => { router.push(`/app/templates/${template.id}`); onClose(); }}
              className="flex items-center gap-1.5 rounded-control border border-border-main px-3 py-2 text-xs font-medium text-text-primary"
            >
              {t('Open site')} <ExternalLink className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onUse(template.prompt)}
            className="rounded-control bg-[#1a1a1a] px-4 py-2 text-xs font-medium text-white"
          >
            {t('Use this idea')}
          </button>
        </div>

        {template.related.length > 0 && (
          <>
            <div className="mt-5 flex items-center justify-between">
              <h3 className="text-xs font-medium text-text-primary">
                {template.id === 'anime' ? t('More video ideas') : template.kind === 'App' ? t('More app ideas') : t('More image ideas')}
              </h3>
              {template.kind === 'App' && (
                <button type="button" onClick={() => { router.push('/app/templates'); onClose(); }} className="text-xs text-text-tertiary hover:text-text-primary">
                  {t('View all')}
                </button>
              )}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-3">
              {template.related.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => {
                    const relatedTemplate = APP_TEMPLATE_PREVIEWS.find((candidate) => candidate.id === item.templateId);
                    if (relatedTemplate && onOpenTemplate) onOpenTemplate(relatedTemplate);
                    else onUse(item.title);
                  }}
                  className="flex items-center gap-2 text-start"
                >
                  <span className="relative h-10 w-12 shrink-0 overflow-hidden rounded-control bg-fill-tsp">
                    <Image src={item.image} alt="" fill sizes="48px" className="object-cover" unoptimized />
                  </span>
                  <span className="text-xs leading-4 text-text-primary">{t(item.title)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
