'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PanelRight, Hammer, Pencil, AppWindow, Video, LayoutGrid, Database, Shield,
} from 'lucide-react';
import clsx from 'clsx';
import { useAppDispatch } from '@/store';
import { addSession, loadSessions } from '@/store/sessionsSlice';
import { t } from '@/i18n/t';
import { Composer, ComposerContextBar, type ComposerHandle } from '@/components/chat/Composer';
import { HomeCard } from '@/components/home/HomeCard';
import { CreditsPopover } from '@/components/home/CreditsPopover';
import { TemplateCard } from '@/components/home/TemplateCard';
import { ModelMenu, type AgentModel } from '@/components/home/ModelMenu';
import { StartFromFileCard } from '@/components/home/StartFromFileCard';
import { StarterMenu, type StarterItem } from '@/components/home/StarterMenu';
import { SidePanel } from '@/components/home/SidePanel';
import { PromoBanner } from '@/components/home/PromoBanner';
import { LogoMark } from '@/components/home/LogoMark';
import { BuildIllustration, CreateIllustration } from '@/components/home/BuildIllustration';
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
  const [credits, setCredits] = useState<number | null>(null);
  const [update, setUpdate] = useState<{ title: string; subtitle: string; version?: string; available: boolean } | null>(null);
  const [defaultLoamMode, setDefaultLoamMode] = useState<string | undefined>(undefined);

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
            setCredits(total);
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

  const prefillComposer = (prompt: string, loamMode?: string) => {
    composerRef.current?.setText(prompt);
    composerRef.current?.focus();
    setDefaultLoamMode(loamMode);
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

  const navigateToTask = async (text: string, mode: TaskMode, files: File[], extData?: Record<string, unknown>) => {
    const uid = shortUid();
    let attachments: Attachment[] = [];
    if (files.length > 0) {
      try {
        attachments = await Promise.all(files.map((file) => uploadFile(UPLOAD_BASE, file)));
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
    await navigateToTask(text, mode, files, extData);
  };

  const onStarterSelect = (item: StarterItem) => {
    prefillComposer(item.prompt, item.loamMode);
  };

  const buildItems: StarterItem[] = [
    { label: t('Websites'), prompt: t('Website starter'), icon: '🔧', loamMode: 'build' },
    { label: t('Apps'), prompt: t('App starter'), icon: '📱', loamMode: 'build' },
    { label: t('Games'), prompt: t('Game starter'), icon: '🎮', loamMode: 'build' },
  ];

  const createItems: StarterItem[] = [
    { label: t('Slides'), prompt: t('Slides starter'), icon: '📊', loamMode: 'write' },
    { label: t('Docs'), prompt: t('Docs starter'), icon: '📝', loamMode: 'write' },
    { label: t('Images'), prompt: t('Images starter'), icon: '🖼️', loamMode: 'media' },
    { label: t('Videos'), prompt: t('Videos starter'), icon: '🎬', loamMode: 'media' },
  ];

  const dataItems: StarterItem[] = [
    { label: t('Sheets'), prompt: t('Sheets starter'), icon: '📑', loamMode: 'data' },
    { label: t('Research'), prompt: t('Research starter'), icon: '🔍', loamMode: 'research' },
  ];

  const secureItems: StarterItem[] = [
    { label: t('Security scan'), prompt: t('Security scan starter'), icon: '🛡️', loamMode: 'security' },
    { label: t('Automation'), prompt: t('Automation starter'), icon: '⚡', loamMode: 'automate' },
  ];

  const templates = [
    {
      label: t('Video'),
      labelIcon: <Video className="size-3" />,
      title: t('Browser game'),
      imageSrc: '/templates/anime.svg',
      imageAlt: t('Browser game'),
      prompt: t('Browser game prompt'),
    },
    {
      label: t('App'),
      labelIcon: <LayoutGrid className="size-3" />,
      title: t('Product launch deck'),
      imageSrc: '/templates/budget.svg',
      imageAlt: t('Product launch deck'),
      prompt: t('Product launch deck prompt'),
    },
    {
      label: t('Website'),
      labelIcon: <AppWindow className="size-3" />,
      title: t('Personal website'),
      imageSrc: '/templates/hero.svg',
      imageAlt: t('Personal website'),
      prompt: t('Personal website prompt'),
    },
  ];

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

        <div className="mx-auto w-full max-w-[615px] flex-1 px-0 pb-2">
          {/* Hero */}
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LogoMark className="size-9 text-text-primary" />
              <h1 className="flex items-baseline gap-1 text-[34px] font-bold leading-none text-text-primary">
                <span className="font-serif">{t('loam')}</span>
                <span className="font-serif text-[#888888]">{t('studio')}</span>
              </h1>
            </div>
            <PromoBanner onSelect={(prompt) => prefillComposer(prompt)} />
          </div>

          {/* Starter cards */}
          <div className="mb-3 grid grid-cols-1 gap-[10px] md:grid-cols-[390px_215px]">
            <div className="flex w-[390px] flex-col gap-[10px]">
              <StarterMenu items={buildItems} onSelect={onStarterSelect}>
                <HomeCard
                  className="w-full"
                  icon={<Hammer className="size-5 text-[#0081f2]" />}
                  title={t('Build')}
                  subtitle={t('Websites, apps, and games')}
                  illustration={<BuildIllustration />}
                />
              </StarterMenu>
              <StarterMenu items={createItems} onSelect={onStarterSelect}>
                <HomeCard
                  className="w-full"
                  icon={<Pencil className="size-5 text-[#efa201]" />}
                  title={t('Create')}
                  subtitle={t('Slides, docs, images, and videos')}
                  illustration={<CreateIllustration />}
                />
              </StarterMenu>
              <StarterMenu items={dataItems} onSelect={onStarterSelect}>
                <HomeCard
                  className="w-full"
                  icon={<Database className="size-5 text-[#22c55e]" />}
                  title={t('Data')}
                  subtitle={t('Sheets and research')}
                />
              </StarterMenu>
              <StarterMenu items={secureItems} onSelect={onStarterSelect}>
                <HomeCard
                  className="w-full"
                  icon={<Shield className="size-5 text-[#ef4444]" />}
                  title={t('Secure')}
                  subtitle={t('Security scans and automations')}
                />
              </StarterMenu>
            </div>
            <StartFromFileCard onFilesAdd={addFilesToComposer} />
          </div>

          {/* Template row */}
          <div className="mb-3 grid grid-cols-3 gap-[10px]">
            {templates.map((tpl) => (
              <TemplateCard
                key={tpl.title}
                label={tpl.label}
                labelIcon={tpl.labelIcon}
                title={tpl.title}
                imageSrc={tpl.imageSrc}
                imageAlt={tpl.imageAlt}
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
              defaultLoamMode={defaultLoamMode}
            />
          </div>
        </div>
      </div>
      <SidePanel open={panelOpen} />
    </div>
  );
}
