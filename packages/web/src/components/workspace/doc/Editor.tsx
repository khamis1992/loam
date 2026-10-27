'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bold, Italic, Loader2, RefreshCw, Save, Underline } from 'lucide-react';
import { t } from '@/i18n/t';
import type { WorkspaceEditorProps } from '../types';
import { loadDoc, loadDocMeta } from './loadDoc';
import { serializeEditor, splitMarker } from './serialize';
import IntelligencePanel from '../intelligence/IntelligencePanel';
import LegalMatterPanel from '../intelligence/LegalMatterPanel';

const POLL_MS = 2500;

type BlockFormat = 'P' | 'H1' | 'H2' | 'H3';

interface ToolbarButtonSpec {
  label: string;
  aria: string;
  icon?: React.ReactNode;
  run: (root: HTMLElement) => void;
}

export default function DocEditor({ file, live, onSave, onChatEdit }: WorkspaceEditorProps) {  const surfaceRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<string>('');
  const mtimeRef = useRef<number>(0);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editable, setEditable] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [instruction, setInstruction] = useState('');
  const [reloading, setReloading] = useState(false);
  const dirtyRef = useRef(false);
  const applyContent = useCallback((html: string) => {
    const { marker, fragment } = splitMarker(html);
    markerRef.current = marker;
    if (surfaceRef.current) surfaceRef.current.innerHTML = fragment;
    setDirty(false);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setMessage(null);
    try {
      const doc = await loadDoc(file);
      mtimeRef.current = doc.mtimeMs;
      setEditable(doc.editable);
      setWarnings(doc.warnings);
      applyContent(doc.html);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [applyContent, file]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  useEffect(() => {
    let mounted = true;
    const timer = setInterval(async () => {
      try {
        const meta = await loadDocMeta(file);
        if (!mounted || meta.mtimeMs === mtimeRef.current || loading) return;
        if (dirtyRef.current) {
          setMessage(t('The document changed on disk. Save or reload before applying external changes.'));
          return;
        }
        setReloading(true);
        const doc = await loadDoc(file);
        if (!mounted) return;
        mtimeRef.current = doc.mtimeMs;
        setWarnings(doc.warnings);
        setEditable(doc.editable);
        applyContent(doc.html);
        setReloading(false);
        setMessage(t('Document updated by another writer — reloaded.'));
      } catch { /* network hiccup: keep polling */ }
    }, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [applyContent, file, loading]);

  const exec = (command: string, argument?: string): void => {
    surfaceRef.current?.focus();
    document.execCommand(command, false, argument);
    setDirty(true);
  };

  const setBlockType = (format: BlockFormat): void => {
    surfaceRef.current?.focus();
    document.execCommand('formatBlock', false, format);
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    if (!editable || saving) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    setSaving(true);
    setMessage(null);
    try {
      const payload = `${markerRef.current}\n${serializeEditor(surface)}`;
      await onSave(payload);
      const meta = await loadDocMeta(file);
      mtimeRef.current = meta.mtimeMs;
      markerRef.current = markerRef.current.replace(
        /^(<!--\s*doc-session\s+[a-f0-9-]{36}\s+)[^>]*(-->)$/,
        (_all, head, tail) => `${head}${meta.mtimeMs}${tail}`,
      );
      setDirty(false);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text.includes('أعد التحميل') || /mtime|changed/i.test(text) ? t('File changed on disk — reloading the latest version.') : text);
      if (/409|أعد التحميل/.test(text)) void refresh();
    } finally {
      setSaving(false);
    }
  };

  const toolbar: ToolbarButtonSpec[] = [
    { label: 'B', icon: <Bold className="size-4" />, aria: t('Bold'), run: () => exec('bold') },
    { label: 'I', icon: <Italic className="size-4" />, aria: t('Italic'), run: () => exec('italic') },
    { label: 'U', icon: <Underline className="size-4" />, aria: t('Underline'), run: () => exec('underline') },
    { label: 'H1', aria: t('Heading 1'), run: () => setBlockType('H1') },
    { label: 'H2', aria: t('Heading 2'), run: () => setBlockType('H2') },
    { label: 'H3', aria: t('Heading 3'), run: () => setBlockType('H3') },
    { label: '¶', aria: t('Paragraph'), run: () => setBlockType('P') },
    { label: '•', aria: t('Bulleted list'), run: () => exec('insertUnorderedList') },
    { label: '1.', aria: t('Numbered list'), run: () => exec('insertOrderedList') },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b border-border-main px-3 py-2">
        {toolbar.map((button) => (
          <button
            key={button.aria}
            type="button"
            title={button.aria}
            aria-label={button.aria}
            disabled={!editable}
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={() => button.run(surfaceRef.current ?? (undefined as never))}
            className="min-h-8 min-w-8 rounded-control border border-border-main px-2 text-sm font-medium text-text-secondary hover:bg-fill-hover disabled:opacity-40"
          >
            {button.icon ?? button.label}
          </button>
        ))}
        <span className="grow" />
        {live && <span className="rounded-control bg-fill-tsp px-2 py-1 text-[11px] text-text-secondary">{t('Task running')}</span>}
        <button
          type="button"
          onClick={() => { void refresh(); }}
          title={t('Reload')}
          aria-label={t('Reload')}
          className="min-h-8 rounded-control border border-border-main px-2 text-text-secondary hover:bg-fill-hover"
        >
          <RefreshCw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => { void save(); }}
          disabled={!editable || saving}
          className="flex min-h-8 items-center gap-1.5 rounded-control bg-brand px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {dirty ? t('Save changes') : t('Save')}
        </button>
      </div>
      {(warnings.length > 0 || reloading) && (
        <div className="border-b border-border-main bg-fill-tsp px-3 py-2 text-[11px] text-text-secondary">
          {reloading ? `${t('Reloading')}…` : warnings.join(' ')}
        </div>
      )}
      {message && (
        <div className="border-b border-border-main px-3 py-2 text-[11px] text-text-secondary">{message}</div>
      )}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-text-secondary">
            <Loader2 className="size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : (
          <div
            ref={surfaceRef}
            contentEditable={editable}
            suppressContentEditableWarning
            spellCheck={false}
            onInput={() => setDirty(true)}
            className="mx-auto max-w-3xl rounded-card border border-border-main bg-bg-main px-10 py-8 outline-none [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:text-xl [&_h2]:font-bold [&_h3]:text-lg [&_h3]:font-bold [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-2 [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:border-border-main [&_td]:px-2 [&_td]:py-1 [&_ul]:my-2"
          />
        )}
      </div>
      <IntelligencePanel file={file} applyDisabled={dirty} onApplied={() => { void refresh(); }} />
      <LegalMatterPanel file={file} />
      <div className="flex items-center gap-2 border-t border-border-main px-3 py-2">
        <input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && instruction.trim()) {
              onChatEdit(instruction.trim());
              setInstruction('');
            }
          }}
          placeholder={t('Ask the agent to edit this document…')}
          className="h-row flex-1 rounded-control border border-border-main bg-bg-main px-3 text-sm outline-none focus:border-brand"
        />
        <button
          type="button"
          disabled={!instruction.trim()}
          onClick={() => { onChatEdit(instruction.trim()); setInstruction(''); }}
          className="min-h-8 rounded-control border border-border-main px-3 text-sm text-text-secondary hover:bg-fill-hover disabled:opacity-40"
        >
          {t('Chat edit')}
        </button>
      </div>
    </div>
  );
}
