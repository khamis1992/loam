"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/i18n/t";
import { getApiBase } from "@/services/rpc";
import { Button } from "@/components/ui/Button";
import type { WorkspaceEditorProps } from "../types";
import { SlideThumb, countWords, renderSlide, type SlideLike } from "./SlideView";
import IntelligencePanel from "../intelligence/IntelligencePanel";

interface SlideTextBox { [key: string]: unknown }

interface SlidesArtifact {
  kind: "presentation";
  title: string;
  revision: number;
  sourceId?: string;
  warnings?: string[];
  content: { slides: Array<SlideLike & { id: string; title: string; body: string; notes: string; background: string; accent: string; textBoxes?: SlideTextBox[] }> };
}

interface SlideEdit { title?: string; body?: string; notes?: string }

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; artifact: SlidesArtifact };

type PutResult =
  | { ok: true; artifact: SlidesArtifact }
  | { ok: false; status: number; artifact?: SlidesArtifact; error: string };

const POLL_MS = 8000;

/** Clears a slide's editable text while keeping its layout and text boxes. */
const blankTextBoxes = (boxes: SlideTextBox[]): SlideTextBox[] => {
  const copy = boxes.map((box) => ({ ...box }));
  if (copy[0]) copy[0] = { ...copy[0], text: "" };
  if (copy[1]) copy[1] = { ...copy[1], text: "" };
  return copy;
};

/** Returns the deck with the slide at `index` reduced to an empty shell (layout preserved). */
const withBlankSlide = (artifact: SlidesArtifact, index: number): SlidesArtifact => ({
  ...artifact,
  content: {
    slides: artifact.content.slides.map((slide, i) =>
      i === index ? { ...slide, title: "", body: "", notes: "", textBoxes: blankTextBoxes(slide.textBoxes ?? []) } : slide,
    ),
  },
});

/** One slide per printed page; the interactive chrome is hidden while printing. */
const PRINT_CSS = `
.slides-print-pages { display: none; }
@media print {
  .slides-no-print { display: none !important; }
  .slides-deck-root { display: block !important; height: auto !important; overflow: visible !important; }
  .slides-print-pages { display: block !important; }
  .slides-print-page { break-after: page; page-break-after: always; }
  .slides-print-page:last-child { break-after: auto; page-break-after: auto; }
}`;

