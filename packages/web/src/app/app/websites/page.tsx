'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlarmClock,
  ChevronRight,
  CreditCard,
  Globe2,
  Loader2,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  UserRound,
} from 'lucide-react';
import { getLocale, t } from '@/i18n/t';
import { listAppProjects, type AppProjectDto } from '@/services/appBuilderApi';
import { AppBuilderWorkspace } from '@/components/appbuilder/AppBuilderWorkspace';
import { WebsiteTemplateGallery } from '@/components/build/WebsiteTemplateGallery';
import { WebsiteHero } from '@/components/websites/WebsiteHero';
import { NewWebsiteDialog } from '@/components/websites/NewWebsiteDialog';

interface Capability {
  title: string;
  description: string;
  prompt: string;
  icon: typeof Sparkles;
}

const CAPABILITIES: Capability[] = [
  { title: 'AI integration', description: 'Add AI-powered chat, content generation, and more to your site.', prompt: 'Add an AI integration to this website with an AI-powered chat assistant that answers from the site content and supports content generation.', icon: Sparkles },
  { title: 'Payments', description: 'Get paid for products, services, and subscriptions with Stripe.', prompt: 'Add payments to this website for products, services, and subscriptions with a clear checkout flow and payment status handling.', icon: CreditCard },
  { title: 'Shopify', description: 'Build a custom storefront with Shopify’s products, cart, and checkout.', prompt: 'Build a custom Shopify storefront with products, collections, cart, and checkout.', icon: ShoppingBag },
  { title: 'Market data', description: 'Show stock, crypto, and forex prices alongside charts and historical data.', prompt: 'Add market data to this website with stock, crypto, and forex prices, charts, and historical data views.', icon: TrendingUp },
  { title: 'Scheduled jobs', description: 'Put recurring tasks on autopilot, from refreshing data to publishing content.', prompt: 'Add scheduled jobs to this website for recurring data refreshes and automatic content publishing.', icon: AlarmClock },
  { title: 'User authentication', description: 'Let users sign in and access their own saved data and content.', prompt: 'Add user authentication to this website with sign in, sign up, sign out, and private saved user data.', icon: UserRound },
  { title: 'SEO', description: 'Improve discovery with metadata, structured data, and search-friendly pages.', prompt: 'Improve this website for SEO with metadata, structured data, semantic pages, sitemap, and search-friendly content.', icon: Search },
  { title: 'Custom domain', description: 'Connect a branded domain and make the site ready for visitors.', prompt: 'Prepare this website for a custom domain with production metadata, canonical URLs, and deployment configuration.', icon: Globe2 },
];

function formatDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat(getLocale() === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' }).format(time);
}

export default function WebsitesPage() {
  const [projects, setProjects] = useState<AppProjectDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<AppProjectDto | null>(null);
  const [draft, setDraft] = useState<{ title?: string; prompt?: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const capabilitiesRef = useRef<HTMLElement>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listAppProjects(50);
      setProjects(data.projects ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    listAppProjects(50)
      .then((data) => { if (mounted) { setProjects(data.projects ?? []); setError(null); } })
      .catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const visibleCapabilities = showAll ? CAPABILITIES : CAPABILITIES.slice(0, 6);
  const onCreated = useCallback((project: AppProjectDto) => {
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    setSelectedProject(project);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-main">
      <header className="flex h-14 shrink-0 items-center justify-between px-6">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-text-primary">{t('Websites')}</h1>
        <button type="button" onClick={() => setDraft({})} className="flex items-center gap-1.5 rounded-[7px] bg-text-primary px-3.5 py-2 text-[13px] font-medium text-text-onblack transition-opacity hover:opacity-90">
          <Plus className="size-4" aria-hidden />{t('New website')}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-[960px] px-6 pb-16">
          <WebsiteHero onExplore={() => capabilitiesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />

          <section aria-labelledby="your-websites-title" className="mt-2 min-h-[54px]">
            <h2 id="your-websites-title" className="text-sm font-medium text-text-primary">{t('Your websites')}</h2>
            {loading ? (
              <div className="flex items-center gap-2 py-5 text-xs text-text-tertiary"><Loader2 className="size-4 animate-spin" />{t('Loading')}</div>
            ) : error ? (
              <div className="mt-3 flex items-center gap-3 text-xs text-func-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadProjects()} className="rounded-[6px] bg-fill-hover px-3 py-1.5 text-text-primary">{t('Retry')}</button></div>
            ) : projects.length > 0 ? (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button type="button" onClick={() => setSelectedProject(project)} className="group block w-full overflow-hidden rounded-[9px] border border-border-main bg-bg-menu text-start shadow-sm transition-shadow hover:shadow-card">
                      <span className="flex aspect-[16/8] items-center justify-center border-b border-border-light bg-fill-tsp"><Globe2 className="size-9 stroke-[1.25] text-text-tertiary transition-transform group-hover:scale-105" /></span>
                      <span className="block p-3">
                        <span className="block truncate text-[13px] font-medium text-text-primary">{project.title}</span>
                        <span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-text-tertiary"><span className="capitalize">{project.status}</span><span>{formatDate(project.updatedAt)}</span></span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section ref={capabilitiesRef} aria-labelledby="website-capabilities-title" className="mt-10 scroll-mt-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="website-capabilities-title" className="text-sm font-medium text-text-primary">{t('Power up your website')}</h2>
              <button type="button" onClick={() => setShowAll((value) => !value)} className="text-xs text-text-secondary hover:text-text-primary">{t(showAll ? 'Show less' : 'Show all')}</button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {visibleCapabilities.map(({ title, description, prompt, icon: Icon }) => (
                <button key={title} type="button" onClick={() => setDraft({ title, prompt })} className="group flex min-h-[76px] items-center gap-3 rounded-[10px] border border-border-main bg-bg-menu p-3.5 text-start transition-colors hover:bg-fill-tsp">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[7px] border border-border-light bg-bg-main"><Icon className="size-[18px] text-text-secondary" /></span>
                  <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium text-text-primary">{t(title)}</span><span className="mt-0.5 block text-[11px] leading-[1.45] text-text-tertiary">{t(description)}</span></span>
                  <ChevronRight className="size-4 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 rtl:rotate-180" />
                </button>
              ))}
            </div>
          </section>

          <WebsiteTemplateGallery featured={false} columns="four" onSelect={(prompt, title) => setDraft({ title, prompt })} />
        </main>
      </div>

      <NewWebsiteDialog
        open={draft !== null}
        initialTitle={draft?.title}
        initialPrompt={draft?.prompt}
        onClose={() => setDraft(null)}
        onCreated={onCreated}
      />
      {selectedProject && (
        <div className="fixed inset-y-0 end-0 z-40 w-[min(720px,94vw)] border-s border-border-main bg-bg-menu shadow-layer" data-testid="website-workspace">
          <AppBuilderWorkspace projectId={selectedProject.id} onClose={() => setSelectedProject(null)} />
        </div>
      )}
    </div>
  );
}
