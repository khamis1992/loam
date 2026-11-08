'use client';

import { useEffect, useRef, useState } from 'react';
import { routineSendRequested, type BuildSelection } from '@shared/buildMenu';
import { getLocale, isRtl, t } from '@/i18n/t';
import { BuildLauncher } from './BuildLauncher';
import { BuildKindDialog } from './BuildKindDialog';
import { previewFrame } from './previewFrame';
import { bindPreviewMessages } from './previewBridge';
import { activateBuildRoutine, cancelBuildJob, disableBuildRoutine, packageBuildProject, pauseBuildRoutine, prepareBuildProject, previewBuildProject, readBuildJob, readBuildMenuEnabled, resumeBuildRoutine } from '@/services/buildMenuApi';

const MIN_BRIEF = 10;
const focusRing = 'text-text-primary [&_button]:focus-visible:outline [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_textarea]:focus-visible:outline [&_textarea]:focus-visible:outline-2 [&_textarea]:focus-visible:outline-offset-2';

function extensionScopeExcluded(brief: string): boolean {
  return /(periodic|background|service worker|webhook|alarms?|remote|كل ساعة|خلفية|شبكة|تشغيل دوري)/i.test(brief);
}
function previewStillOpen(phase: string | undefined): boolean {
  return phase === undefined || phase === 'running' || phase === 'completed';
}
function packageStopped(phase: string | undefined): boolean {
  return phase === 'cancelled' || phase === 'stopping' || phase === 'failed';
}
function panelSummary(kind: BuildSelection['kind'], summary: string): string | null {
  if (kind === 'mobile' && /\bapk\b/i.test(summary)) return null;
  if ((kind === 'desktop' || kind === 'widget') && /portable-exe|\.exe\b/i.test(summary)) return null;
  if (kind === 'chrome-extension' && /loaded the extension|extension was loaded|extension loaded|تم تحميل|الإضافة محمّلة/i.test(summary)) return null;
  if (kind === 'notebook' && /sha256:|image digest|\b[a-f0-9]{64}\b/i.test(summary)) return null;
  if (kind === 'safari-extension' && /safari was tested|safari tested|تم اختبار سفاري/i.test(summary)) return null;
  return summary;
}
function quietHtml(kind: BuildSelection['kind'], html: string | null | undefined): string | null {
  if (!html) return null;
  if (kind === 'notebook') return html.replace(/"digest"\s*:\s*"[^"]+"/gi, '"digest":null').replace(/sha256:[a-f0-9]{64}/gi, '').replace(/\b[a-f0-9]{64}\b/gi, '');
  if (kind === 'mobile') return html.replace(/\bapk\b/gi, '');
  if (kind === 'chrome-extension') return html.replace(/loaded the extension|extension was loaded|extension loaded|تم تحميل|الإضافة محمّلة/gi, '');
  if (kind === 'desktop' || kind === 'widget') return html.replace(/portable-exe|\.exe\b/gi, '');
  return html;
}

function publishHandoff(kind: BuildSelection['kind']): string {
  switch (kind) {
    case 'website':
      return 'The site stays on this computer. Nothing was uploaded.';
    case 'desktop':
      return 'A portable app was not built. It would be unsigned.';
    case 'widget':
      return 'The widget does not start with the computer from here. Nothing was published.';
    case 'automation':
      return 'Reports stay local. No message was sent and no schedule was published.';
    case 'notebook':
      return 'The notebook exports as a local file. No kernel was uploaded.';
    case 'mobile':
      return 'This is not a store upload. A local package is not an installed app.';
    case 'chrome-extension':
      return 'Load the extension manually from its folder. It was not published to the Chrome Web Store.';
    case 'safari-extension':
      return 'This computer has Xcode source only. Safari was not tested and nothing was published.';
    case 'game':
      return 'The game stays in its local folder. Nothing was uploaded and no engine was installed.';
    default: {
      const unknown: never = kind;
      return unknown;
    }
  }
}

