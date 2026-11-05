'use client';

import { useState } from 'react';
import { Markdown } from '@/components/chat/Markdown';

/** Reading page shared by the file panel and the studio document. */
export const DOCUMENT_CANVAS = 'bg-[#f4f4f2]';
export const DOCUMENT_SHEET =
  'mx-auto w-full max-w-[760px] bg-white px-12 py-10 text-[#1c1c1c] shadow-[0_1px_2px_rgba(0,0,0,0.04)]';
export const DOCUMENT_TYPE = [
  '[&_h1]:mb-4 [&_h1]:text-[26px] [&_h1]:font-bold [&_h1]:leading-snug [&_h1]:text-[#111]',
  '[&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-[20px] [&_h2]:font-bold [&_h2]:leading-snug [&_h2]:text-[#111]',
  '[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-[17px] [&_h3]:font-semibold [&_h3]:text-[#111]',
  '[&_p]:my-3 [&_p]:text-[15px] [&_p]:leading-[1.85] [&_p]:text-[#222]',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:ps-6',
  '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:ps-6',
  '[&_li]:my-1.5 [&_li]:text-[15px] [&_li]:leading-[1.75]',
  '[&_strong]:font-semibold [&_strong]:text-[#111]',
  '[&_img]:my-6 [&_img]:w-full [&_img]:rounded-md [&_img]:border [&_img]:border-[#e6e6e3] [&_img]:bg-[#fafafa] [&_img]:p-4',
  '[&_pre]:my-6 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[#e6e6e3] [&_pre]:bg-[#fafafa] [&_pre]:p-4 [&_pre]:text-xs [&_pre]:leading-6',
  '[&_blockquote]:my-4 [&_blockquote]:border-s-2 [&_blockquote]:border-[#ddd] [&_blockquote]:ps-4',
  '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[#e6e6e3] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[#e6e6e3] [&_th]:px-2 [&_th]:py-1 [&_th]:text-start',
].join(' ');

const DOC_EXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst']);

export function isDocumentFile(extension: string, content: string): boolean {
  if (DOC_EXT.has(extension)) return true;
  return !extension && /^#{1,3}\s+\S/m.test(content);
}

export function splitDocument(content: string, path?: string): { title: string; body: string } {
  const lines = content.replace(/^\uFEFF/, '').split('\n');
  const heading = lines.findIndex((line) => /^#\s+\S/.test(line.trim()));
  if (heading >= 0) {
    const title = lines[heading]!.replace(/^#\s+/, '').trim();
    const body = [...lines.slice(0, heading), ...lines.slice(heading + 1)].join('\n').trim();
    return { title, body };
  }
  const name = path?.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? '';
  return { title: name, body: content };
}

/** The file as a reading page, with a control to see the raw text. */
export function DocumentPage({ title, body }: { title: string; body: string }) {
  const [plain, setPlain] = useState(false);
  return (
    <div className={`flex h-full flex-col ${DOCUMENT_CANVAS}`}>
      <div className="min-h-0 flex-1 overflow-auto py-6">
        {plain ? (
          <pre className="mx-auto max-w-[760px] whitespace-pre-wrap bg-white px-12 py-10 font-mono text-xs leading-6 text-[#333]">{body}</pre>
        ) : (
          <article dir="auto" className={DOCUMENT_SHEET}>
            {title ? <h1 className="mb-5 text-[26px] font-bold leading-snug text-[#111]">{title}</h1> : null}
            <Markdown className={DOCUMENT_TYPE}>{body}</Markdown>
          </article>
        )}
      </div>
      <div className="flex h-10 shrink-0 items-center border-t border-black/5 bg-white px-3">
        <button
          type="button"
          onClick={() => setPlain((value) => !value)}
          className="rounded-md border border-black/10 bg-white px-2 py-1 text-xs text-[#444]"
        >
          {plain ? 'الصفحة' : 'Plain Text'}
        </button>
      </div>
    </div>
  );
}
