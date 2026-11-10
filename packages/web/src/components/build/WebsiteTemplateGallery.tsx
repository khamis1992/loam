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
const FEATURED_IDS = ['merch-store', 'online-booking', 'christmas-sale'];

const TEMPLATES: WebsiteTemplate[] = [
  { id: 'christmas-sale', title: 'Christmas Sale', prompt: 'Create a Christmas sale landing page for a fashion store with a bold offer, product highlights, and a festive visual style.', image: '/website-templates/landing-sales.png', categories: ['Landing Page', 'E-commerce'] },
  { id: 'sales-crm', title: 'Sales CRM', prompt: 'Create a sales CRM with a revenue funnel, drag-and-drop pipeline, client timeline, and sales dashboard.', image: '/website-templates/saas-personal-finance.png', categories: ['SaaS', 'Productivity'] },
  { id: 'team-work', title: 'Team Work Management', prompt: 'Create a team work management website with projects, tasks, timelines, and team collaboration dashboards.', image: '/website-templates/landing-portfolio.png', categories: ['Landing Page', 'Productivity'] },
  { id: 'solar-company', title: 'Solar Company Website', prompt: 'Create a solar company website with services, benefits, projects, and a clear quote request call to action.', image: '/website-templates/landing-newsletter.png', categories: ['Landing Page', 'Portfolio', 'Education'] },
  { id: 'camera-launch', title: 'Camera Launch', prompt: 'Create a cinematic camera launch landing page with product features, sample photography, specifications, and preorder call to action.', image: '/website-templates/landing-portfolio.png', categories: ['Landing Page', 'Portfolio'] },
  { id: 'merch-store', title: 'Merch Store', prompt: 'Create a merchandise store with product listings, categories, cart, and checkout.', image: '/website-templates/ecommerce-store.png', categories: ['E-commerce'] },
  { id: 'class-scheduler', title: 'Class Scheduler', prompt: 'Create a class scheduling website with course listings, weekly calendars, teacher availability, and student bookings.', image: '/website-templates/saas-project-manager.png', categories: ['Education', 'Productivity'] },
  { id: 'driving-theory', title: 'Driving Theory Practice', prompt: 'Create a driving theory practice website with interactive questions, progress tracking, explanations, and mock exams.', image: '/website-templates/saas-analytics.png', categories: ['Education'] },
  { id: 'run-club', title: 'Run Club Hub', prompt: 'Create a run club community website with upcoming runs, routes, member stories, registration, and event galleries.', image: '/website-templates/landing-newsletter.png', categories: ['Landing Page', 'Portfolio'] },
  { id: 'clinic-website', title: 'Clinic Website', prompt: 'Create a clinic website with services, doctor profiles, patient information, contact details, and appointment booking.', image: '/website-templates/saas-project-manager.png', categories: ['SaaS', 'Productivity'] },
  { id: 'photographer-portfolio', title: 'Photographer Portfolio', prompt: 'Create a photographer portfolio with immersive galleries, project stories, services, and a booking contact form.', image: '/website-templates/landing-portfolio.png', categories: ['Portfolio', 'Landing Page'] },
  { id: 'black-friday', title: 'Black Friday Campaign', prompt: 'Create a Black Friday campaign landing page with a countdown, featured offers, product collections, and email signup.', image: '/website-templates/landing-sales.png', categories: ['Landing Page', 'E-commerce'] },
  { id: 'occupancy-dashboard', title: 'Occupancy Dashboard', prompt: 'Create an occupancy dashboard with room availability, bookings, utilization metrics, and a calendar.', image: '/website-templates/saas-project-manager.png', categories: ['SaaS', 'Productivity'] },
  { id: 'social-post-studio', title: 'Social Post Studio', prompt: 'Create a social post studio with a content calendar, post composer, campaign queues, and performance analytics.', image: '/website-templates/saas-analytics.png', categories: ['SaaS', 'Productivity'] },
  { id: 'studio-portfolio', title: 'Studio Portfolio', prompt: 'Create a design studio portfolio with selected projects, capabilities, team profiles, testimonials, and project inquiry.', image: '/website-templates/landing-portfolio.png', categories: ['Portfolio', 'Landing Page'] },
  { id: 'online-booking', title: 'Online Booking', prompt: 'Create an online booking website with services, availability, appointment scheduling, and confirmation.', image: '/website-templates/saas-analytics.png', categories: ['SaaS', 'Productivity'] },
];

export function WebsiteTemplateGallery({ onSelect, featured = true, columns = 'three' }: {
  onSelect: (prompt: string, title: string) => void;
  featured?: boolean;
  columns?: 'three' | 'four';
}) {
  const [category, setCategory] = useState('All');
  const filtered = category === 'All' && featured
    ? FEATURED_IDS.flatMap((id) => {
        const found = TEMPLATES.find((template) => template.id === id);
        return found ? [found] : [];
      })
    : category === 'All'
      ? TEMPLATES
      : TEMPLATES.filter((template) => template.categories.includes(category));

  return (
    <section className="mt-8" aria-label={t('Explore what’s possible')}>
      <h2 className="mb-3 text-sm font-medium text-text-primary">{t('Explore what’s possible')}</h2>
      <div className="mb-4 flex gap-1 overflow-x-auto" role="tablist" aria-label={t('Website categories')}>
        {CATEGORIES.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={category === item}
            data-testid={`website-category-${item}`}
            onClick={() => setCategory(item)}
            className={clsx(
              'shrink-0 rounded-[6px] px-3 py-2 text-[13px]',
              category === item ? 'bg-fill-hover font-medium text-text-primary' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {t(item)}
          </button>
        ))}
      </div>
      <div className={clsx('grid gap-3 sm:grid-cols-2', columns === 'four' ? 'xl:grid-cols-4' : 'lg:grid-cols-3')}>
        {filtered.map((template) => (
          <button
            key={template.id}
            type="button"
            aria-label={t(template.title)}
            data-testid={`website-template-${template.id}`}
            onClick={() => onSelect(template.prompt, template.title)}
            className="group relative aspect-[16/9] overflow-hidden rounded-[8px] border border-border-light bg-fill-tsp text-start shadow-sm"
          >
            <Image
              src={template.image}
              alt={t(template.title)}
              fill
              sizes={columns === 'four' ? '(max-width: 768px) 50vw, 230px' : '(max-width: 768px) 50vw, 300px'}
              className="object-cover transition-transform duration-medium group-hover:scale-[1.02]"
              unoptimized
            />
          </button>
        ))}
      </div>
    </section>
  );
}
