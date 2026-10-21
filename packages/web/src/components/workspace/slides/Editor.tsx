"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/i18n/t";
import { getApiBase } from "@/services/rpc";
import { Button } from "@/components/ui/Button";
import type { WorkspaceEditorProps } from "../types";
import { SlideThumb, renderSlide, type SlideLike } from "./SlideView";

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

const POLL_MS = 8000;

export default function Editor({ file, live, onSave, onChatEdit }: WorkspaceEditorProps) {
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
  const busyRef = useRef(false);
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
      const res = await fetch(`${getApiBase()}/api/workspace/slides/file`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: file.taskId, path: file.path, artifact: payload, expectedRevision: artifact.revision }),
      });
      const data = (await res.json()) as { artifact?: SlidesArtifact; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const raw = await fetch(`${fileUrl}&raw=1`);
      const blob = await raw.blob();
      await onSave(blob);
      if (data.artifact) setState({ phase: "ready", artifact: data.artifact });
      setEdits(new Map()); setOrder(null); setDirty(false); setStale(false); setNotice(null);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      busyRef.current = false;
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

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-main px-3 py-2">
        <div className="truncate text-sm text-text-primary">{file.name}</div>
        {dirty ? <span className="rounded bg-func-warning px-1.5 py-0.5 text-xs text-text-onblack">{t("Unsaved")}</span> : null}
        {savedAt && !dirty ? <span className="text-xs text-text-tertiary">{t("Saved at {time}", { time: savedAt })}</span> : null}
        {notice ? <span className="min-w-0 flex-1 truncate text-xs text-func-error" title={notice}>{notice}</span> : <div className="flex-1" />}
        <Button variant="primary" disabled={!dirty || saving} onClick={save}>{saving ? t("Saving…") : t("Save")}</Button>
      </div>
      {stale ? (
        <div className="flex items-center gap-2 bg-fill-hover px-3 py-1.5 text-xs text-text-secondary">
          {t("The presentation changed while you were editing")}
          <Button variant="ghost" onClick={() => reload(false)}>{t("Discard my edits and reload")}</Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-44 shrink-0 flex-col gap-2 overflow-y-auto p-2" data-testid="slides-rail">
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
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="mx-auto w-full max-w-3xl shadow-card">{current ? renderSlide(current, 720) : null}</div>
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
      <div className="flex items-center gap-2 border-t border-border-main px-3 py-2">
        <input
          className="min-w-0 flex-1 rounded border border-border-light bg-bg-menu px-2 py-1.5 text-sm text-text-primary"
          value={chat}
          onChange={(e) => setChat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
          placeholder={t("Describe a change and the agent will apply it in chat")}
        />
        <Button variant="secondary" onClick={sendChat}>{t("Ask in chat")}</Button>
      </div>
    </div>
  );
}
