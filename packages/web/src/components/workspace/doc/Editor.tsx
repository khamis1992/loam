'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Eraser, FileDown, History, Italic, Loader2,
  Printer, RefreshCw, Save, Search, Underline,
} from 'lucide-react';
import { t } from '@/i18n/t';
import type { WorkspaceEditorProps } from '../types';
import { loadDoc, loadDocMeta } from './loadDoc';
import { serializeEditor, splitMarker, normalizeFontSizes } from './serialize';
import { buildTextIndex, countWords, findMatches, replaceAllMatches, replaceMatchAt, selectMatch } from './find';
import { exportWorkspacePdf } from '../pdfExport';
import IntelligencePanel from '../intelligence/IntelligencePanel';
import LegalMatterPanel from '../intelligence/LegalMatterPanel';
import TrackChangesPanel from './TrackChangesPanel';
import {
  TRACK_AUTHOR, adoptTrackedSidecar, applyDocumentTextToBlocks, applyEdit, attachParagraphIds, blockText,
  buildTrackedModel, clearTrackMarkers, inputEventToIntent, placeCaret, renderTrackedDocument,
  selectionToModel, trackedBlockList,
} from './trackEditing';
import { loadDocTrack, saveDocTrack, identityName } from './trackSidecar';
import {
  acceptAll, acceptChange, addCommentThread, rejectAll, rejectChange, removeComment, replyToComment,
  setThreadResolved, type TrackedDocument,
} from '@shared/trackChanges';

const POLL_MS = 2500;

type BlockFormat = 'P' | 'H1' | 'H2' | 'H3';

/** Web-safe defaults plus Arabic-friendly faces; values are execCommand fontName arguments. */
const FONT_FAMILIES = ['Arial', 'Times New Roman', 'Tahoma', 'Segoe UI', 'Consolas', 'Courier New', 'Amiri'];

/** Toolbar px options (the server clamps inline sizes into its valid 4–144 range). */
const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48];

/** The studio's fixed 16 highlight colors (store.ts highlightColors minus "none") with the
 *  sRGB hex each name maps to on the server's nearest-color match, so a swatch round trips
 *  to exactly the same highlight. */
const HIGHLIGHT_PALETTE: Array<{ name: string; hex: string }> = [
  { name: 'yellow', hex: '#ffff00' },
  { name: 'green', hex: '#00ff00' },
  { name: 'cyan', hex: '#00ffff' },
  { name: 'magenta', hex: '#ff00ff' },
  { name: 'blue', hex: '#0000ff' },
  { name: 'red', hex: '#ff0000' },
  { name: 'darkBlue', hex: '#000080' },
  { name: 'darkCyan', hex: '#008080' },
  { name: 'darkGreen', hex: '#008000' },
  { name: 'darkMagenta', hex: '#800080' },
  { name: 'darkRed', hex: '#800000' },
  { name: 'darkYellow', hex: '#808000' },
  { name: 'darkGray', hex: '#808080' },
  { name: 'lightGray', hex: '#c0c0c0' },
  { name: 'black', hex: '#000000' },
  { name: 'white', hex: '#ffffff' },
];

interface ToolbarButtonSpec {
  label: string;
  aria: string;
  icon?: React.ReactNode;
  run: (root: HTMLElement) => void;
}

