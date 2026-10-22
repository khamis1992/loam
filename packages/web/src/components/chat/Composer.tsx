'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import {
  ArrowUp, Plus, ShieldCheck, Laptop, FolderGit, Folder, GitBranch, Square, X, ChevronDown,
  Mic, Github, Mail, Calendar, Loader2, Wrench, Plug, Bot, Check,
} from 'lucide-react';
import { VoiceIcon } from '@/components/home/VoiceIcon';
import { useVoiceTranscribe } from '@/components/chat/useVoiceTranscribe';
import { speak, stopSpeaking } from '@/services/speech';
import clsx from 'clsx';
import { t } from '@/i18n/t';
import { IconButton } from '@/components/ui/Button';
import { desktopApis } from '@/services/desktopApis';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { fetchProjectBranch, type ProjectOption } from '@/services/projectContextApi';
import { useRouter } from 'next/navigation';
import { ModeChip, type ModeChipResolved } from './ModeChip';
import type { TaskMode } from '@shared/socket';

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  setFiles: (files: File[]) => void;
  addFiles: (files: File[]) => void;
}

interface ComposerProps {
  onSend: (text: string, mode: TaskMode, files: File[], extData?: Record<string, unknown>) => void | Promise<void>;
  onStop?: () => void;
  running?: boolean;
  home?: boolean;
  onAddFolder?: (path: string) => void;
  defaultLoamMode?: string;
  resolvedLoamMode?: ModeChipResolved | null;
  placeholder?: string;
  /** MF4: "Approve for me" chip — auto-approve the current task's sensitive actions. */
  approveForMe?: boolean;
  onToggleApproveForMe?: () => void;
  /** Option 18: composer model tier sent with the task. */
  modelTier?: string;
  /** Option 17: project id sent with the task (sets the task's project). */
  projectId?: string | null;
  /** Option 17: start the task in a fresh git worktree under the bound folder. */
  worktreeEnabled?: boolean;
  /** Latest assistant reply text; enables the voice-mode TTS toggle. */
  assistantReply?: string;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSend, onStop, running, home, onAddFolder, defaultLoamMode, resolvedLoamMode, placeholder, approveForMe, onToggleApproveForMe, modelTier, projectId, worktreeEnabled, assistantReply }: ComposerProps,
  ref: Ref<ComposerHandle>,
) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TaskMode>('standard');
  const [files, setFiles] = useState<File[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [selectedLoamMode, setSelectedLoamMode] = useState<string | undefined>(defaultLoamMode);
  const [attachedSkills, setAttachedSkills] = useState<string[]>([]);
  const [attachedConnectors, setAttachedConnectors] = useState<string[]>([]);
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [availableConnectors, setAvailableConnectors] = useState<string[]>([]);
  const [attachLoading, setAttachLoading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [connectedOAuth, setConnectedOAuth] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const canSend = text.trim().length > 0 || files.length > 0;

  const [voiceModeOn, setVoiceModeOn] = useState<boolean>(false);
  const lastSpokenRef = useRef<string>('');
  const reply = (assistantReply ?? '').trim();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setVoiceModeOn(localStorage.getItem('agent-studio:voice-mode') === '1');
    }
  }, []);

  // Voice mode: speak each new assistant reply while enabled.
  useEffect(() => {
    if (!voiceModeOn || !reply || reply === lastSpokenRef.current) return;
    lastSpokenRef.current = reply;
    speak(reply);
  }, [voiceModeOn, reply]);

  useEffect(() => () => stopSpeaking(), []);

  const onTranscript = (transcript: string) => {
    setText((prev) => (prev.trim() ? `${prev}\n${transcript}` : transcript));
    textareaRef.current?.focus();
  };

  const voice = useVoiceTranscribe(onTranscript);

  const toggleVoiceMode = () => {
    const next = !voiceModeOn;
    setVoiceModeOn(next);
    if (typeof window !== 'undefined') localStorage.setItem('agent-studio:voice-mode', next ? '1' : '0');
    lastSpokenRef.current = '';
    stopSpeaking();
  };

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setText: (v) => setText(v),
    setFiles: (v) => setFiles(v),
    addFiles: (incoming) => setFiles((prev) => [...prev, ...incoming]),
  }));

  useEffect(() => {
    setSelectedLoamMode(defaultLoamMode);
  }, [defaultLoamMode]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const headers = await getApiHeaders();
        const res = await fetch(`${getApiBase()}/api/connectors`, { headers });
        if (!res.ok) return;
        const data = (await res.json()) as { connectors?: Array<{ id: string; connected: boolean }> };
        if (mounted) setConnectedOAuth((data.connectors ?? []).filter((c) => c.connected).map((c) => c.id));
      } catch {
        /* icons simply stay unlit when the backend is unreachable */
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    let mounted = true;
    setAttachLoading(true);
    setAttachError(null);
    (async () => {
      try {
        const headers = await getApiHeaders();
        const [skillsRes, mcpRes] = await Promise.all([
          fetch(`${getApiBase()}/api/skills`, { headers }),
          fetch(`${getApiBase()}/api/mcp/status`, { headers }),
        ]);
        if (!skillsRes.ok) throw new Error(`skills ${skillsRes.status}`);
        if (!mcpRes.ok) throw new Error(`mcp ${mcpRes.status}`);
        const skillsData = (await skillsRes.json()) as { skills?: Array<{ name: string }> };
        const mcpData = (await mcpRes.json()) as { servers?: Array<{ name: string }> };
        if (!mounted) return;
        setAvailableSkills((skillsData.skills ?? []).map((s) => s.name));
        setAvailableConnectors((mcpData.servers ?? []).map((s) => s.name));
      } catch (e) {
        if (!mounted) return;
        setAttachError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setAttachLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [menuOpen]);

  const submit = async () => {
    if (!canSend) return;
    const extData: Record<string, unknown> = {};
    if (selectedLoamMode) extData.loamMode = selectedLoamMode;
    if (attachedSkills.length > 0) extData.skills = attachedSkills;
    if (attachedConnectors.length > 0) extData.connectors = attachedConnectors;
    if (modelTier) extData.modelTier = modelTier;
    if (projectId) extData.projectId = projectId;
    if (worktreeEnabled) extData.worktreeEnabled = true;
    await onSend(text.trim(), mode, files, Object.keys(extData).length > 0 ? extData : undefined);
    setText('');
    setFiles([]);
    setMenuOpen(false);
    setAttachedSkills([]);
    setAttachedConnectors([]);
    setSelectedLoamMode(defaultLoamMode);
  };

  const onKey = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      await submit();
    }
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setFiles((prev) => [...prev, ...Array.from(incoming)]);
  };

  const removeFile = (target: File) => {
    setFiles((prev) => prev.filter((f) => f !== target));
  };

  const chooseFolder = async () => {
    setMenuOpen(false);
    try {
      const res = await desktopApis.system.showFolderDialog();
      if (res && typeof res === 'object' && 'path' in res && typeof (res as { path?: unknown }).path === 'string') {
        onAddFolder?.((res as { path: string }).path);
      }
    } catch {
      // ignore
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  const toggleSkill = (name: string) => {
    setAttachedSkills((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  const toggleConnector = (name: string) => {
    setAttachedConnectors((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  const navigateToAgents = () => {
    setMenuOpen(false);
    router.push('/app/agents');
  };

  const attachments = [
    ...files.map((f) => ({ type: 'file' as const, value: f })),
    ...attachedSkills.map((name) => ({ type: 'skill' as const, value: name })),
    ...attachedConnectors.map((name) => ({ type: 'connector' as const, value: name })),
  ];

  return (
    <div
      data-testid="composer"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={clsx(
        'rounded-composer bg-bg-menu p-3 border border-[#e5e7eb] dark:border-white/[0.08] shadow-card transition-colors',
        dragOver && 'border-[#0081f2] dark:border-[#1a93fe] bg-[var(--fill-blue)]',
      )}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={home ? 1 : 1}
        placeholder={placeholder ?? t(files.length ? 'Tell {product} what to do with the file'
          : home ? 'Assign a task or type / for more'
          : 'Message {product}')}
        className="chat-input-editor w-full resize-none bg-transparent text-base leading-snug text-text-primary outline-none placeholder:text-text-disable"
      />
      {attachments.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li
              key={`${f.name}-${f.lastModified}`}
              className="inline-flex max-w-full items-center gap-1 rounded-control bg-fill-tsp px-2 py-1 text-xs"
            >
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => removeFile(f)}
                aria-label={t('Remove file')}
                title={t('Remove file')}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
          {attachedSkills.map((name) => (
            <li
              key={`skill-${name}`}
              className="inline-flex max-w-full items-center gap-1 rounded-control bg-blue-50 px-2 py-1 text-xs text-icon-blue dark:bg-blue-950"
            >
              <Wrench className="size-3" />
              <span className="truncate">{name}</span>
              <button
                type="button"
                onClick={() => toggleSkill(name)}
                aria-label={t('Remove file')}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
          {attachedConnectors.map((name) => (
            <li
              key={`connector-${name}`}
              className="inline-flex max-w-full items-center gap-1 rounded-control bg-green-50 px-2 py-1 text-xs text-green-600 dark:bg-green-950"
            >
              <Plug className="size-3" />
              <span className="truncate">{name}</span>
              <button
                type="button"
                onClick={() => toggleConnector(name)}
                aria-label={t('Remove file')}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        {home ? (
          <div className="relative flex items-center gap-1" ref={menuRef}>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-border-main text-text-secondary transition-colors hover:bg-fill-hover"
              aria-label={t('Add files')}
              title={t('Add files')}
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="hidden h-6 w-6 items-center justify-center rounded-full border border-border-main text-text-secondary transition-colors hover:bg-fill-hover sm:flex"
              aria-label={t('Add files and more')}
              title={t('Add files and more')}
            >
              <ChevronDown className="size-3" />
            </button>
            {menuOpen && (
              <div className="absolute bottom-full start-0 z-50 mb-1 min-w-[200px] max-w-[calc(100vw-32px)] max-h-[60vh] overflow-y-auto rounded-card border border-border-main bg-bg-menu p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => { fileRef.current?.click(); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <Folder className="size-4" />
                  {t('Add files')}
                </button>
                <button
                  type="button"
                  onClick={chooseFolder}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <FolderGit className="size-4" />
                  {t('Add folder')}
                </button>
                <div className="my-1 border-t border-border-main" />
                <p className="px-3 py-1 text-xs font-medium text-text-tertiary">{t('Skills')}</p>
                {attachLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary">
                    <Loader2 className="size-4 animate-spin" /> {t('Loading')}
                  </div>
                ) : attachError ? (
                  <p className="px-3 py-2 text-xs text-function-error">{attachError}</p>
                ) : availableSkills.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-text-tertiary">{t('No skills registered.')}</p>
                ) : (
                  availableSkills.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleSkill(name)}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover',
                        attachedSkills.includes(name) && 'bg-fill-hover',
                      )}
                    >
                      <Wrench className="size-4" />
                      <span className="truncate">{name}</span>
                      {attachedSkills.includes(name) && <span className="ms-auto text-icon-blue">✓</span>}
                    </button>
                  ))
                )}
                <div className="my-1 border-t border-border-main" />
                <p className="px-3 py-1 text-xs font-medium text-text-tertiary">{t('Connectors')}</p>
                {attachLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary">
                    <Loader2 className="size-4 animate-spin" /> {t('Loading')}
                  </div>
                ) : attachError ? (
                  <p className="px-3 py-2 text-xs text-function-error">{attachError}</p>
                ) : availableConnectors.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-text-tertiary">{t('No MCP servers connected.')}</p>
                ) : (
                  availableConnectors.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleConnector(name)}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover',
                        attachedConnectors.includes(name) && 'bg-fill-hover',
                      )}
                    >
                      <Plug className="size-4" />
                      <span className="truncate">{name}</span>
                      {attachedConnectors.includes(name) && <span className="ms-auto text-icon-blue">✓</span>}
                    </button>
                  ))
                )}
                <div className="my-1 border-t border-border-main" />
                <button
                  type="button"
                  onClick={navigateToAgents}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <Bot className="size-4" />
                  {t('Agents')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="relative flex items-center gap-1" ref={menuRef}>
            <IconButton label={t('Add files')} onClick={() => fileRef.current?.click()}>
              <Plus className="size-4" />
            </IconButton>
            <IconButton
              label={t('Add files and more')}
              onClick={() => setMenuOpen((v) => !v)}
              className="hidden sm:flex"
            >
              <Plus className="size-4" />
              <ChevronDown className="size-3" />
            </IconButton>
            {menuOpen && (
              <div className="absolute bottom-full start-0 z-50 mb-1 min-w-[200px] max-w-[calc(100vw-32px)] max-h-[60vh] overflow-y-auto rounded-card border border-border-main bg-bg-menu p-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => { fileRef.current?.click(); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <Folder className="size-4" />
                  {t('Add files')}
                </button>
                <button
                  type="button"
                  onClick={chooseFolder}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <FolderGit className="size-4" />
                  {t('Add folder')}
                </button>
                <div className="my-1 border-t border-border-main" />
                <p className="px-3 py-1 text-xs font-medium text-text-tertiary">{t('Skills')}</p>
                {attachLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary">
                    <Loader2 className="size-4 animate-spin" /> {t('Loading')}
                  </div>
                ) : attachError ? (
                  <p className="px-3 py-2 text-xs text-function-error">{attachError}</p>
                ) : availableSkills.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-text-tertiary">{t('No skills registered.')}</p>
                ) : (
                  availableSkills.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleSkill(name)}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover',
                        attachedSkills.includes(name) && 'bg-fill-hover',
                      )}
                    >
                      <Wrench className="size-4" />
                      <span className="truncate">{name}</span>
                      {attachedSkills.includes(name) && <span className="ms-auto text-icon-blue">✓</span>}
                    </button>
                  ))
                )}
                <div className="my-1 border-t border-border-main" />
                <p className="px-3 py-1 text-xs font-medium text-text-tertiary">{t('Connectors')}</p>
                {attachLoading ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary">
                    <Loader2 className="size-4 animate-spin" /> {t('Loading')}
                  </div>
                ) : attachError ? (
                  <p className="px-3 py-2 text-xs text-function-error">{attachError}</p>
                ) : availableConnectors.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-text-tertiary">{t('No MCP servers connected.')}</p>
                ) : (
                  availableConnectors.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleConnector(name)}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover',
                        attachedConnectors.includes(name) && 'bg-fill-hover',
                      )}
                    >
                      <Plug className="size-4" />
                      <span className="truncate">{name}</span>
                      {attachedConnectors.includes(name) && <span className="ms-auto text-icon-blue">✓</span>}
                    </button>
                  ))
                )}
                <div className="my-1 border-t border-border-main" />
                <button
                  type="button"
                  onClick={navigateToAgents}
                  className="flex w-full items-center gap-2 rounded-control px-3 py-2 text-sm text-text-primary hover:bg-fill-hover"
                >
                  <Bot className="size-4" />
                  {t('Agents')}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="hidden items-center -space-x-1 rounded-full border border-border-main bg-bg-menu px-2 py-1 sm:flex">
          <span
            className={clsx(
              'z-30 flex size-5 items-center justify-center rounded-full border border-white bg-black text-white dark:border-[#1f1f1f]',
              !connectedOAuth.includes('github') && 'opacity-30 grayscale',
            )}
            title={`${t('Github')} — ${connectedOAuth.includes('github') ? t('Connected') : t('Disconnected')}`}
          >
            <Github className="size-3" />
          </span>
          <span
            className={clsx(
              'z-20 flex size-5 items-center justify-center rounded-full border border-white bg-[#ea4335] text-white dark:border-[#1f1f1f]',
              !connectedOAuth.includes('gmail') && 'opacity-30 grayscale',
            )}
            title={`${t('Gmail')} — ${connectedOAuth.includes('gmail') ? t('Connected') : t('Disconnected')}`}
          >
            <Mail className="size-3" />
          </span>
          <span
            className={clsx(
              'z-10 flex size-5 items-center justify-center rounded-full border border-white bg-[#4285f4] text-white dark:border-[#1f1f1f]',
              !connectedOAuth.includes('calendar') && 'opacity-30 grayscale',
            )}
            title={`${t('Google Calendar')} — ${connectedOAuth.includes('calendar') ? t('Connected') : t('Disconnected')}`}
          >
            <Calendar className="size-3" />
          </span>
          <span className="ms-1 text-[11px] font-medium text-text-secondary">+4</span>
        </div>

        <button
          type="button"
          onClick={onToggleApproveForMe}
          aria-pressed={approveForMe === true}
          className={clsx(
            'hidden items-center gap-1 rounded-full border px-2 py-1 text-xs sm:flex',
            approveForMe ? 'border-icon-blue bg-fill-tsp text-icon-blue' : 'border-border-main text-text-secondary hover:bg-fill-hover',
          )}
        >
          <ShieldCheck className="size-3.5" /> {t('Approve for me')}
        </button>

        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as TaskMode)}
          className="h-row-sm rounded-control bg-transparent px-2 text-sm text-text-secondary outline-none"
        >
          <option value="standard">{t('Standard')}</option>
          <option value="lite">{t('Lite')}</option>
          <option value="max">{t('Max')}</option>
        </select>

        <ModeChip
          resolved={resolvedLoamMode}
          value={selectedLoamMode}
          onChange={setSelectedLoamMode}
        />

        {!home && (
          <span className="ms-2 flex items-center gap-1 text-xs text-text-secondary">
            <Laptop className="size-3.5" /> {t('This PC')}
          </span>
        )}

        <div className="flex-1" />

        <button
          type="button"
          className={clsx(
            'hidden h-8 w-8 items-center justify-center rounded-full border border-border-main transition-colors hover:bg-fill-hover sm:flex',
            voiceModeOn ? 'bg-fill-hover text-text-primary' : 'text-text-secondary',
          )}
          aria-label={t(voiceModeOn ? 'Stop voice mode' : 'Voice mode')}
          aria-pressed={voiceModeOn}
          title={t(voiceModeOn ? 'Stop voice mode' : 'Voice mode')}
          onClick={toggleVoiceMode}
        >
          <VoiceIcon className="size-4" />
        </button>
        <button
          type="button"
          className={clsx(
            'hidden h-8 w-8 items-center justify-center rounded-full border border-border-main transition-colors hover:bg-fill-hover sm:flex',
            voice.state !== 'idle' && 'bg-fill-hover text-text-primary',
            voice.state === 'recording' && 'text-function-error',
          )}
          aria-label={t(voice.state === 'recording' ? 'Stop recording' : 'Microphone')}
          title={t(voice.state === 'recording' ? 'Stop recording' : 'Microphone')}
          onClick={() => (voice.state === 'recording' ? voice.stop() : void voice.start())}
        >
          {voice.state === 'transcribing' ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
        </button>

        {running
          ? (
            <IconButton
              label={t('Stop')}
              onClick={onStop}
              className="rounded-full bg-text-primary text-text-onblack hover:opacity-90"
            >
              <Square className="size-4 fill-current" />
            </IconButton>
          )
          : (
            <IconButton
              label={t('Send')}
              disabled={!canSend}
              onClick={submit}
              className={clsx(
                'rounded-full',
                canSend ? 'bg-text-primary text-text-onblack hover:opacity-90' : 'bg-fill-tsp text-text-secondary',
              )}
            >
              <ArrowUp className="size-4" />
            </IconButton>
          )}
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ''; }}
      />
    </div>
  );
});

