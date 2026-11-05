'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PanelRight, Hammer } from 'lucide-react';
import clsx from 'clsx';
import { useAppDispatch } from '@/store';
import { addSession, loadSessions } from '@/store/sessionsSlice';
import { t } from '@/i18n/t';
import { Composer, ComposerContextBar, type ComposerHandle, type ProjectOption } from '@/components/chat/Composer';
import { HomeCard } from '@/components/home/HomeCard';
import { CreditsPopover } from '@/components/home/CreditsPopover';
import { TemplateCard } from '@/components/home/TemplateCard';
import { TEMPLATE_PREVIEWS, TemplatePreviewDialog, type TemplatePreview } from '@/components/home/TemplatePreviewDialog';
import { ModelMenu, type AgentModel } from '@/components/home/ModelMenu';
import { StartFromFileCard, type LocalFileSelection } from '@/components/home/StartFromFileCard';
import { StudioGoalDialog, StudioPickerDialog } from '@/components/home/StudioGoalDialogs';
import { BUILD_GOALS, CREATE_GOALS, type StudioGoal } from '@/components/home/studioGoals';
import { SidePanel } from '@/components/home/SidePanel';
import { PromoBanner, type PromoTarget } from '@/components/home/PromoBanner';
import { LogoMark } from '@/components/home/LogoMark';
import { BuildIllustration, CreateIllustration, CreateMark } from '@/components/home/BuildIllustration';
import { useBranch } from '@/components/home/useBranch';
import { uploadFile, type Attachment } from '@/services/upload';
import { desktopApis, isDesktop } from '@/services/desktopApis';
import { getSessionToken, getApiBase, getApiHeaders } from '@/services/rpc';
import { fetchProjects } from '@/services/projectContextApi';
import { shortUid } from '@/utils/uid';
import type { TaskMode } from '@shared/socket';
import { craftFrameUrl } from '@/lib/craftBridge';

const MODEL_KEY = 'agent-studio:model';

function readStoredModel(): AgentModel {
  if (typeof window === 'undefined') return 'standard';
  const stored = localStorage.getItem(MODEL_KEY);
  if (stored === 'max' || stored === 'standard' || stored === 'lite' || stored === 'flex') return stored;
  return 'standard';
}

function getDownloadsPath(): string | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    __apis?: { system?: { getDownloadsPath?: () => string | null | Promise<string | null> } };
    desktopSync?: { env?: Record<string, string> };
  };
  const fromEnv = w.desktopSync?.env?.DOWNLOADS_PATH;
  if (fromEnv) return fromEnv;
  const getter = w.__apis?.system?.getDownloadsPath;
  if (!getter) return null;
  const result = getter();
  if (typeof result === 'string') return result;
  return null;
}

