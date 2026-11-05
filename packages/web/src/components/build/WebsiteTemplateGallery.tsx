'use client';

import { useState } from 'react';
import Image from 'next/image';
import clsx from 'clsx';
import { t } from '@/i18n/t';

interface WebsiteTemplate {
  id: string;
  title: string;
  prompt: string;
  image: string;
  categories: string[];
}

const CATEGORIES = ['All', 'Landing Page', 'SaaS', 'E-commerce', 'Productivity', 'Portfolio', 'Education'];

const TEMPLATES: WebsiteTemplate[] = [
  {
    id: 'christmas-sale', title: 'Christmas Sale',
    prompt: 'Create a Christmas sale landing page for a fashion store with a bold offer, product highlights, and a festive visual style.',
    image: '/website-templates/landing-sales.png', categories: ['Landing Page', 'E-commerce'],
  },
  {
    id: 'team-work', title: 'Team Work Management',
    prompt: 'Create a team work management website with projects, tasks, timelines, and team collaboration dashboards.',
    image: '/website-templates/landing-portfolio.png', categories: ['Landing Page', 'Productivity'],
  },
  {
    id: 'solar-company', title: 'Solar Company Website',
    prompt: 'Create a solar company website with services, benefits, projects, and a clear quote request call to action.',
    image: '/website-templates/landing-newsletter.png', categories: ['Landing Page', 'Portfolio', 'Education'],
  },
  {
    id: 'sales-crm', title: 'Sales CRM',
    prompt: 'Create a sales CRM with a revenue funnel, drag-and-drop pipeline, client timeline, and sales dashboard.',
    image: '/website-templates/saas-personal-finance.png', categories: ['SaaS', 'Productivity'],
  },
  {
    id: 'occupancy-dashboard', title: 'Occupancy Dashboard',
    prompt: 'Create an occupancy dashboard with room availability, bookings, utilization metrics, and a calendar.',
    image: '/website-templates/saas-project-manager.png', categories: ['SaaS', 'Productivity'],
  },
  {
    id: 'online-booking', title: 'Online Booking',
    prompt: 'Create an online booking website with services, availability, appointment scheduling, and confirmation.',
    image: '/website-templates/saas-analytics.png', categories: ['SaaS', 'Productivity'],
  },
  {
    id: 'merch-store', title: 'Merch Store',
    prompt: 'Create a merchandise store with product listings, categories, cart, and checkout.',
    image: '/website-templates/ecommerce-store.png', categories: ['E-commerce'],
  },
];

export function WebsiteTemplateGallery({ onSelect }: { onSelect: (prompt: string) => void }) {
  const [category, setCategory] = useState('All');
  const filtered = category === 'All'
    ? [TEMPLATES[0], TEMPLATES[3], TEMPLATES[1]]
    : TEMPLATES.filter((template) => template.categories.includes(category));

  return (
    <section className="mt-8" aria-label={t('Explore what’s possible')}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-text-primary">{t('Explore what’s possible')}</h2>
        <span className="text-xs text-text-tertiary">{t('Show all')}</span>
      </div>
      <div className="mb-4 flex gap-5 overflow-x-auto text-xs" role="tablist" aria-label={t('Website categories')}>
        {CATEGORIES.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={category === item}
            data-testid={`website-category-${item}`}
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((template) => (
          <button
            key={template.id}
            type="button"
            aria-label={t(template.title)}
            data-testid={`website-template-${template.id}`}
            onClick={() => onSelect(template.prompt)}
            className="group relative aspect-[16/9] overflow-hidden rounded-card bg-fill-tsp text-start"
          >
            <Image
              src={template.image}
              alt={t(template.title)}
              fill
              sizes="(max-width: 768px) 50vw, 250px"
              className="object-cover transition-transform group-hover:scale-[1.02]"
              unoptimized
            />
          </button>
        ))}
      </div>
    </section>
  );
}
