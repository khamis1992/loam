import { Markdown } from './Markdown';

/** A finished write-up with a heading, long enough to preview as a page. */
export function documentPreview(content: string): { title: string; body: string } | null {
  const text = content.trim();
  if (text.length < 400) return null;
  const lines = text.split('\n');
  const heading = lines.findIndex((line) => /^#{1,2}\s+\S/.test(line.trim()));
  if (heading < 0) return null;
  const title = lines[heading].replace(/^#{1,2}\s+/, '').trim();
  const body = lines.slice(heading + 1).join('\n').trim();
  if (!title || body.length < 80) return null;
  return { title, body };
}

/** The document as a page card: title, a fading excerpt, the way the task result is read. */
export function DocumentPreviewCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-black/5 bg-white shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
      <div className="relative max-h-80 overflow-hidden px-8 py-6">
        <h2 dir="auto" className="text-center text-lg font-semibold text-text-primary">{title}</h2>
        <div
          dir="auto"
          className="mt-4 text-sm leading-7 text-text-secondary [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-text-primary [&_li]:ms-5 [&_li]:list-disc [&_ol]:mt-2 [&_p]:mt-2 [&_ul]:mt-2"
        >
          <Markdown>{body}</Markdown>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-white to-transparent" />
      </div>
    </article>
  );
}