export default function HomePage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const composerRef = useRef<ComposerHandle>(null);

  const [picker, setPicker] = useState<'build' | 'create' | null>(null);
  const [activeGoal, setActiveGoal] = useState<StudioGoal | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<TemplatePreview | null>(null);
  const [goalDraft, setGoalDraft] = useState<string | undefined>(undefined);
  const [localSelection, setLocalSelection] = useState<LocalFileSelection | null>(null);
  const [homeNotice, setHomeNotice] = useState('');
  const [model, setModel] = useState<AgentModel>(readStoredModel);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeFolder, setActiveFolder] = useState<'project' | 'downloads' | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [downloadsPath, setDownloadsPath] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [update, setUpdate] = useState<{ title: string; subtitle: string; version?: string; available: boolean } | null>(null);
  const [defaultLoamMode, setDefaultLoamMode] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const desktopBranch = useBranch();
  const branch = desktopBranch;

  useEffect(() => {
    localStorage.setItem(MODEL_KEY, model);
  }, [model]);

  useEffect(() => {
    if (!isDesktop()) return;
    const frame = document.createElement('iframe');
    frame.src = craftFrameUrl('slides');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:1px;height:1px;inset-inline-start:-2px;bottom:0;border:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(frame);
    const timer = window.setTimeout(() => frame.remove(), 15_000);
    return () => {
      window.clearTimeout(timer);
      frame.remove();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    fetchProjects()
      .then((list) => { if (mounted) setProjects(list); })
      .catch(() => {
        // Loam server API unavailable: the chip keeps the folder dialog.
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadLocalCredits = getApiHeaders()
      .then((headers) => fetch(`${getApiBase()}/api/credits`, { headers }))
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data.balance === 'number' ? data.balance : null;
      })
      .catch(() => null);
    const loadProtocolCredits = getSessionToken().then((token) => {
      if (!token) return null;
      return fetch(`${getApiBase()}/user.v1.UserService/GetAvailableCredits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Authorization': `Bearer ${token}`,
        },
        body: '{}',
      })
        .then(async (res) => {
          if (!res.ok) return null;
          const data = await res.json();
          return typeof data.total_credits === 'number' ? data.total_credits
            : typeof data.totalCredits === 'number' ? data.totalCredits
            : 0;
        })
        .catch(() => null);
    });
    // Local mock ledger first (OPD #9); fall back to the legacy protocol API.
    void loadLocalCredits.then((local) => {
      if (cancelled) return;
      if (local !== null) {
        setCredits(local);
        return;
      }
      void loadProtocolCredits.then((total) => {
        if (cancelled || total === null) return;
        setCredits(total > 0 ? total : null);
      });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    desktopApis.updater.getStatus()
      .then((status) => {
        if (status.storeManaged || status.store) {
          setUpdate(null);
          return;
        }
        if (status.state === 'available' || status.state === 'downloaded') {
          setUpdate({
            title: t('Update available'),
            subtitle: t('Version {version} or later', { version: status.version ?? '' }),
            version: status.version,
            available: true,
          });
        } else {
          setUpdate(null);
        }
      })
      .catch(() => setUpdate(null));
  }, []);

  const cwd = useMemo(() => {
    if (activeFolder === 'project') return projectPath;
    if (activeFolder === 'downloads') return downloadsPath;
    return null;
  }, [activeFolder, projectPath, downloadsPath]);

  const chooseProject = async () => {
    try {
      const res = await desktopApis.system.showFolderDialog();
      if (res && typeof res === 'object' && 'path' in res && typeof (res as { path?: unknown }).path === 'string') {
        setProjectPath((res as { path: string }).path);
        setActiveFolder('project');
        setProjectId(null);
      }
    } catch {
      // ignore
    }
  };

  const selectProjectOption = (project: ProjectOption | null) => {
    setProjectId(project?.id ?? null);
    if (project?.folder) {
      setProjectPath(project.folder);
      setActiveFolder('project');
    } else if (!project) {
      setActiveFolder(null);
      setProjectPath(null);
      setWorktreeEnabled(false);
    }
  };

  const selectDownloads = () => {
    const path = getDownloadsPath();
    setDownloadsPath(path);
    setActiveFolder('downloads');
  };

  const prefillComposer = (prompt: string, loamMode?: string) => {
    composerRef.current?.setText(prompt);
    composerRef.current?.focus();
    setDefaultLoamMode(loamMode);
  };

  const addFilesToComposer = (files: File[], selection: LocalFileSelection) => {
    composerRef.current?.addFiles(files);
    setLocalSelection(selection);
    if (selection.mode === 'edit') {
      composerRef.current?.setText(t('Edit the selected local files in place, preserve their format, and create backups before writing.'));
      composerRef.current?.focus();
    }
  };

  const handleAddFolder = (path: string) => {
    setProjectPath(path);
    setActiveFolder('project');
    setProjectId(null);
  };

  const handleUpdateClick = async () => {
    if (!isDesktop()) return;
    try {
      await desktopApis.updater.checkForUpdates();
      const status = await desktopApis.updater.getStatus();
      if (status.state === 'available' || status.state === 'downloaded') {
        setUpdate({
          title: t('Update available'),
          subtitle: t('Version {version} or later', { version: status.version ?? '' }),
          version: status.version,
          available: true,
        });
      } else {
        setUpdate({ title: t('Update'), subtitle: t('No updates available'), available: false });
      }
    } catch {
      setUpdate({ title: t('Update'), subtitle: t('Unable to check for updates.'), available: false });
    }
  };

  const navigateToTask = async (text: string, mode: TaskMode, files: File[], extData?: Record<string, unknown>) => {
    const uid = shortUid();
    let attachments: Attachment[] = [];
    if (files.length > 0) {
      try {
        attachments = await Promise.all(files.map((file) => uploadFile(getApiBase(), file)));
      } catch (e) {
        // Proceed without attachments if upload fails.
        // eslint-disable-next-line no-console
        console.error('attachment upload failed', e);
      }
    }
    dispatch(addSession({
      uid,
      title: text.slice(0, 60),
      status: 6,
      lastMessageTime: Date.now(),
      lastDisplayMessage: text,
      icon: '•',
    }));
    dispatch(loadSessions());
    const params = new URLSearchParams();
    if (text) params.set('draft', text);
    params.set('mode', mode);
    if (cwd) params.set('cwd', cwd);
    if (attachments.length > 0) params.set('attachments', JSON.stringify(attachments));
    if (extData && Object.keys(extData).length > 0) params.set('extData', JSON.stringify(extData));
    router.push(`/app/${uid}/?${params.toString()}`);
  };

  const handleSend = async (text: string, mode: TaskMode, files: File[], extData?: Record<string, unknown>) => {
    const currentOptions = extData?.studioOptions;
    const studioOptions = localSelection?.mode === 'edit'
      ? { ...(currentOptions && typeof currentOptions === 'object' ? currentOptions : {}), mode: 'edit', localFiles: localSelection.localFiles }
      : currentOptions;
    await navigateToTask(text, mode, files, { ...extData, ...(studioOptions ? { studioOptions } : {}) });
  };

  const selectGoal = (goal: StudioGoal) => {
    setPicker(null);
    setGoalDraft(undefined);
    if (goal.disabled) {
      setHomeNotice(t('This goal is not available yet. Websites, slides, video and local files use the supported service packs.'));
      return;
    }
    if (goal.directRoute) {
      router.push(goal.directRoute);
      return;
    }
    setActiveGoal(goal);
  };

  const openPromo = (target: PromoTarget) => {
    setGoalDraft(undefined);
    const goals = target === 'video' ? CREATE_GOALS : BUILD_GOALS;
    const goal = goals.find((item) => item.id === target);
    if (goal) setActiveGoal(goal);
  };

  const launchGoal = async (goal: StudioGoal, text: string, options?: { format?: string; chart?: string }) => {
    if (goal.disabled) {
      setActiveGoal(null);
      setHomeNotice(t('This goal is not available yet. Choose a supported service instead.'));
      return;
    }
    const mode: TaskMode = model === 'flex' ? 'standard' : model;
    await navigateToTask(text, mode, [], {
      loamMode: goal.loamMode,
      studioGoal: goal.id,
      outputType: goal.outputType,
      studioOptions: options,
      projectId,
      worktreeEnabled,
      modelTier: model,
    });
  };

  const useTemplate = (prompt: string) => {
    if (!previewTemplate) return;
    const goalId = previewTemplate.id === 'anime' ? 'video' : previewTemplate.kind === 'App' ? 'desktop-app' : 'image';
    const goals = previewTemplate.kind === 'App' ? BUILD_GOALS : CREATE_GOALS;
    const goal = goals.find((item) => item.id === goalId);
    setPreviewTemplate(null);
    if (goal?.disabled) {
      setHomeNotice(t('Mobile app generation is not available yet. The budget card cannot be converted into a website without your confirmation.'));
      return;
    }
    setGoalDraft(prompt);
    if (goal) setActiveGoal(goal);
  };

  const templates = TEMPLATE_PREVIEWS;

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* Top bar */}
        <div className="flex h-row items-center justify-between px-6">
          <ModelMenu value={model} onChange={setModel} />
          <div className="flex items-center gap-2">
            {credits && <CreditsPopover total={credits} />}
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className={clsx(
                'rounded-control p-1.5 text-text-secondary hover:bg-fill-hover',
                panelOpen && 'bg-fill-hover text-text-primary',
              )}
              aria-label={t('Right panel')}
              title={t('Right panel')}
            >
              <PanelRight className="size-4" />
            </button>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-2 sm:px-0">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LogoMark className="size-10 text-text-primary" />
              <h1 className="flex items-baseline gap-2 text-[34px] font-bold leading-none text-text-primary">
                <span className="font-serif">{t('loam')}</span>
                <span className="font-serif text-[#888888]">{t('studio')}</span>
              </h1>
            </div>
            <PromoBanner onSelect={openPromo} />
          </div>

          <div className="mb-3 grid grid-cols-1 gap-[10px] md:grid-cols-3">
            <div className="flex w-full flex-col gap-[10px] md:col-span-2">
              <HomeCard
                className="w-full"
                onClick={() => setPicker('build')}
                icon={<Hammer className="size-5 text-[#0081f2]" />}
                title={t('Build')}
                subtitle={t('Websites, apps, and games')}
                illustration={<BuildIllustration />}
              />
              <HomeCard
                className="w-full"
                onClick={() => setPicker('create')}
                icon={<CreateMark className="size-5 text-[#efa201]" />}
                title={t('Create')}
                subtitle={t('Slides, images, and videos')}
                illustration={<CreateIllustration />}
              />
            </div>
            <StartFromFileCard onFilesAdd={addFilesToComposer} />
          </div>

          <div className="mb-3 grid grid-cols-3 gap-[10px]">
            {templates.map((tpl) => (
              <TemplateCard
                key={tpl.title}
                title={tpl.title}
                imageSrc={tpl.imageSrc}
                imageAlt={tpl.imageAlt}
                onClick={() => setPreviewTemplate(tpl)}
              />
            ))}
          </div>

          {/* Composer */}
          <div className="mt-auto">
            {homeNotice && (
              <div role="status" className="mb-2 flex items-center justify-between rounded-control bg-fill-tsp px-3 py-2 text-xs text-text-secondary" data-testid="home-goal-notice">
                <span>{homeNotice}</span>
                <button type="button" className="text-text-tertiary hover:text-text-primary" onClick={() => setHomeNotice('')}>{t('Dismiss')}</button>
              </div>
            )}
            {localSelection?.mode === 'edit' && (
              <div className="mb-2 flex items-center justify-between rounded-control bg-fill-tsp px-3 py-2 text-xs text-text-secondary" data-testid="local-edit-selection">
                <span>{t('Edit in place')} · {localSelection.localFiles.length} {t('files')} · {t('Backups enabled')}</span>
                <button type="button" className="text-text-tertiary hover:text-text-primary" onClick={() => setLocalSelection(null)}>{t('Clear')}</button>
              </div>
            )}
            <ComposerContextBar
              home
              projectPath={projectPath}
              activeFolder={activeFolder}
              onChooseProject={chooseProject}
              onSelectDownloads={selectDownloads}
              branch={branch}
              projects={projects}
              projectId={projectId}
              onSelectProject={selectProjectOption}
              worktreeEnabled={worktreeEnabled}
              onWorktreeChange={setWorktreeEnabled}
            />
            <Composer
              ref={composerRef}
              onSend={handleSend}
              home
              onAddFolder={handleAddFolder}
              defaultLoamMode={defaultLoamMode}
              modelTier={model}
              projectId={projectId}
              worktreeEnabled={worktreeEnabled}
            />
          </div>
        </div>
      </div>
      <SidePanel open={panelOpen} />
      {picker && (
        <StudioPickerDialog
          kind={picker}
          onClose={() => setPicker(null)}
          onSelect={selectGoal}
        />
      )}
      {previewTemplate && (
        <TemplatePreviewDialog
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
          onUse={useTemplate}
          onOpenTemplate={setPreviewTemplate}
        />
      )}
      {activeGoal && (
        <StudioGoalDialog
          goal={activeGoal}
          initialDraft={goalDraft}
          onClose={() => setActiveGoal(null)}
          onLaunch={launchGoal}
        />
      )}
    </div>
  );
}