export type { ProjectOption } from '@/services/projectContextApi';

interface ComposerContextBarProps {
  home?: boolean;
  projectPath?: string | null;
  activeFolder?: 'project' | 'downloads' | null;
  onChooseProject?: () => void;
  onSelectDownloads?: () => void;
  branch?: string;
  /** Option 17: projects from GET /api/projects for the chip popover. */
  projects?: ProjectOption[];
  projectId?: string | null;
  onSelectProject?: (project: ProjectOption | null) => void;
  worktreeEnabled?: boolean;
  onWorktreeChange?: (value: boolean) => void;
}

function basename(p?: string | null): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
}

function truncateBranch(b: string): string {
  if (b.length <= 24) return b;
  return b.slice(0, 22) + '…';
}

export function ComposerContextBar({
  home,
  projectPath,
  activeFolder,
  onChooseProject,
  onSelectDownloads,
  branch,
  projects,
  projectId,
  onSelectProject,
  worktreeEnabled,
  onWorktreeChange,
}: ComposerContextBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Option 17: resolve the selected project's real branch from the backend
  // (GET /api/projects/:id/git) instead of the desktop "main" fallback. The
  // desktop branch remains the fallback when no project is selected.
  const [projectBranch, setProjectBranch] = useState<string | null>(null);
  useEffect(() => {
    setProjectBranch(null);
    if (!projectId) return;
    let mounted = true;
    fetchProjectBranch(projectId)
      .then((info) => {
        if (mounted && info?.isGit && info.branch) setProjectBranch(info.branch);
      })
      .catch(() => {
        // Backend route unavailable: keep the desktop fallback branch.
      });
    return () => { mounted = false; };
  }, [projectId]);

  const displayBranch = projectBranch || branch;

  const hasPicker = Boolean(onSelectProject);
  const openChip = () => {
    if (hasPicker) setMenuOpen((v) => !v);
    else onChooseProject?.();
  };
  const selectedProject = hasPicker && projectId ? (projects ?? []).find((p) => p.id === projectId) ?? null : null;
  const label = selectedProject
    ? selectedProject.name
    : projectPath ? basename(projectPath) : t('Choose project');

  return (
    <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-text-secondary">
      <span className="flex items-center gap-1">
        <Laptop className="size-3.5" /> {t('This PC')}
      </span>
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={openChip}
          aria-haspopup={hasPicker ? 'menu' : undefined}
          aria-expanded={hasPicker ? menuOpen : undefined}
          className={clsx(
            'flex items-center gap-1 rounded-control px-1 transition-colors hover:bg-fill-hover',
            (activeFolder === 'project' || selectedProject) && 'bg-fill-hover text-text-primary',
          )}
        >
          <FolderGit className="size-3.5" />
          <span className="max-w-[160px] truncate">{label}</span>
          {hasPicker && <ChevronDown className="size-3 shrink-0" />}
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute bottom-full left-0 z-30 mb-1 min-w-[220px] max-w-[280px] rounded-card border border-border-main bg-bg-menu p-1 shadow-lg"
          >
            {(projects ?? []).length === 0 && (
              <p className="px-2 py-1.5 text-xs text-text-tertiary">{t('No projects yet. Create one in Projects.')}</p>
            )}
            {(projects ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); onSelectProject?.(p); }}
                className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs hover:bg-fill-hover"
              >
                <FolderGit className="size-3.5 shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.id === projectId && <Check className="size-3.5 shrink-0" />}
              </button>
            ))}
            {(projects ?? []).length > 0 && <div className="my-1 border-t border-border-main" />}
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenuOpen(false); onChooseProject?.(); }}
              className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs hover:bg-fill-hover"
            >
              <Folder className="size-3.5 shrink-0 text-text-tertiary" />
              {t('Use a folder')}
            </button>
            {projectId && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); onSelectProject?.(null); }}
                className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs hover:bg-fill-hover"
              >
                <X className="size-3.5 shrink-0 text-text-tertiary" />
                {t('Clear project')}
              </button>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onSelectDownloads}
        className={clsx(
          'flex items-center gap-1 rounded-control px-1 transition-colors hover:bg-fill-hover',
          activeFolder === 'downloads' && 'bg-fill-hover text-text-primary',
        )}
      >
        <Folder className="size-3.5" /> {t('Downloads')}
      </button>
      {displayBranch && (
        <span className="flex max-w-[180px] items-center gap-1 truncate"
          title={displayBranch}
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{truncateBranch(displayBranch)}</span>
        </span>
      )}
      <label className={clsx('flex items-center gap-1', onWorktreeChange ? 'cursor-pointer' : 'cursor-not-allowed text-text-disable')}>
        <input
          type="checkbox"
          disabled={!onWorktreeChange}
          checked={Boolean(worktreeEnabled)}
          onChange={(e) => onWorktreeChange?.(e.target.checked)}
          className="size-3.5"
        /> {t('Worktree')}
      </label>
    </div>
  );
}
