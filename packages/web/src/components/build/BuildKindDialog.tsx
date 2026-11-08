'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BuildKind, BuildSelection, WebsiteSubtype } from '@shared/buildMenu';
import { getLocale, isRtl, t } from '@/i18n/t';
import { WebsiteTemplateGallery } from './WebsiteTemplateGallery';

const focusRing = 'text-text-primary [&_button]:focus-visible:outline [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_a]:focus-visible:outline [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-2 [&_input]:focus-visible:outline [&_input]:focus-visible:outline-2 [&_input]:focus-visible:outline-offset-2 [&_textarea]:focus-visible:outline [&_textarea]:focus-visible:outline-2 [&_textarea]:focus-visible:outline-offset-2';

const tiles: readonly { kind: Exclude<BuildKind, 'website'>; label: string }[] = [
  { kind: 'desktop', label: 'Desktop app' },
  { kind: 'widget', label: 'Desktop widget' },
  { kind: 'automation', label: 'Automations' },
  { kind: 'notebook', label: 'Jupyter notebook' },
  { kind: 'mobile', label: 'Mobile app' },
  { kind: 'chrome-extension', label: 'Chrome extension' },
  { kind: 'safari-extension', label: 'Safari extension' },
  { kind: 'game', label: 'Game development' },
];

export function websiteSubtypeForPrompt(prompt: string): WebsiteSubtype {
  if (/chatbot|محادثة/i.test(prompt)) return 'chatbot';
  if (/cart|checkout|متجر|سلة/i.test(prompt)) return 'store';
  if (/online booking|appointment|حجز/i.test(prompt)) return 'booking';
  if (/\bstore\b/i.test(prompt) && !/landing page/i.test(prompt)) return 'store';
  return 'landing';
}

function trapFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const root = event.currentTarget;
  const items = Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea'))
    .filter((node) => !node.hasAttribute('disabled'));
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && root.contains(active);
  if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

export function BuildKindDialog(props: {
  onSelect: (selection: BuildSelection, prompt?: string) => void;
  onClose: () => void;
}) {
  const [websites, setWebsites] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = dialogRef.current?.querySelector('button');
    if (close instanceof HTMLElement) close.focus();
  }, [websites]);
  return (
    <section
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      dir={isRtl(getLocale()) ? 'rtl' : 'ltr'}
      lang={getLocale()}
      className={focusRing}
      aria-label={t('Choose a build kind')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose();
        else trapFocus(event);
      }}
    >
      <button type="button" aria-label={t('Close')} onClick={props.onClose}>{t('Close')}</button>
      {websites ? (
        <>
          <WebsiteTemplateGallery onSelect={(prompt) => props.onSelect({ kind: 'website', subtype: websiteSubtypeForPrompt(prompt) }, prompt)} />
          <button type="button" onClick={() => props.onSelect({ kind: 'website', subtype: 'chatbot' }, t('Build a local chatbot that answers inside the page'))}>{t('Chatbot')}</button>
        </>
      ) : (
        <>
          <button type="button" aria-label={t('Choose websites')} onClick={() => setWebsites(true)}>{t('Build websites')}</button>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map((entry) => (
              <button
                type="button"
                key={entry.kind}
                aria-label={t('Choose {title}', { title: t(entry.label) })}
                onClick={() => props.onSelect({ kind: entry.kind })}
              >
                {t(entry.label)}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
