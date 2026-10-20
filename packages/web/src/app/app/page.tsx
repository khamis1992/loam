'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, PanelRight, Hammer, Pencil, AppWindow, Video, Presentation,
} from 'lucide-react';
import clsx from 'clsx';
import { useAppDispatch } from '@/store';
import { addSession, loadSessions } from '@/store/sessionsSlice';
import { t } from '@/i18n/t';
import { Composer, ComposerContextBar, type ComposerHandle } from '@/components/chat/Composer';
import { HomeCard } from '@/components/home/HomeCard';
import { TemplateCard } from '@/components/home/TemplateCard';
import { ModelMenu, type AgentModel } from '@/components/home/ModelMenu';
import { StartFromFileCard } from '@/components/home/StartFromFileCard';
import { StarterMenu } from '@/components/home/StarterMenu';
import { SidePanel } from '@/components/home/SidePanel';
import { useBranch } from '@/components/home/useBranch';
import { uploadFile, type Attachment } from '@/services/upload';
import { desktopApis, isDesktop } from '@/services/desktopApis';
import { getSessionToken } from '@/services/rpc';
import { shortUid } from '@/utils/uid';
import type { TaskMode } from '@shared/socket';

const UPLOAD_BASE = 'http://localhost:8787';
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

  const [model, setModel] = useState<AgentModel>(readStoredModel);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeFolder, setActiveFolder] = useState<'project' | 'downloads' | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [downloadsPath, setDownloadsPath] = useState<string | null>(null);
  const [credits, setCredits] = useState<string | null>(null);
  const [update, setUpdate] = useState<{ title: string; subtitle: string; version?: string; available: boolean } | null>(null);

  const branch = useBranch();

  useEffect(() => {
    localStorage.setItem(MODEL_KEY, model);
  }, [model]);

  useEffect(() => {
    getSessionToken().then((token) => {
      if (!token) return;
      fetch(`${UPLOAD_BASE}/user.v1.UserService/GetAvailableCredits`, {
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
        .then((total) => {
          if (total && total > 0) {
            setCredits(new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(total));
          } else {
            setCredits(null);
          }
        })
        .catch(() => setCredits(null));
    });
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
      }
    } catch {
      // ignore
    }
  };

  const selectDownloads = () => {
    const path = getDownloadsPath();
    setDownloadsPath(path);
    setActiveFolder('downloads');
  };

  const prefillComposer = (prompt: string) => {
    composerRef.current?.setText(prompt);
    composerRef.current?.focus();
  };

  const addFilesToComposer = (files: File[]) => {
    composerRef.current?.addFiles(files);
  };

  const handleAddFolder = (path: string) => {
    setProjectPath(path);
    setActiveFolder('project');
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

  const navigateToTask = async (text: string, mode: TaskMode, files: File[]) => {
    const uid = shortUid();
    let attachments: Attachment[] = [];
    if (files.length > 0) {
      try {
        attachments = await Promise.all(files.map((file) => uploadFile(UPLOAD_BASE, file)));
      } catch {
        // Proceed without attachments if upload fails.
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
    router.push(`/app/${uid}/?${params.toString()}`);
  };

  const handleSend = (text: string, mode: TaskMode, files: File[]) => {
    navigateToTask(text, mode, files);
  };

  const buildItems = [
    { label: t('Websites'), prompt: t('Website starter') },
    { label: t('Apps'), prompt: t('App starter') },
    { label: t('Games'), prompt: t('Game starter') },
  ];

  const createItems = [
    { label: t('Slides'), prompt: t('Slides starter') },
    { label: t('Images'), prompt: t('Images starter') },
    { label: t('Videos'), prompt: t('Videos starter') },
  ];

  const templates = [
    {
      label: t('App'),
      labelIcon: <AppWindow className="size-3" />,
      title: t('Personal website'),
      prompt: t('Personal website prompt'),
    },
    {
      label: t('Slides'),
      labelIcon: <Presentation className="size-3" />,
      title: t('Product launch deck'),
      prompt: t('Product launch deck prompt'),
    },
    {
      label: t('Video'),
      labelIcon: <Video className="size-3" />,
      title: t('Browser game'),
      prompt: t('Browser game prompt'),
    },
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* Top bar */}
        <div className="flex h-row items-center justify-between px-6">
          <ModelMenu value={model} onChange={setModel} />
          <div className="flex items-center gap-2">
            {credits && (
              <span className="flex h-7 items-center gap-1 rounded-control border border-border-main px-2 text-xs font-medium text-text-secondary">
                <Sparkles className="size-3.5" /> {credits}
              </span>
            )}
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

        <div className="mx-auto w-full max-w-[768px] flex-1 px-6 pb-6">
          {/* Hero */}
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h1 className="text-[28px] font-semibold leading-[34px] text-text-primary">
                {t('Hi, I\'m {product}')}
              </h1>
              <p className="text-lg text-text-secondary">{t('What can I do for you?')}</p>
            </div>
            {update && (
              <button
                type="button"
                onClick={handleUpdateClick}
                className="flex h-11 w-[200px] shrink-0 items-center gap-2 rounded-control bg-[#1a1a1a] px-3 text-start text-white hover:opacity-90"
              >
                <div className="size-7 shrink-0 rounded bg-white/10" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{update.title}</p>
                  <p className="truncate text-[11px] text-[#a3a3a3]">{update.subtitle}</p>
                </div>
              </button>
            )}
          </div>

          {/* Cards grid */}
          <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_216px]">
            <div className="space-y-3">
              <StarterMenu items={buildItems} onSelect={prefillComposer}>
                <HomeCard
                  icon={<Hammer className="size-5 text-[#0081f2]" />}
                  title={t('Build')}
                  subtitle={t('Websites, apps, and games')}
                />
              </StarterMenu>
              <StarterMenu items={createItems} onSelect={prefillComposer}>
                <HomeCard
                  icon={<Pencil className="size-5 text-[#efa201]" />}
                  title={t('Create')}
                  subtitle={t('Slides, images, and videos')}
                />
              </StarterMenu>
            </div>
            <StartFromFileCard onFilesAdd={addFilesToComposer} />
          </div>

          {/* Template row */}
          <div className="mb-5 grid grid-cols-3 gap-3">
            {templates.map((tpl) => (
              <TemplateCard
                key={tpl.title}
                label={tpl.label}
                labelIcon={tpl.labelIcon}
                title={tpl.title}
                onClick={() => prefillComposer(tpl.prompt)}
              />
            ))}
          </div>

          {/* Composer */}
          <div className="mt-auto">
            <ComposerContextBar
              home
              projectPath={projectPath}
              activeFolder={activeFolder}
              onChooseProject={chooseProject}
              onSelectDownloads={selectDownloads}
              branch={branch}
            />
            <Composer
              ref={composerRef}
              onSend={handleSend}
              home
              onAddFolder={handleAddFolder}
            />
          </div>
        </div>
      </div>
      <SidePanel open={panelOpen} />
    </div>
  );
}
