'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertCircle, Palette, Wand2 } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';

interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

interface BrandKit {
  id: string;
  name: string;
  colors: BrandColors;
  fonts: { heading: string; body: string };
  logoRefs: string[];
  updatedAt: string;
}

interface DesignTemplate {
  id: string;
  name: string;
  description: string;
}

interface DesignRecord {
  id: string;
  brief: string;
  templateId: string;
  brandName: string;
  generator: string;
  createdAt: string;
}

const COLOR_FIELDS: Array<{ key: keyof BrandColors; label: string }> = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'accent', label: 'Accent' },
  { key: 'background', label: 'Background' },
  { key: 'text', label: 'Text' },
];

export default function DesignStudioPage() {
  const router = useRouter();
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [templates, setTemplates] = useState<DesignTemplate[]>([]);
  const [designs, setDesigns] = useState<DesignRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [colors, setColors] = useState<BrandColors>({
    primary: '#1d4ed8',
    secondary: '#0ea5e9',
    accent: '#f59e0b',
    background: '#0f172a',
    text: '#f8fafc',
  });
  const [headingFont, setHeadingFont] = useState('Georgia, serif');
  const [bodyFont, setBodyFont] = useState('Helvetica, Arial, sans-serif');
  const [logoRef, setLogoRef] = useState('');
  const [saving, setSaving] = useState(false);

  const [brief, setBrief] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [brandKitId, setBrandKitId] = useState('');
  const [generating, setGenerating] = useState(false);

  const refresh = async () => {
    const headers = await getApiHeaders();
    const [k, tp, d] = await Promise.all([
      fetch(`${getApiBase()}/api/design/brand-kits`, { headers }).then((r) => r.json()),
      fetch(`${getApiBase()}/api/design/templates`, { headers }).then((r) => r.json()),
      fetch(`${getApiBase()}/api/design/outputs?limit=12`, { headers }).then((r) => r.json()),
    ]);
    setKits(k.kits ?? []);
    setTemplates(tp.templates ?? []);
    setDesigns(d.designs ?? []);
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const [k, tp, d] = await Promise.all([
          fetch(`${getApiBase()}/api/design/brand-kits`, { headers }),
          fetch(`${getApiBase()}/api/design/templates`, { headers }),
          fetch(`${getApiBase()}/api/design/outputs?limit=12`, { headers }),
        ]);
        if (!mounted) return;
        if (!k.ok || !tp.ok || !d.ok) throw new Error(`status ${k.status}/${tp.status}/${d.status}`);
        const kb = (await k.json()) as { kits?: BrandKit[] };
        const tb = (await tp.json()) as { templates?: DesignTemplate[] };
        const db = (await d.json()) as { designs?: DesignRecord[] };
        setKits(kb.kits ?? []);
        setTemplates(tb.templates ?? []);
        setDesigns(db.designs ?? []);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const saveKit = async () => {
    setSaving(true);
    setError(null);
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getApiBase()}/api/design/brand-kits`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          colors,
          fonts: { heading: headingFont, body: bodyFont },
          logoRefs: logoRef.trim() ? [logoRef.trim()] : [],
        }),
      });
      const data = (await res.json()) as { kit?: BrandKit; error?: string };
      if (!res.ok) throw new Error(data.error ?? `status ${res.status}`);
      setName('');
      setLogoRef('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getApiBase()}/api/design/generate`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          brief,
          ...(templateId ? { templateId } : {}),
          ...(brandKitId ? { brandKitId } : {}),
        }),
      });
      const data = (await res.json()) as { design?: DesignRecord; error?: string };
      if (!res.ok) throw new Error(data.error ?? `status ${res.status}`);
      setBrief('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-main">
      <div className="flex h-row items-center gap-3 border-b border-border-main px-4">
        <button
          type="button"
          onClick={() => router.push('/app')}
          className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
        >
          <ArrowLeft className="size-4" />
        </button>
        <Palette className="size-4 text-text-tertiary" />
        <h1 className="text-title-lg text-text-primary">{t('Design Studio')}</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {error && (
              <div className="flex items-center gap-2 rounded-card border border-border-main bg-bg-menu p-3 text-function-error">
                <AlertCircle className="size-4 shrink-0" />
                <p className="text-xs">{error}</p>
              </div>
            )}

            <section className="rounded-card border border-border-main bg-bg-menu p-4">
              <h2 className="mb-3 text-sm font-medium text-text-primary">{t('Brand kits')}</h2>
              {kits.length === 0 ? (
                <p className="mb-3 text-xs text-text-tertiary">{t('No brand kits yet. Create one below.')}</p>
              ) : (
                <ul className="mb-3 flex flex-col gap-2">
                  {kits.map((k) => (
                    <li key={k.id} className="flex items-center gap-3 rounded-control border border-border-main p-2">
                      <div className="flex gap-1">
                        {COLOR_FIELDS.map(({ key }) => (
                          <span key={key} className="size-4 rounded-full border border-border-main" style={{ backgroundColor: k.colors[key] }} />
                        ))}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-text-primary">{k.name}</p>
                        <p className="truncate text-xs text-text-tertiary">{k.fonts.heading} / {k.fonts.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-col gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('Brand name')}
                  className="rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary"
                />
                <div className="flex flex-wrap gap-3">
                  {COLOR_FIELDS.map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 text-xs text-text-secondary">
                      {t(label)}
                      <input
                        type="color"
                        value={colors[key]}
                        onChange={(e) => setColors((c) => ({ ...c, [key]: e.target.value }))}
                        className="size-7 cursor-pointer rounded-control border border-border-main bg-bg-main"
                      />
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    value={headingFont}
                    onChange={(e) => setHeadingFont(e.target.value)}
                    placeholder={t('Heading font')}
                    className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary"
                  />
                  <input
                    value={bodyFont}
                    onChange={(e) => setBodyFont(e.target.value)}
                    placeholder={t('Body font')}
                    className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary"
                  />
                  <input
                    value={logoRef}
                    onChange={(e) => setLogoRef(e.target.value)}
                    placeholder={t('Logo path or URL')}
                    className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary"
                  />
                </div>
                <button
                  type="button"
                  onClick={saveKit}
                  disabled={saving || !name.trim()}
                  className="self-start rounded-control bg-fill-tsp px-3 py-2 text-sm text-text-primary disabled:opacity-50"
                >
                  {saving ? t('Saving') : t('Save brand kit')}
                </button>
              </div>
            </section>

            <section className="rounded-card border border-border-main bg-bg-menu p-4">
              <h2 className="mb-3 text-sm font-medium text-text-primary">{t('Generate a design')}</h2>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder={t('Describe what to design...')}
                rows={3}
                className="mb-2 w-full resize-y rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary"
              />
              <div className="mb-3 flex flex-wrap gap-2">
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="rounded-control border border-border-main bg-bg-main px-2 py-2 text-xs text-text-primary"
                >
                  <option value="">{t('Auto layout')}</option>
                  {templates.map((tp) => (
                    <option key={tp.id} value={tp.id}>{tp.name}</option>
                  ))}
                </select>
                <select
                  value={brandKitId}
                  onChange={(e) => setBrandKitId(e.target.value)}
                  className="rounded-control border border-border-main bg-bg-main px-2 py-2 text-xs text-text-primary"
                >
                  <option value="">{t('Latest brand kit')}</option>
                  {kits.map((k) => (
                    <option key={k.id} value={k.id}>{k.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={generate}
                  disabled={generating || !brief.trim()}
                  className="flex items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary disabled:opacity-50"
                  style={{ backgroundColor: colors.primary }}
                >
                  {generating ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                  {t('Generate')}
                </button>
              </div>
              {designs.length === 0 ? (
                <p className="text-xs text-text-tertiary">{t('Generated designs will appear here.')}</p>
              ) : (
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {designs.map((d) => (
                    <li key={d.id} className="rounded-control border border-border-main p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`${getApiBase()}/api/design/outputs/${d.id}/image`}
                        alt={d.brief}
                        className="mb-2 w-full rounded-control border border-border-main bg-bg-main"
                      />
                      <p className="line-clamp-2 text-xs text-text-primary">{d.brief}</p>
                      <p className="text-[10px] text-text-tertiary">{d.templateId} · {d.brandName} · {d.generator}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