export default function Editor({ file, live, onChatEdit }: WorkspaceEditorProps) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [edits, setEdits] = useState<Map<string, SlideEdit>>(new Map());
  const [order, setOrder] = useState<string[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [chat, setChat] = useState("");
  const [realPreview, setRealPreview] = useState(false);
  const [pngUrls, setPngUrls] = useState<Map<string, string>>(new Map());
  const [pngFailed, setPngFailed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [printing, setPrinting] = useState(false);
  const busyRef = useRef(false);
  const pngPendingRef = useRef<Set<string>>(new Set());
  const pngUrlsRef = useRef<Set<string>>(new Set());
  const fileUrl = useMemo(
    () => `${getApiBase()}/api/workspace/slides/file?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}`,
    [file.taskId, file.path],
  );

  const artifact = state.phase === "ready" ? state.artifact : null;
  const slides = useMemo(() => {
    if (!artifact) return [];
    const applied = artifact.content.slides.map((slide) => ({ ...slide, ...(edits.get(slide.id) ?? {}) }));
    if (!order) return applied;
    const byId = new Map(applied.map((s) => [s.id, s]));
    const arranged = order.map((id) => byId.get(id)).filter(Boolean) as typeof applied;
    const extra = applied.filter((s) => !order.includes(s.id));
    return [...arranged, ...extra];
  }, [artifact, edits, order]);
  const current = slides[selected] as (SlideLike & { notes: string }) | undefined;

  const adopt = useCallback((next: SlidesArtifact) => {
    setState({ phase: "ready", artifact: next });
    setEdits(new Map());
    setOrder(null);
    setDirty(false);
    setSelected((prev) => (prev >= next.content.slides.length ? Math.max(0, next.content.slides.length - 1) : prev));
  }, []);

  const reload = useCallback(async (strictError: boolean): Promise<void> => {
    try {
      const res = await fetch(fileUrl);
      const data = (await res.json()) as { artifact?: SlidesArtifact; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (dirty) { setStale(true); return; }
      if (data.artifact) adopt(data.artifact);
      setStale(false);
    } catch (err) {
      if (strictError) setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [adopt, dirty, fileUrl]);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    (async () => {
      try {
        const res = await fetch(fileUrl);
        const data = (await res.json()) as { artifact?: SlidesArtifact; error?: string };
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (data.artifact) { setState({ phase: "ready", artifact: data.artifact }); setSelected(0); }
        else setState({ phase: "error", message: t("Not a presentation file") });
      } catch (err) {
        if (!cancelled) setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [fileUrl]);

  // Live refresh: adopt remote changes when clean, otherwise offer an explicit reload.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      if (busyRef.current) return;
      try {
        const res = await fetch(fileUrl);
        const data = (await res.json()) as { artifact?: SlidesArtifact };
        if (!res.ok || !data.artifact) return;
        const artifact = state.phase === "ready" ? state.artifact : null;
        if (!artifact) { setState({ phase: "ready", artifact: data.artifact }); return; }
        const fetched = data.artifact;
        if (fetched && fetched.revision !== artifact.revision) {
          if (!dirty) { setStale(false); setState({ phase: "ready", artifact: fetched }); setSelected((prev) => (prev >= fetched.content.slides.length ? Math.max(0, fetched.content.slides.length - 1) : prev)); }
          else setStale(true);
        }
      } catch { /* server may be busy; next tick retries */ }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, fileUrl, state, dirty, ]);

  // High-fidelity PNG preview (Windows + PowerPoint only): fetched per (slide, revision),
  // cached in state, cancelled on unmount, with a graceful HTML fallback.
  const revision = artifact?.revision ?? 0;
  const previewKey = `${selected}:${revision}`;
  useEffect(() => {
    if (!realPreview || !artifact) return;
    if (pngUrls.has(previewKey) || pngFailed.has(previewKey) || pngPendingRef.current.has(previewKey)) return;
    const controller = new AbortController();
    pngPendingRef.current.add(previewKey);
    (async () => {
      try {
        const url = `${getApiBase()}/api/workspace/slides/preview?taskId=${encodeURIComponent(file.taskId)}&path=${encodeURIComponent(file.path)}&revision=${revision}&slide=${selected}`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (controller.signal.aborted) return;
        const objectUrl = URL.createObjectURL(blob);
        pngUrlsRef.current.add(objectUrl);
        setPngUrls((prev) => new Map(prev).set(previewKey, objectUrl));
      } catch {
        if (!controller.signal.aborted) setPngFailed((prev) => new Set(prev).add(previewKey));
      } finally {
        pngPendingRef.current.delete(previewKey);
      }
    })();
    return () => { controller.abort(); pngPendingRef.current.delete(previewKey); };
  }, [realPreview, previewKey, artifact, revision, selected, file.taskId, file.path, pngUrls, pngFailed]);
  useEffect(() => () => {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      for (const url of pngUrlsRef.current) URL.revokeObjectURL(url);
    }
  }, []);

  // Find in deck: match indices for the current query (title/body/notes, case-insensitive).
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    return slides
      .map((slide, index) => (`${slide.title}\n${slide.body}\n${slide.notes ?? ""}`.toLowerCase().includes(q) ? index : -1))
      .filter((index) => index >= 0);
  }, [slides, query]);
  const matchPosition = matches.indexOf(selected) + 1;
  const findNext = (): void => {
    if (!matches.length) return;
    setSelected(matches.find((m) => m > selected) ?? matches[0]!);
  };

  const slideWords = current ? countWords(`${current.title} ${current.body} ${current.notes ?? ""}`) : 0;
  const deckWords = useMemo(
    () => slides.reduce((sum, s) => sum + countWords(`${s.title} ${s.body} ${s.notes ?? ""}`), 0),
    [slides],
  );

  const editSlide = (index: number, patch: SlideEdit): void => {
    const slide = slides[index];
    if (!slide) return;
    setEdits((prev) => new Map(prev).set(slide.id, { ...(prev.get(slide.id) ?? {}), ...patch }));
    setDirty(true);
  };

  const move = (index: number, delta: number): void => {
    const list = slides.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const id = list.splice(index, 1)[0]!;
    list.splice(target, 0, id);
    setOrder(list);
    setDirty(true);
    setSelected(target);
  };

  const remove = (index: number): void => {
    if (slides.length <= 1) { setNotice(t("A presentation must keep at least one slide.")); return; }
    const list = slides.map((s) => s.id).filter((_, i) => i !== index);
    setOrder(list);
    setDirty(true);
    setSelected(Math.max(0, Math.min(index, list.length - 1)));
  };

  const duplicate = async (): Promise<void> => {
    if (!artifact || !current) return;
    busyRef.current = true;
    setSaving(true);
    try {
      const res = await fetch(`${getApiBase()}/api/workspace/slides/duplicate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: file.taskId, path: file.path, index: selected, artifact: buildArtifact(), expectedRevision: artifact.revision }),
      });
      const data = (await res.json()) as { artifact?: SlidesArtifact; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.artifact) {
        setState({ phase: "ready", artifact: data.artifact });
        setEdits(new Map()); setOrder(null); setDirty(false); setSavedAt(new Date().toISOString());
        setSelected(selected + 1);
      }
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); busyRef.current = false; }
  };

  /** Add-slide: duplicate the current slide server-side, then persist the copy with its text cleared. */
  const addSlide = async (): Promise<void> => {
    if (!artifact || !current || busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    const knownIds = new Set(artifact.content.slides.map((s) => s.id));
    try {
      const res = await fetch(`${getApiBase()}/api/workspace/slides/duplicate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: file.taskId, path: file.path, index: selected, artifact: buildArtifact(), expectedRevision: artifact.revision }),
      });
      const data = (await res.json()) as { artifact?: SlidesArtifact; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const duplicated = data.artifact;
      if (!duplicated) throw new Error(t("Could not add slide"));
      // The copy is the first slide the server gave a fresh id; fall back to the slot after the source.
      const dupIndex = duplicated.content.slides.findIndex((s) => !knownIds.has(s.id));
      const copyIndex = dupIndex >= 0 ? dupIndex : Math.min(selected + 1, duplicated.content.slides.length - 1);
      const copySlide = duplicated.content.slides[copyIndex]!;

      let working = duplicated;
      let targetIndex = copyIndex;
      for (let attempt = 0; ; attempt++) {
        const put = await putArtifact(withBlankSlide(working, targetIndex), working.revision);
        if (put.ok) {
          setState({ phase: "ready", artifact: put.artifact });
          setEdits(new Map()); setOrder(null); setDirty(false); setStale(false);
          setSavedAt(new Date().toLocaleTimeString());
          setSelected(targetIndex);
          return;
        }
        if (put.status !== 409 || !put.artifact || attempt > 0) throw new Error(put.error);
        // Revision drift: adopt the server's artifact, keep our blank copy, retry once.
        const server = put.artifact;
        const at = server.content.slides.findIndex((s) => s.id === copySlide.id);
        if (at >= 0) {
          working = server;
          targetIndex = at;
        } else {
          const insertAt = Math.min(selected + 1, server.content.slides.length);
          const blanked = { ...copySlide, title: "", body: "", notes: "", textBoxes: blankTextBoxes(copySlide.textBoxes ?? []) };
          working = { ...server, content: { slides: [...server.content.slides.slice(0, insertAt), blanked, ...server.content.slides.slice(insertAt)] } };
          targetIndex = insertAt;
        }
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally { setSaving(false); busyRef.current = false; }
  };

  const putArtifact = async (payload: SlidesArtifact, expectedRevision: number): Promise<PutResult> => {
    try {
      const res = await fetch(`${getApiBase()}/api/workspace/slides/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: file.taskId, path: file.path, artifact: payload, expectedRevision }),
      });
      const data = (await res.json().catch(() => ({}))) as { artifact?: SlidesArtifact; error?: string };
      if (!res.ok) return { ok: false, status: res.status, artifact: data.artifact, error: data.error ?? `HTTP ${res.status}` };
      return { ok: true, artifact: data.artifact ?? payload };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const buildArtifact = (): SlidesArtifact | null => {
    if (!artifact) return null;
    const derived = slides.map((slide) => {
      const edit = edits.get(slide.id) ?? {};
      const title = edit.title ?? slide.title;
      const body = edit.body ?? slide.body;
      const notes = edit.notes !== undefined ? edit.notes : slide.notes;
      const boxes = (slide.textBoxes ?? []).map((box) => ({ ...box }));
      if (boxes[0]) boxes[0] = { ...boxes[0], text: title };
      if (boxes[1]) boxes[1] = { ...boxes[1], text: body };
      return { ...slide, title, body, notes, textBoxes: boxes };
    });
    return { ...artifact, content: { slides: derived } };
  };

  const save = async (): Promise<void> => {
    const payload = buildArtifact();
    if (!payload || !artifact) return;
    busyRef.current = true;
    setSaving(true);
    try {
      const put = await putArtifact(payload, artifact.revision);
      if (!put.ok) throw new Error(put.error);
      setState({ phase: "ready", artifact: put.artifact });
      setEdits(new Map()); setOrder(null); setDirty(false); setStale(false); setNotice(null);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      busyRef.current = false;
    }
  };

  const print = (): void => {
    setPrinting(true);
    try { window.print(); } finally { setPrinting(false); }
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const exportPdf = async (): Promise<void> => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const { exportWorkspacePdf } = await import("../pdfExport");
      const result = await exportWorkspacePdf("slides", file.taskId, file.path);
      if (!result.ok) setNotice(result.error);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setPdfBusy(false);
    }
  };

  const sendChat = (): void => {
    const instruction = chat.trim();
    if (!instruction) return;
    onChatEdit(`Edit ${file.path}: ${instruction}`);
    setChat("");
  };

  if (state.phase === "loading" || state.phase === "error") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-text-secondary">
        <div className="text-sm">{state.phase === "loading" ? t("Loading presentation…") : `${t("Failed to load slides")}: ${state.message}`}</div>
        {state.phase === "error" ? (
          <Button variant="ghost" onClick={() => { setState({ phase: "loading" }); reload(true); }}>{t("Retry")}</Button>
        ) : null}
      </div>
    );
  }

  const pngUrl = realPreview ? pngUrls.get(previewKey) : undefined;
  const pngError = realPreview && pngFailed.has(previewKey);
  const highlight = query.trim() || undefined;

  return (
    <div className={`slides-deck-root flex h-full w-full flex-col${printing ? " slides-printing" : ""}`}>
      <style>{PRINT_CSS}</style>
      <div className="slides-no-print flex items-center gap-2 border-b border-border-main px-3 py-2">
        <div className="truncate text-sm text-text-primary">{file.name}</div>
        {dirty ? <span className="rounded bg-func-warning px-1.5 py-0.5 text-xs text-text-onblack">{t("Unsaved")}</span> : null}
        {savedAt && !dirty ? <span className="text-xs text-text-tertiary">{t("Saved at {time}", { time: savedAt })}</span> : null}
        {notice ? <span className="min-w-0 flex-1 truncate text-xs text-func-error" title={notice}>{notice}</span> : <div className="flex-1" />}
        <input
          className="w-36 rounded border border-border-light bg-bg-menu px-2 py-1 text-xs text-text-primary"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); findNext(); } }}
          placeholder={t("Find in deck")}
          data-testid="slides-find"
        />
        {query.trim() ? (
          <span className="whitespace-nowrap text-xs text-text-tertiary" data-testid="slides-find-count">
            {matches.length ? `${matchPosition}/${matches.length}` : t("No matches")}
          </span>
        ) : null}
        <Button variant={realPreview ? "primary" : "ghost"} onClick={() => setRealPreview((v) => !v)}>{t("Real preview")}</Button>
        <Button variant="ghost" onClick={print}>{t("Print")}</Button>
        <Button variant="ghost" disabled={pdfBusy} onClick={() => { void exportPdf(); }}>{pdfBusy ? t("Exporting…") : t("Export PDF")}</Button>
        <Button variant="primary" disabled={!dirty || saving} onClick={save}>{saving ? t("Saving…") : t("Save")}</Button>
      </div>
      {stale ? (
        <div className="slides-no-print flex items-center gap-2 bg-fill-hover px-3 py-1.5 text-xs text-text-secondary">
          {t("The presentation changed while you were editing")}
          <Button variant="ghost" onClick={() => reload(false)}>{t("Discard my edits and reload")}</Button>
        </div>
      ) : null}
      <div className="slides-no-print flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-44 shrink-0 flex-col gap-2 p-2" data-testid="slides-rail">
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {slides.map((slide, index) => (
              <div key={slide.id} className="flex flex-col gap-1">
                <SlideThumb slide={slide} width={152} selected={selected === index} onSelect={() => setSelected(index)} />
                {selected === index ? (
                  <div className="flex gap-1">
                    <Button variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
                    <Button variant="ghost" disabled={index === slides.length - 1} onClick={() => move(index, 1)}>↓</Button>
                    <Button variant="ghost" disabled={saving} onClick={duplicate}>{t("Duplicate")}</Button>
                    <Button variant="ghost" onClick={() => remove(index)}>{t("Delete")}</Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <Button variant="secondary" disabled={saving} onClick={addSlide}>{t("Add slide")}</Button>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="mx-auto w-full max-w-3xl shadow-card">
            {current ? (
              realPreview && pngUrl ? (
                <div className="relative w-full" style={{ aspectRatio: "16 / 9", background: current.background || "#FFFFFF" }}>
                  {/* Raw PNG from the preview endpoint; the next/image optimizer has nothing to add here. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={pngUrl} alt={current.title || t("Slide preview")} className="h-full w-full object-contain" data-testid="slides-png" />
                </div>
              ) : (
                renderSlide(current, 720, highlight)
              )
            ) : null}
          </div>
          {pngError ? (
            <div className="mx-auto w-full max-w-3xl text-xs text-text-tertiary" data-testid="slides-png-note">
              {t("Real PNG preview requires Windows with Microsoft PowerPoint; showing the built-in render.")}
            </div>
          ) : null}
          {current ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
              <input
                className="w-full rounded border border-border-light bg-bg-menu px-2 py-1.5 text-sm text-text-primary"
                value={current.title}
                onChange={(e) => editSlide(selected, { title: e.target.value })}
                placeholder={t("Slide title")}
              />
              <textarea
                className="min-h-32 w-full rounded border border-border-light bg-bg-menu px-2 py-1.5 text-sm text-text-primary"
                value={current.body}
                onChange={(e) => editSlide(selected, { body: e.target.value })}
                placeholder={t("Slide body")}
              />
              <textarea
                className="min-h-20 w-full rounded border border-border-light bg-bg-menu px-2 py-1.5 text-sm text-text-secondary"
                value={current.notes}
                onChange={(e) => editSlide(selected, { notes: e.target.value })}
                placeholder={t("Speaker notes")}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="slides-no-print">
        <IntelligencePanel file={file} applyDisabled={dirty} onApplied={() => { void reload(false); }} />
      </div>
      <div className="slides-no-print flex items-center gap-2 border-t border-border-main px-3 py-2">
        <span className="whitespace-nowrap text-xs text-text-tertiary" data-testid="slides-word-count">
          {t("Slide words: {count}", { count: slideWords })} · {t("Deck words: {count}", { count: deckWords })}
        </span>
        <input
          className="min-w-0 flex-1 rounded border border-border-light bg-bg-menu px-2 py-1.5 text-sm text-text-primary"
          value={chat}
          onChange={(e) => setChat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
          placeholder={t("Describe a change and the agent will apply it in chat")}
        />
        <Button variant="secondary" onClick={sendChat}>{t("Ask in chat")}</Button>
      </div>
      <div className="slides-print-pages" aria-hidden="true">
        {slides.map((slide) => (
          <div key={slide.id} className="slides-print-page">{renderSlide(slide, 960)}</div>
        ))}
      </div>
    </div>
  );
}
