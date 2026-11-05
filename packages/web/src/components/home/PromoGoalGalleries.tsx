'use client';

import { useState } from 'react';
import Image from 'next/image';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { GameArena } from './GameArena';

interface GalleryItem {
  title: string;
  image: string;
  categories?: string[];
}

const FEATURED: GalleryItem[] = [
  { title: 'The Parrot', image: '/studio-pages/video/featured-parrot.png' },
  { title: 'Hush', image: '/studio-pages/video/featured-hush.png' },
  { title: 'Solar Power, Explained', image: '/studio-pages/video/featured-solar.png' },
  { title: 'Catzilla Live', image: '/studio-pages/video/featured-catzilla.png' },
];

const TEMPLATES: GalleryItem[] = [
  { title: 'Short film', image: '/studio-pages/video/short-film.png', categories: ['AI short films', 'AI short dramas'] },
  { title: 'Promotional ad', image: '/studio-pages/video/promotional-ad.png', categories: ['Marketing'] },
  { title: 'Explainer', image: '/studio-pages/video/explainer.png', categories: ['AI short films', 'Edit your footage'] },
  { title: 'Product showcase', image: '/studio-pages/video/product-showcase.png', categories: ['Marketing', 'Edit your footage'] },
];

const ALCHEMY: GalleryItem[] = [
  { title: 'Neon character video', image: '/studio-pages/video/alchemy-neon.png' },
  { title: 'Snowman video', image: '/studio-pages/video/alchemy-snowman.png' },
  { title: 'Fantasy character video', image: '/studio-pages/video/alchemy-dragon.png' },
  { title: 'Everyday moment video', image: '/studio-pages/video/alchemy-dog.png' },
];

const CATEGORIES = ['All templates', 'Marketing', 'Edit your footage', 'AI short films', 'AI short dramas'];

function GalleryCard({ item, onSelect }: { item: GalleryItem; onSelect: (title: string) => void }) {
  return (
    <button
      type="button"
      aria-label={t(item.title)}
      onClick={() => onSelect(t(item.title))}
      className="group relative block aspect-video overflow-hidden rounded-card bg-fill-tsp text-start"
    >
      <Image
        src={item.image}
        alt={t(item.title)}
        fill
        sizes="(max-width: 768px) 50vw, 250px"
        className="object-cover transition-transform group-hover:scale-[1.02]"
        unoptimized
      />
    </button>
  );
}

export function VideoGallery({ onSelect }: { onSelect: (title: string) => void }) {
  const [category, setCategory] = useState(CATEGORIES[0]);
  const templates = category === CATEGORIES[0]
    ? TEMPLATES
    : TEMPLATES.filter((item) => item.categories?.includes(category));

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {FEATURED.map((item) => <GalleryCard key={item.title} item={item} onSelect={onSelect} />)}
      </div>

      <section>
        <div className="mb-3 flex items-center gap-5 overflow-x-auto text-xs">
          <div className="flex flex-1 items-center gap-5" role="tablist" aria-label={t('Video templates')}>
            {CATEGORIES.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={category === item}
                onClick={() => setCategory(item)}
                className={clsx(
                  'shrink-0 rounded-control px-2 py-1',
                  category === item ? 'bg-fill-tsp font-medium text-text-primary' : 'text-text-tertiary hover:text-text-primary',
                )}
              >
                {t(item)}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setCategory(CATEGORIES[0])} className="shrink-0 text-text-tertiary hover:text-text-primary">
            {t('View all')}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {templates.map((item) => <GalleryCard key={item.title} item={item} onSelect={onSelect} />)}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium text-text-primary">{t('Made with Loam')}</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {ALCHEMY.map((item) => <GalleryCard key={item.title} item={item} onSelect={onSelect} />)}
        </div>
      </section>
    </div>
  );
}

const GAME_IMAGES = [
  '/studio-pages/game/iron-rift.png',
  '/studio-pages/game/space-worm.png',
  '/studio-pages/game/side-scroller.png',
  '/studio-pages/game/the-rogue.png',
];

export function GameGallery({ suggestions, onSelect }: { suggestions: string[]; onSelect: (title: string) => void }) {
  return (
    <>
      <GameArena />
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-text-primary">{t('Explore games')}</h3>
          <span className="text-xs text-text-tertiary">{t('Show all')}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {suggestions.map((suggestion, index) => (
            <GalleryCard
              key={suggestion}
              item={{ title: suggestion, image: GAME_IMAGES[index % GAME_IMAGES.length] }}
              onSelect={onSelect}
            />
          ))}
        </div>
      </section>
    </>
  );
}