export function BuildMenuEntry({ enabled }: { enabled?: boolean } = {}) {
  const [gate, setGate] = useState<boolean | null>(enabled ?? null);
  const [legacy, setLegacy] = useState(false);
  const [selection, setSelection] = useState<BuildSelection | null>(null);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [routineEnabled, setRoutineEnabled] = useState<boolean | null>(null);
  const [routinePaused, setRoutinePaused] = useState(false);
  const [notebookClose, setNotebookClose] = useState(false);
  const [keepPreview, setKeepPreview] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const keepPreviewRef = useRef(false);
  const previewAttempt = useRef(0);
  const previewNode = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!previewUrl || !previewNonce) return;
    return bindPreviewMessages(previewNode.current, window.location.origin, previewUrl, previewNonce);
  }, [previewUrl, previewNonce]);
  useEffect(() => {
    if (!projectId || !previewJobId) return;
    let live = true;
    const tick = (): void => {
      void readBuildJob(projectId, previewJobId).then((job) => {
        if (!live) return;
        if (job.jobId && job.jobId !== previewJobId) return;
        if (typeof job.revision === 'number' && revision !== null && job.revision !== revision) return;
        if (job.phase === 'stopping' || job.phase === 'cancelled') {
          live = false;
          setPreviewUrl(null);
          setPreviewNonce(null);
          setStopping(true);
          return;
        }
        if (job.phase !== 'failed' || job.message !== 'preview_exited') return;
        live = false;
        setPreviewUrl(null);
        setPreviewNonce(null);
        setStopping(false);
        setError(t('The preview stopped after it exited. Nothing was packaged.'));
      }).catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [projectId, previewJobId, revision]);
  useEffect(() => {
    if (!projectId || !previewJobId || !selection || selection.kind === 'widget') return;
    const project = projectId;
    const job = previewJobId;
    return () => {
      if (keepPreviewRef.current) return;
      void cancelBuildJob(project, job).catch(() => undefined);
    };
  }, [projectId, previewJobId, selection]);
  useEffect(() => {
    if (!previewJobId || selection?.kind !== 'notebook') return;
    const ask = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [previewJobId, selection]);
  useEffect(() => {
    if (enabled !== undefined) return;
    let live = true;
    readBuildMenuEnabled().then((value) => { if (live) setGate(value); }).catch(() => { if (live) setGate(false); });
    return () => { live = false; };
  }, [enabled]);

  if (gate !== true || legacy) return <BuildLauncher />;
  if (!selection) {
    return (
      <div dir={isRtl(getLocale()) ? 'rtl' : 'ltr'} lang={getLocale()} className={focusRing}>
        <BuildKindDialog
          onClose={() => setLegacy(true)}
          onSelect={(next, prompt) => {
            setSelection(next);
            if (prompt) setBrief(prompt);
          }}
        />
        <button type="button" onClick={() => setLegacy(true)}>{t('Previous path')}</button>
      </div>
    );
  }

  const title = brief.trim().split(/\r?\n/)[0]?.slice(0, 80) || 'مشروع';
  const prepare = async () => {
    if (brief.trim().length < MIN_BRIEF || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await prepareBuildProject({ title, brief: brief.trim(), selection });
      setProjectId(result.projectId);
      setRevision(result.revision);
      setSummary(panelSummary(selection.kind, `${result.engine}: ${result.summary}`));
      setPreviewHtml(quietHtml(selection.kind, result.previewHtml));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    if (!projectId || revision === null || busy) return;
    const attempt = previewAttempt.current + 1;
    previewAttempt.current = attempt;
    const expectedProject = projectId;
    const expectedRevision = revision;
    setBusy(true);
    setError(null);
    setStopping(false);
    try {
      const result = await previewBuildProject({ projectId, revision, title, brief: brief.trim() });
      const matchesAttempt = attempt === previewAttempt.current;
      const matchesProject = result.projectId === expectedProject;
      const matchesRevision = result.revision === expectedRevision;
      const open = matchesAttempt && matchesProject && matchesRevision && Boolean(result.jobId) && previewStillOpen(result.phase);
      if (!open) {
        if (matchesProject && result.jobId && (!matchesAttempt || !matchesRevision || result.phase === 'stopping' || result.phase === 'cancelled')) {
          void cancelBuildJob(expectedProject, result.jobId).catch(() => undefined);
        }
        setPreviewUrl(null);
        setPreviewNonce(null);
        if (!matchesAttempt) {
          back();
          return;
        }
        if (!matchesRevision || result.phase === 'stopping' || result.phase === 'cancelled') {
          setStopping(true);
          return;
        }
        setError(result.message === 'preview_exited'
          ? t('The preview stopped after it exited. Nothing was packaged.')
          : (result.message ?? t('The preview is stopping. It will not become ready.')));
        return;
      }
      keepPreviewRef.current = false;
      setKeepPreview(false);
      setStopping(false);
      setPreviewJobId(result.jobId);
      if (result.previewUrl) {
        setPreviewUrl(result.previewUrl);
        setPreviewNonce(/^[a-f0-9]{32}$/.test(result.previewNonce ?? '') ? result.previewNonce ?? null : null);
        setPreviewHtml(null);
      } else {
        setPreviewUrl(null);
        setPreviewNonce(null);
        if (result.previewHtml) setPreviewHtml(quietHtml(selection.kind, result.previewHtml));
      }
      if (result.summary) setSummary(panelSummary(selection.kind, result.summary));
    } catch (cause) {
      if (attempt !== previewAttempt.current) {
        back();
        return;
      }
      const raw = cause instanceof Error ? cause.message : String(cause);
      if ((selection.kind === 'desktop' || selection.kind === 'widget') && raw === 'missing_requirement') {
        setError(t('A window was not opened on this computer. The page above is not an Electron window.'));
      } else {
        setError(raw);
      }
    } finally {
      setBusy(false);
    }
  };

  const pack = async () => {
    if (!projectId || revision === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await packageBuildProject({ projectId, revision, title, brief: brief.trim() });
      if (packageStopped(result.phase)) {
        setArtifactId(null);
        setError(t('The package stopped. Nothing new was saved.'));
        return;
      }
      setArtifactId(result.artifactId ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const packKind = async (format: 'ipynb' | 'web-zip' | 'mv3-zip') => {
    if (!projectId || revision === null || busy) return;
    switch (format) {
      case 'ipynb':
        if (selection.kind !== 'notebook') return;
        break;
      case 'web-zip':
        if (selection.kind !== 'game') return;
        break;
      case 'mv3-zip':
        if (selection.kind !== 'chrome-extension') return;
        break;
      default: {
        const unknown: never = format;
        return unknown;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const result = await packageBuildProject({ projectId, revision, title, brief: brief.trim(), format });
      if (packageStopped(result.phase)) {
        setArtifactId(null);
        setError(t('The package stopped. Nothing new was saved.'));
        return;
      }
      setArtifactId(result.artifactId ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const packWebsite = async () => {
    if (!projectId || revision === null || busy || selection.kind !== 'website') return;
    setBusy(true);
    setError(null);
    setArtifactId(null);
    try {
      const result = await packageBuildProject({ projectId, revision, title, brief: brief.trim(), format: 'web-zip' });
      if (packageStopped(result.phase) || !result.artifactId) {
        setError(t('The site package was not built. No locked package was downloaded, and this is not a Vite build.'));
        return;
      }
      setArtifactId(result.artifactId);
    } catch {
      setError(t('The site package was not built. No locked package was downloaded, and this is not a Vite build.'));
    } finally {
      setBusy(false);
    }
  };
  const packSafari = async () => {
    if (!projectId || revision === null || busy || selection.kind !== 'safari-extension') return;
    setBusy(true);
    setError(null);
    setArtifactId(null);
    try {
      const result = await packageBuildProject({ projectId, revision, title, brief: brief.trim(), format: 'xcode-source' });
      if (packageStopped(result.phase) || !result.artifactId) {
        setError(t('An Xcode project was not built on this computer. Safari itself was not tested.'));
        return;
      }
      setArtifactId(result.artifactId);
    } catch {
      setError(t('An Xcode project was not built on this computer. Safari itself was not tested.'));
    } finally {
      setBusy(false);
    }
  };
  const packPortable = async () => {
    if (!projectId || revision === null || busy || selection.kind !== 'desktop') return;
    setBusy(true);
    setError(null);
    setArtifactId(null);
    try {
      const result = await packageBuildProject({ projectId, revision, title, brief: brief.trim(), format: 'portable-exe' });
      if (packageStopped(result.phase)) {
        setError(t('The package stopped. Nothing new was saved.'));
        return;
      }
      setError(t('A portable app was not built. It would be unsigned.'));
    } catch {
      setError(t('A portable app was not built. It would be unsigned.'));
    } finally {
      setBusy(false);
    }
  };
  const setRoutine = async (enabled: boolean) => {
    if (!projectId || selection.kind !== 'automation' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = enabled ? await activateBuildRoutine(projectId) : await disableBuildRoutine(projectId);
      setRoutineEnabled(result.enabled);
      if (!enabled) setRoutinePaused(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const pauseRoutine = async (paused: boolean) => {
    if (!projectId || selection.kind !== 'automation' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = paused ? await pauseBuildRoutine(projectId) : await resumeBuildRoutine(projectId);
      setRoutinePaused(result.paused);
      setRoutineEnabled(result.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    setNotebookClose(false);
    setStopping(false);
    setHandoff(false);
    setFolderNote(null);
    setSelection(null);
    setPreviewHtml(null);
    setPreviewUrl(null);
    setPreviewNonce(null);
    setPreviewJobId(null);
    setSummary(null);
    setRoutineEnabled(null);
    setRoutinePaused(false);
  };

  const leavePreview = () => {
    if (busy) {
      previewAttempt.current += 1;
      if (!previewJobId) {
        setStopping(true);
        return;
      }
    }
    back();
  };

  const requestBack = () => {
    if (selection.kind === 'notebook' && previewJobId && !keepPreview) {
      setNotebookClose(true);
      return;
    }
    leavePreview();
  };

  const revealArtifact = async () => {
    if (!projectId || !artifactId) return;
    const desktop = (window as unknown as { __apis?: { buildMenu?: { revealArtifact?: (body: { projectId: string; artifactId: string }) => Promise<void> } } }).__apis?.buildMenu?.revealArtifact;
    if (!desktop) {
      setFolderNote(t('This window cannot open the project folder. The file stays in the project.'));
      return;
    }
    try {
      await desktop({ projectId, artifactId });
      setFolderNote(null);
    } catch (cause) {
      setFolderNote(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const frame = previewUrl ? previewFrame(previewUrl, window.location.origin) : null;
  return (
    <section aria-label={t('Prepare project')} dir={isRtl(getLocale()) ? 'rtl' : 'ltr'} lang={getLocale()} className={focusRing}>
      <button type="button" onClick={requestBack}>{t('Back')}</button>
      <textarea
        data-testid="build-menu-brief"
        value={brief}
        onChange={(event) => setBrief(event.target.value)}
        rows={4}
      />
      <button type="button" onClick={prepare} disabled={busy || brief.trim().length < MIN_BRIEF}>{t('Prepare the project')}</button>
      {projectId ? <button type="button" onClick={preview} disabled={busy}>{t('Preview project')}</button> : null}
      {previewJobId && selection.kind !== 'widget' ? (
        <label>
          <input
            type="checkbox"
            data-testid="build-keep-preview"
            checked={keepPreview}
            onChange={(event) => {
              keepPreviewRef.current = event.target.checked;
              setKeepPreview(event.target.checked);
            }}
          />
          {t('Keep this preview running after close')}
        </label>
      ) : null}
      {projectId ? <button type="button" onClick={pack} disabled={busy}>{t('Export source')}</button> : null}
      {projectId ? <button type="button" onClick={() => setHandoff(true)}>{t('Publish')}</button> : null}
      {handoff ? <p data-testid="build-publish-handoff">{t(publishHandoff(selection.kind))}</p> : null}
      {projectId && selection.kind === 'website' ? <button type="button" onClick={() => void packWebsite()} disabled={busy}>{t('Export website package')}</button> : null}
      {projectId && selection.kind === 'desktop' ? <button type="button" onClick={packPortable} disabled={busy}>{t('Portable app')}</button> : null}
      {projectId && selection.kind === 'notebook' ? <button type="button" onClick={() => void packKind('ipynb')} disabled={busy}>{t('Export notebook')}</button> : null}
      {projectId && selection.kind === 'game' ? <button type="button" onClick={() => void packKind('web-zip')} disabled={busy}>{t('Export game package')}</button> : null}
      {projectId && selection.kind === 'chrome-extension' ? <button type="button" onClick={() => void packKind('mv3-zip')} disabled={busy}>{t('Export extension')}</button> : null}
      {projectId && selection.kind === 'safari-extension' ? <button type="button" onClick={() => void packSafari()} disabled={busy}>{t('Export Xcode project')}</button> : null}
      {projectId && selection.kind === 'automation' ? <button type="button" onClick={() => void setRoutine(true)} disabled={busy}>{t('Activate local reports')}</button> : null}
      {projectId && selection.kind === 'automation' ? <button type="button" onClick={() => void setRoutine(false)} disabled={busy}>{t('Disable local reports')}</button> : null}
      {projectId && selection.kind === 'automation' ? <button type="button" onClick={() => void pauseRoutine(true)} disabled={busy}>{t('Pause local reports')}</button> : null}
      {projectId && selection.kind === 'automation' ? <button type="button" onClick={() => void pauseRoutine(false)} disabled={busy}>{t('Resume local reports')}</button> : null}
      {selection.kind === 'automation' && routineSendRequested(brief) ? <p data-testid="build-send-block">{t('Sending stays blocked until a separate approval. No message was sent.')}</p> : null}
      {stopping ? <p role="status" data-testid="build-preview-stopping">{t('The preview is stopping. It will not become ready.')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {routineEnabled === true ? <p data-testid="build-routine-state">{t('Local reports are on')}</p> : null}
      {routineEnabled === false ? <p data-testid="build-routine-state">{t('Local reports are off')}</p> : null}
      {routinePaused ? <p data-testid="build-routine-paused">{t('Local reports are paused')}</p> : null}
      {selection.kind === 'safari-extension' ? <p data-testid="build-safari-note">{t('This computer has Xcode source only. Safari was not tested and nothing was published.')}</p> : null}
      {selection.kind === 'chrome-extension' ? <p data-testid="build-chrome-note">{t('activeTab lasts only for the current page. all_urls is not granted.')} {t('Load the extension manually from its folder. It was not published to the Chrome Web Store.')}</p> : null}
      {(selection.kind === 'chrome-extension' || selection.kind === 'safari-extension') && extensionScopeExcluded(brief) ? <p data-testid="build-extension-scope">{t('This request stays outside the extension: no periodic background and no network.')}</p> : null}
      {selection.kind === 'widget' ? <p data-testid="build-widget-note">{t('Startup with the computer is unavailable. A portable build has no stable install path.')}</p> : null}
      {selection.kind === 'mobile' ? <p data-testid="build-mobile-note">{t('This is a web simulation, not an Android emulator. Source export is not an APK.')}</p> : null}
      {selection.kind === 'notebook' ? <p data-testid="build-notebook-note">{t('No cell ran on this computer. The notebook can be edited and exported without a container.')}</p> : null}
      {notebookClose ? (
        <div role="dialog" aria-label={t('Close the notebook')}>
          <p>{t('Closing the notebook stops the preview. Text that was not saved with Save cell stays out of the file.')}</p>
          <button type="button" onClick={() => setNotebookClose(false)}>{t('Stay and save')}</button>
          <button type="button" onClick={() => { setNotebookClose(false); leavePreview(); }}>{t('Stop without a new save')}</button>
        </div>
      ) : null}
      {selection.kind === 'website' ? <p data-testid="build-website-note">{t('The site package comes from the build folder only. No Vite build ran and nothing was downloaded.')}</p> : null}
      {selection.kind === 'game' ? <p data-testid="build-game-note">{t('This is a local canvas game. No game engine was installed.')}</p> : null}
      {summary ? <p>{summary}</p> : null}
      {artifactId && !/\bapk\b|\.exe\b|sha256:|\b[a-f0-9]{64}\b|loaded the extension/i.test(artifactId) ? <p>{artifactId}</p> : null}
      {artifactId && projectId && !/\bapk\b|\.exe\b|sha256:|\b[a-f0-9]{64}\b|loaded the extension/i.test(artifactId) ? <button type="button" onClick={() => void revealArtifact()}>{t('Show the file')}</button> : null}
      {folderNote ? <p data-testid="build-reveal-note">{folderNote}</p> : null}
      {frame ? <iframe ref={previewNode} title={t('Preview project')} sandbox={frame.sandbox} src={frame.src} /> : null}
      {previewUrl && !frame ? <p data-testid="build-preview-origin">{t('This preview address is not a separate local page. It was not opened.')}</p> : null}
      {previewHtml ? <iframe title={t('Preview project')} sandbox="allow-scripts" srcDoc={previewHtml} /> : null}
    </section>
  );
}