export default function DocEditor({ file, live, onSave, onChatEdit }: WorkspaceEditorProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
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

  // Find & replace state: current match position inside the live offsets list.
  const [findQuery, setFindQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matchPos, setMatchPos] = useState(-1);
  const [matchTotal, setMatchTotal] = useState(0);
  const [counts, setCounts] = useState({ words: 0, chars: 0 });
  const [exporting, setExporting] = useState(false);

  // Track-changes mode state: the model lives in trackedRef (React state mirrors
  // it for the panel). While ON, all plain-text edits go through beforeinput →
  // model → re-render; the pre-track DOM is snapshotted for a clean exit.
  const [trackMode, setTrackMode] = useState(false);
  const [trackBusy, setTrackBusy] = useState(false);
  const [trackedDoc, setTrackedDoc] = useState<TrackedDocument | null>(null);
  const [trackNotice, setTrackNotice] = useState<string | null>(null);
  const trackedRef = useRef<TrackedDocument | null>(null);
  const snapshotRef = useRef<string>('');
  const trackSaveTimer = useRef<number | null>(null);
  const trackModeRef = useRef(false);
  const pendingContentRef = useRef<string | null>(null);
  useEffect(() => { trackModeRef.current = trackMode; }, [trackMode]);

  const updateCounts = useCallback(() => {
    const surface = surfaceRef.current;
    const text = surface ? buildTextIndex(surface).text : '';
    setCounts({ words: countWords(text), chars: text.length });
  }, []);

  const applyContent = useCallback((html: string) => {
    const { marker, fragment } = splitMarker(html);
    markerRef.current = marker;
    // The surface only renders once `loading` flips false; refresh() calls this
    // while the loader is still up, so stash the fragment and apply it from the
    // surface's ref callback when it mounts.
    if (surfaceRef.current) {
      surfaceRef.current.innerHTML = fragment;
      pendingContentRef.current = null;
    } else {
      pendingContentRef.current = fragment;
    }
    setDirty(false);
    updateCounts();
  }, [updateCounts]);

  const refresh = useCallback(async (): Promise<void> => {
    if (trackModeRef.current) {
      // A reload replaces the surface anyway: flush the sidecar and leave track mode cleanly.
      surfaceRef.current?.removeEventListener('beforeinput', trackInputRef.current);
      if (trackSaveTimer.current !== null) { window.clearTimeout(trackSaveTimer.current); trackSaveTimer.current = null; }
      const pendingDoc = trackedRef.current;
      if (pendingDoc) void saveDocTrack(file, pendingDoc).catch(() => undefined);
      trackedRef.current = null;
      setTrackedDoc(null);
      setTrackMode(false);
      setTrackNotice(null);
    }
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

  /* ------------------------- track-changes mode ------------------------- */

  /** Debounced sidecar PUT (~800ms) of the latest tracked document. */
  const scheduleTrackSave = useCallback((doc: TrackedDocument) => {
    if (trackSaveTimer.current !== null) window.clearTimeout(trackSaveTimer.current);
    trackSaveTimer.current = window.setTimeout(() => {
      trackSaveTimer.current = null;
      void saveDocTrack(file, doc).catch((error) => {
        setTrackNotice(error instanceof Error ? error.message : String(error));
      });
    }, 800);
  }, [file]);

  const enterTrackMode = useCallback(async (): Promise<void> => {
    const surface = surfaceRef.current;
    if (!surface || trackBusy) return;
    setTrackBusy(true);
    setTrackNotice(null);
    try {
      snapshotRef.current = surface.innerHTML;
      const blocks = trackedBlockList(surface);
      const texts = blocks.map(blockText);
      let doc = buildTrackedModel(texts, await identityName());
      let notice: string | null = null;
      try {
        const sidecar = await loadDocTrack(file);
        const adopted = adoptTrackedSidecar(sidecar, texts);
        if (adopted) { doc = adopted; notice = t('Tracked changes resumed.'); }
        else if (sidecar) notice = t('Saved tracked changes no longer match this document — starting fresh.');
      } catch {
        notice = t('Could not load the saved tracked changes.');
      }
      attachParagraphIds(blocks, doc);
      trackedRef.current = doc;
      setTrackedDoc(doc);
      renderTrackedDocument(surface, doc);
      // Imperative capture listener: attached in the same tick as the tracked
      // render so an eager typist cannot slip a native edit past the model.
      surface.addEventListener('beforeinput', trackInputRef.current);
      setTrackMode(true);
      if (notice) setTrackNotice(notice);
    } finally {
      setTrackBusy(false);
    }
  }, [file, trackBusy]);

  /** Leave track mode: with `applyDoc` the resolved plain text is written onto
   *  the surface (then the user saves through the normal flow); without it the
   *  pre-track DOM snapshot is restored untouched. */
  const exitTrackMode = useCallback((applyDoc?: TrackedDocument): void => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.removeEventListener('beforeinput', trackInputRef.current);
    if (applyDoc) {
      applyDocumentTextToBlocks(trackedBlockList(surface), applyDoc, 'final');
      clearTrackMarkers(surface);
      setDirty(true);
    } else {
      surface.innerHTML = snapshotRef.current;
    }
    if (trackSaveTimer.current !== null) {
      window.clearTimeout(trackSaveTimer.current);
      trackSaveTimer.current = null;
    }
    const final = applyDoc ?? trackedRef.current;
    if (final) void saveDocTrack(file, final).catch(() => undefined);
    trackedRef.current = null;
    setTrackedDoc(null);
    setTrackMode(false);
    setTrackNotice(null);
    updateCounts();
  }, [file, updateCounts]);

  /** Model mutation shared by panel actions: apply → re-render → debounce save. */
  const applyTrackMutation = useCallback((mutate: (doc: TrackedDocument) => TrackedDocument): void => {
    const doc = trackedRef.current;
    if (!doc) return;
    try {
      const next = mutate(doc);
      trackedRef.current = next;
      setTrackedDoc(next);
      const surface = surfaceRef.current;
      if (surface) renderTrackedDocument(surface, next);
      scheduleTrackSave(next);
    } catch (error) {
      setTrackNotice(error instanceof Error ? error.message : String(error));
    }
  }, [scheduleTrackSave]);

  // Track-mode editing: intercept beforeinput, translate the caret to a model
  // offset, apply to the model, re-render the tracked view and restore the caret.
  // Attached imperatively in enterTrackMode so typing cannot race the effect.
  const trackInputRef = useRef<(event: Event) => void>(() => undefined);
  trackInputRef.current = (event: Event): void => {
    const surface = surfaceRef.current;
    const doc = trackedRef.current;
    if (!surface || !doc) return;
    event.preventDefault();
    const intent = inputEventToIntent(event as InputEvent);
    if (!intent || intent.kind === 'unsupported') {
      setTrackNotice(intent?.reason === 'paragraph'
        ? t('New paragraphs are disabled while tracking changes.')
        : t('This edit is not supported while tracking changes.'));
      return;
    }
    const selection = selectionToModel(surface);
    if (!selection || !selection.paragraphId) return;
    try {
      const result = applyEdit(doc, selection.paragraphId, selection.start, intent, { authorId: TRACK_AUTHOR.id });
      if (!result) return; // boundary no-op (backspace at paragraph start, …)
      trackedRef.current = result.doc;
      setTrackedDoc(result.doc);
      renderTrackedDocument(surface, result.doc);
      placeCaret(selection.block, result.caret);
      scheduleTrackSave(result.doc);
      setTrackNotice(null);
    } catch (error) {
      setTrackNotice(error instanceof Error ? error.message : String(error));
    }
  };
  // Unmount safety: drop the imperative listener if the editor goes away mid-track.
  useEffect(() => () => {
    const surface = surfaceRef.current;
    if (surface) surface.removeEventListener('beforeinput', trackInputRef.current);
  }, []);

  const addCommentFromSelection = useCallback((text: string): boolean => {
    const surface = surfaceRef.current;
    if (!surface || !trackedRef.current) return false;
    const selection = selectionToModel(surface);
    if (!selection || selection.end <= selection.start) {
      setTrackNotice(t('Select text in the document to comment.'));
      return false;
    }
    applyTrackMutation((doc) => addCommentThread(doc, selection.paragraphId, selection.start, selection.end - selection.start, { authorId: TRACK_AUTHOR.id, text }));
    return true;
  }, [applyTrackMutation]);

  // Rich-text commands must emit inline styles (spans) rather than <font> markup so the
  // serialize whitelist keeps foreColor/hiliteColor/fontName formatting.
  useEffect(() => {
    try { document.execCommand('styleWithCSS', false, 'true'); } catch { /* older engines */ }
  }, []);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  useEffect(() => {
    let mounted = true;
    const timer = setInterval(async () => {
      try {
        const meta = await loadDocMeta(file);
        if (!mounted || meta.mtimeMs === mtimeRef.current || loading) return;
        if (trackModeRef.current || dirtyRef.current) {
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

  /** execCommand only understands sizes 1-7: apply size 7, then rewrite the transient
   *  <font size="7"> markup into a whitelisted <span style="font-size: Npx">. */
  const applyFontSize = (px: number): void => {
    const surface = surfaceRef.current;
    surface?.focus();
    document.execCommand('fontSize', false, '7');
    if (surface) normalizeFontSizes(surface, px);
    setDirty(true);
  };

  /** Jump to the next (delta=1) or previous (delta=-1) match, wrapping around. */
  const stepFind = (delta: number): void => {
    const surface = surfaceRef.current;
    if (!surface || !findQuery) return;
    const offsets = findMatches(buildTextIndex(surface), findQuery);
    setMatchTotal(offsets.length);
    if (!offsets.length) { setMatchPos(-1); return; }
    const next = matchPos < 0
      ? (delta > 0 ? 0 : offsets.length - 1)
      : (matchPos + delta + offsets.length) % offsets.length;
    setMatchPos(next);
    selectMatch(buildTextIndex(surface), offsets[next]!, findQuery.length);
  };

  const onFindQueryChange = (query: string): void => {
    setFindQuery(query);
    setMatchPos(-1);
    const surface = surfaceRef.current;
    setMatchTotal(query && surface ? findMatches(buildTextIndex(surface), query).length : 0);
  };

  const replaceCurrent = (): void => {
    const surface = surfaceRef.current;
    if (!surface || !findQuery || matchPos < 0) return;
    const index = buildTextIndex(surface);
    const offsets = findMatches(index, findQuery);
    if (!offsets.length) return;
    const position = Math.min(matchPos, offsets.length - 1);
    if (!replaceMatchAt(index, offsets[position]!, findQuery.length, replaceText)) return;
    setDirty(true);
    updateCounts();
    const nextOffsets = findMatches(buildTextIndex(surface), findQuery);
    setMatchTotal(nextOffsets.length);
    if (!nextOffsets.length) { setMatchPos(-1); return; }
    const next = Math.min(position, nextOffsets.length - 1);
    setMatchPos(next);
    selectMatch(buildTextIndex(surface), nextOffsets[next]!, findQuery.length);
  };

  const replaceEvery = (): void => {
    const surface = surfaceRef.current;
    if (!surface || !findQuery) return;
    const replaced = replaceAllMatches(buildTextIndex(surface), findQuery, replaceText);
    if (!replaced) return;
    setDirty(true);
    setMatchPos(-1);
    setMatchTotal(0);
    updateCounts();
  };

  const exportPdf = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setMessage(null);
    try {
      const result = await exportWorkspacePdf('doc', file.taskId, file.path);
      setMessage(result.ok ? t('PDF exported: {filename}', { filename: result.filename }) : result.error);
    } finally {
      setExporting(false);
    }
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
    { label: 'L', icon: <AlignLeft className="size-4" />, aria: t('Align left'), run: () => exec('justifyLeft') },
    { label: 'C', icon: <AlignCenter className="size-4" />, aria: t('Align center'), run: () => exec('justifyCenter') },
    { label: 'R', icon: <AlignRight className="size-4" />, aria: t('Align right'), run: () => exec('justifyRight') },
    { label: 'J', icon: <AlignJustify className="size-4" />, aria: t('Justify'), run: () => exec('justifyFull') },
    { label: '⌫', icon: <Eraser className="size-4" />, aria: t('Clear formatting'), run: () => exec('removeFormat') },
  ];

  return (
    <div className="doc-editor-root flex flex-1 flex-col overflow-hidden">
      <style>{`
        @media print {
          .doc-editor-root > *:not(.doc-print-area) { display: none !important; }
          .doc-print-area { overflow: visible !important; height: auto !important; }
          .doc-print-surface { max-width: none !important; border: none !important; box-shadow: none !important; }
        }
        .loam-track-ins { color: #15803d; text-decoration: underline; }
        .loam-track-del { color: #b91c1c; text-decoration: line-through; }
        .loam-track-comment { background-color: rgba(250, 204, 21, 0.4); border-radius: 2px; }
        .loam-track-resolved { background-color: transparent; border-bottom: 1px dotted #9ca3af; }
      `}</style>
      <div className="flex flex-wrap items-center gap-1 border-b border-border-main px-3 py-2">
        {toolbar.map((button) => (
          <button
            key={button.aria}
            type="button"
            title={button.aria}
            aria-label={button.aria}
            disabled={!editable || trackMode}
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={() => button.run(surfaceRef.current ?? (undefined as never))}
            className="min-h-8 min-w-8 rounded-control border border-border-main px-2 text-sm font-medium text-text-secondary hover:bg-fill-hover disabled:opacity-40"
          >
            {button.icon ?? button.label}
          </button>
        ))}
        <select
          aria-label={t('Font family')}
          title={t('Font family')}
          disabled={!editable || trackMode}
          defaultValue=""
          onChange={(event) => { if (event.target.value) exec('fontName', event.target.value); event.target.value = ''; }}
          className="h-8 max-w-36 rounded-control border border-border-main bg-bg-main px-1 text-xs text-text-secondary disabled:opacity-40"
        >
          <option value="">Aa</option>
          {FONT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
        </select>
        <select
          aria-label={t('Font size')}
          title={t('Font size')}
          disabled={!editable || trackMode}
          defaultValue=""
          onChange={(event) => { const px = Number(event.target.value); if (px) applyFontSize(px); event.target.value = ''; }}
          className="h-8 rounded-control border border-border-main bg-bg-main px-1 text-xs text-text-secondary disabled:opacity-40"
        >
          <option value="">px</option>
          {FONT_SIZE_OPTIONS.map((px) => <option key={px} value={px}>{px}</option>)}
        </select>
        <input
          type="color"
          aria-label={t('Text color')}
          title={t('Text color')}
          defaultValue="#18202b"
          disabled={!editable || trackMode}
          onChange={(event) => exec('foreColor', event.target.value)}
          className="size-8 cursor-pointer rounded-control border border-border-main bg-bg-main p-0.5 disabled:opacity-40"
        />
        <select
          aria-label={t('Highlight color')}
          title={t('Highlight color')}
          disabled={!editable || trackMode}
          defaultValue=""
          onChange={(event) => { if (event.target.value) exec('hiliteColor', event.target.value); event.target.value = ''; }}
          className="h-8 rounded-control border border-border-main bg-bg-main px-1 text-xs text-text-secondary disabled:opacity-40"
        >
          <option value="">{t('Highlight color')}</option>
          {HIGHLIGHT_PALETTE.map(({ name, hex }) => (
            <option key={hex} value={hex} style={{ backgroundColor: hex }}>{name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => { if (trackedRef.current) exitTrackMode(); else void enterTrackMode(); }}
          disabled={!editable || trackBusy}
          aria-pressed={trackMode}
          title={t('Track changes')}
          aria-label={t('Track changes')}
          className={`flex min-h-8 items-center gap-1.5 rounded-control border px-3 text-xs font-medium hover:bg-fill-hover disabled:opacity-40 ${trackMode ? 'border-brand bg-brand text-white hover:opacity-90' : 'border-border-main text-text-secondary'}`}
        >
          <History className="size-4" />
          {t('Track changes')}
        </button>
        <span className="grow" />
        {live && <span className="rounded-control bg-fill-tsp px-2 py-1 text-[11px] text-text-secondary">{t('Task running')}</span>}
        <button
          type="button"
          onClick={() => {
            if (trackMode) exitTrackMode();
            void refresh();
          }}
          title={t('Reload')}
          aria-label={t('Reload')}
          className="min-h-8 rounded-control border border-border-main px-3 text-text-secondary hover:bg-fill-hover"
        >
          <RefreshCw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => { void save(); }}
          disabled={!editable || saving || trackMode}
          title={trackMode ? t('Accept or reject all changes before saving.') : undefined}
          className="flex min-h-8 items-center gap-1.5 rounded-control bg-brand px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {dirty ? t('Save changes') : t('Save')}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-border-main px-3 py-1.5">
        <Search className="size-3.5 text-text-tertiary" />
        <input
          value={findQuery}
          onChange={(event) => onFindQueryChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); stepFind(event.shiftKey ? -1 : 1); } }}
          placeholder={t('Find in document')}
          className="h-8 w-40 rounded-control border border-border-main bg-bg-main px-2 text-xs text-text-primary outline-none focus:border-brand"
        />
        {matchTotal > 0 ? (
          <span className="text-[11px] text-text-secondary">
            {t('{current} of {total} matches', { current: (matchPos < 0 ? 0 : matchPos) + 1, total: matchTotal })}
          </span>
        ) : findQuery ? (
          <span className="text-[11px] text-text-secondary">{t('No matches')}</span>
        ) : null}
        <input
          value={replaceText}
          onChange={(event) => setReplaceText(event.target.value)}
          placeholder={t('Replace')}
          className="h-8 w-36 rounded-control border border-border-main bg-bg-main px-2 text-xs text-text-primary outline-none focus:border-brand"
        />
        <button
          type="button"
          onClick={replaceCurrent}
          disabled={!findQuery || matchPos < 0 || trackMode}
          className="min-h-8 rounded-control border border-border-main px-2 text-xs text-text-secondary hover:bg-fill-hover disabled:opacity-40"
        >
          {t('Replace')}
        </button>
        <button
          type="button"
          onClick={replaceEvery}
          disabled={!findQuery || trackMode}
          className="min-h-8 rounded-control border border-border-main px-2 text-xs text-text-secondary hover:bg-fill-hover disabled:opacity-40"
        >
          {t('Replace all')}
        </button>
        <span className="grow" />
        <span className="text-[11px] text-text-tertiary">
          {t('Words: {words} · Characters: {chars}', counts)}
        </span>
        <button
          type="button"
          onClick={() => window.print()}
          title={t('Print')}
          aria-label={t('Print')}
          className="flex min-h-8 items-center gap-1.5 rounded-control border border-border-main px-2 text-xs text-text-secondary hover:bg-fill-hover"
        >
          <Printer className="size-4" />
          {t('Print')}
        </button>
        <button
          type="button"
          onClick={() => { void exportPdf(); }}
          disabled={exporting}
          title={t('Export PDF')}
          aria-label={t('Export PDF')}
          className="flex min-h-8 items-center gap-1.5 rounded-control border border-border-main px-2 text-xs text-text-secondary hover:bg-fill-hover disabled:opacity-40"
        >
          {exporting ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
          {t('Export PDF')}
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
      <div className="doc-print-area flex-1 overflow-y-auto px-6 py-6">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-text-secondary">
            <Loader2 className="size-5 animate-spin" /> {t('Loading')}
          </div>
        ) : (
          <div
            ref={(node) => {
              surfaceRef.current = node;
              if (node && pendingContentRef.current !== null) {
                node.innerHTML = pendingContentRef.current;
                pendingContentRef.current = null;
              }
            }}
            contentEditable={editable}
            suppressContentEditableWarning
            spellCheck={false}
            onInput={() => { setDirty(true); updateCounts(); }}
            className="doc-print-surface mx-auto max-w-3xl rounded-card border border-border-main bg-bg-main px-10 py-8 outline-none [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:text-xl [&_h2]:font-bold [&_h3]:text-lg [&_h3]:font-bold [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-2 [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:border-border-main [&_td]:px-2 [&_td]:py-1 [&_ul]:my-2"
          />
        )}
      </div>
      {trackMode && trackedDoc && (
        <TrackChangesPanel
          doc={trackedDoc}
          notice={trackNotice}
          onAccept={(changeId) => applyTrackMutation((doc) => acceptChange(doc, changeId))}
          onReject={(changeId) => applyTrackMutation((doc) => rejectChange(doc, changeId))}
          onAcceptAll={() => { const doc = trackedRef.current; if (doc) exitTrackMode(acceptAll(doc)); }}
          onRejectAll={() => { const doc = trackedRef.current; if (doc) exitTrackMode(rejectAll(doc)); }}
          onCommentFromSelection={addCommentFromSelection}
          onReply={(threadId, parentId, text) => applyTrackMutation((doc) => replyToComment(doc, threadId, parentId, { authorId: TRACK_AUTHOR.id, text }))}
          onResolve={(threadId, resolved) => applyTrackMutation((doc) => setThreadResolved(doc, threadId, resolved))}
          onDeleteComment={(threadId, commentId) => applyTrackMutation((doc) => removeComment(doc, threadId, commentId))}
        />
      )}
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
