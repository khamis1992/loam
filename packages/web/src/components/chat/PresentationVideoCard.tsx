'use client';

import { useEffect, useState } from 'react';
import { Clapperboard, Loader2, Play } from 'lucide-react';
import { t } from '@/i18n/t';
import { getApiHeaders } from '@/services/rpc';
import { mediaUrl } from './AttachmentCard';

export function presentationVideoRequest(input: { path: string; previewPath: string }) {
  return {
    text: `أنشئ فيديو MP4 من العرض التقديمي الموجود في مساحة هذه المهمة.\nملف العرض: ${input.path}\nصورة الشريحة الجاهزة للاستيراد: ${input.previewPath}\nاستخدم مسار إنتاج فيديو العرض مع صورة الشريحة أعلاه، ولا تحاول تشغيل PPTX كفيديو. أضف حركة اقتراب ودخولًا وخروجًا هادئين، وأضف تعليقًا صوتيًا عربيًا إذا كانت أداة التعليق المتاحة تدعم العربية السليمة، وإلا أنتج الفيديو دون صوت مشوّه. تحقق من MP4 ثم انشره في نتيجة المهمة ليُفتح عند الطلب في Loam Video.`,
    mode: 'standard' as const,
    extData: { outputType: 'video', loamMode: 'media' },
  };
}

export type PresentationVideoRequest = ReturnType<typeof presentationVideoRequest>;

interface PresentationVideoCardProps {
  taskId: string;
  path: string;
  previewPath: string;
  name: string;
  disabled?: boolean;
  onCreateVideo: (request: PresentationVideoRequest) => void | Promise<void>;
}

export function PresentationVideoCard({ taskId, path, previewPath, name, disabled = false, onCreateVideo }: PresentationVideoCardProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(mediaUrl(taskId, previewPath), { headers: await getApiHeaders() });
        if (!response.ok) throw new Error(`preview failed (${response.status})`);
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setPreviewSrc(objectUrl);
      } catch {
        if (!cancelled) setPreviewSrc(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [taskId, previewPath]);

  const createVideo = async () => {
    if (disabled || submitting) return;
    setSubmitting(true);
    try {
      await onCreateVideo(presentationVideoRequest({ path, previewPath }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section data-testid="presentation-video-card" aria-label={t('Make a presentation video')} className="mb-4 flex flex-col items-stretch gap-3 rounded-card border border-border-main bg-bg-menu p-4 shadow-card">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <Clapperboard className="size-4 shrink-0 text-text-secondary" aria-hidden />
          <h3 className="text-sm font-semibold text-text-primary">{t('Let your slides do the talking')}</h3>
        </div>
        <p className="mb-3 max-w-md text-xs leading-5 text-text-secondary">{t('Turn your slides into a video with animation and voiceover to explain your ideas to clients or teammates.')}</p>
        <button
          type="button"
          data-testid="make-presentation-video"
          disabled={disabled || submitting}
          onClick={() => void createVideo()}
          className="inline-flex min-h-9 items-center gap-2 rounded-control bg-text-primary px-3.5 py-2 text-xs font-medium text-bg-menu transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {submitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5 fill-current" aria-hidden />}
          {t(submitting ? 'Starting video…' : 'Make a presentation video')}
        </button>
      </div>
      <div className="block w-full max-w-xs self-end overflow-hidden rounded-control border border-border-main bg-bg-main">
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewSrc} alt={name} className="aspect-video h-full w-full object-cover" />
        ) : (
          <div className="flex aspect-video items-center justify-center text-text-tertiary"><Clapperboard className="size-7" aria-hidden /></div>
        )}
      </div>
    </section>
  );
}
