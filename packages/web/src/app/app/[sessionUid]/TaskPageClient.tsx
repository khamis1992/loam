'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

const sentDraftSessions = new Set<string>();
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import {
  Share, FileChartColumn, MoreHorizontal, PanelRight, CircleCheck, Copy, Repeat2,
  Star, Loader2, AppWindow,
} from 'lucide-react';
import { useAppDispatch, useAppSelector, type AppDispatch } from '@/store';
import { appendEvent, applyDelta, setStatus, setError } from '@/store/chatSlice';
import { addSession, selectSession } from '@/store/sessionsSlice';
import { t, PRODUCT } from '@/i18n/t';
import { Composer, type ComposerHandle } from '@/components/chat/Composer';
// Phase-2 W5: the Companions voice pattern in the main chat — mic (ar-SA
// WebSpeech recognition), streaming TTS of assistant replies, barge-in.
import { useVoiceChat } from '@/hooks/useVoiceChat';
import { VoiceChatControls } from '@/components/chat/VoiceChatControls';
// Cap G §4.16: the Agent Studio App Builder workspace opens for tasks that own
// an App project; the Race chip rides the composer (§4.13.2).
import { AppBuilderWorkspace } from '@/components/appbuilder/AppBuilderWorkspace';
import { findProjectByTask, startRun, raceEstimate as fetchRaceEstimate, type AppProjectDto, type RaceEstimateDto } from '@/services/appBuilderApi';
import { MatterComposer } from '@/components/legal/MatterComposer';
import { EventList } from '@/components/chat/EventList';
import { useConversationAutoScroll } from '@/components/chat/useConversationAutoScroll';
import { ThinkingTrace } from '@/components/chat/ThinkingTrace';
import { SessionStatusBadge } from '@/components/chat/SessionStatusBadge';
import { useSessionRuntime } from '@/components/chat/useSessionRuntime';
// J7 idle session hibernation: release the derived render caches after a
// sustained idle period; the first keystroke wakes without losing the draft.
import { useSessionHibernation } from '@/components/chat/useSessionHibernation';
import { HibernationNotice } from '@/components/chat/HibernationNotice';
// J7: the observable hibernate/wake surface used by the e2e suite and the
// renderer-RSS bench. It is a renderer-local controller, so a release here can
// never touch the canonical store, the draft or the daemon's own caches.
import {
  createHibernationTestHook,
  resolveHibernationReady,
} from '@/components/chat/hibernationTestHook';
import { requestHibernation, wakeHibernatedSessionWithAuth } from '@/services/sessionHibernationApi';
import { StepTimeline, deriveTimelineSteps, type TimelineStep } from '@/components/chat/StepTimeline';
import { TaskMetricsBand } from '@/components/chat/TaskMetricsBand';
import { SideChatPanel } from '@/components/chat/SideChatPanel';
import { AttachmentCard, kindFromName, type AttachmentKind } from '@/components/chat/AttachmentCard';
import { ComputerPanel } from '@/components/computer/ComputerPanel';
import { ComputerDock } from '@/components/computer/ComputerDock';
import { CompletionCard } from '@/components/chat/CompletionCard';
import { PresentationVideoCard, type PresentationVideoRequest } from '@/components/chat/PresentationVideoCard';
import {
  WorkspacePanel,
  latestWorkspaceDecision,
  mergeWorkspaceTarget,
  subscribeWorkspaceEditors,
  workspaceEditorsVersion,
  type WorkspaceFile,
  type WorkspaceOpenTarget,
} from '@/components/workspace';
import { craftAppForExtension, craftExtOf, editorKindForExtension } from '@/components/workspace/craft';
import { ensureTaskRelay, TaskRelayHost } from '@/components/workspace/TaskRelayHost';
import { CRAFT_APPS } from '@/lib/craftBridge';
import { ShareDialog } from '@/components/dialogs/ShareDialog';
import { ChatSocket } from '@/services/chatSocket';
import { RpcClient, getApiBase, getApiHeaders, getSessionToken, handleAuthFailure } from '@/services/rpc';
import { uploadFile } from '@/services/upload';
import { legalExtData } from '@/services/legalApi';
import type {
  TaskMode,
  ChatEvent,
  ChatMessageEvent,
  StatusUpdateEvent,
  CascadeTaskClockEvent,
  ChatDeltaEvent,
  EventsNotifyEventsAfterEvent,
  ServerMessage,
  Attachment,
  ToolUsedEvent,
  AttachmentEvent,
  ModeEvent,
} from '@shared/socket';
import { formatDuration, formatTime } from '@/utils/format';
import { computeTaskClockDuration, taskVisualStatus } from '@/components/chat/taskStatus';

function getSocketBase(): string {
  if (typeof window === 'undefined') return '/';
  const injected = (window as unknown as { __AGENT_STUDIO_ENV__?: { socketBase?: string } }).__AGENT_STUDIO_ENV__;
  if (injected?.socketBase) return injected.socketBase;
  if ((window as unknown as { __apis?: unknown }).__apis) return 'http://localhost:8787';
  return '/';
}

function parseAttachments(raw: string | null): Attachment[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ id?: string; url?: string; name?: string; filename?: string; contentType?: string }>;
    return list.map((a) => ({
      id: String(a.id ?? ''),
      filename: String(a.filename ?? a.name ?? 'attachment'),
      type: 'file' as const,
      url: String(a.url ?? ''),
      contentType: String(a.contentType ?? 'application/octet-stream'),
      fileMetaData: { tag: 'upload' as const, uploadStatus: 'success' as const, uploadProgress: 100 },
    }));
  } catch {
    return [];
  }
}

function makeExtData(cwd?: string, extra?: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = { ...extra };
  if (cwd) {
    out.desktopBinding = {
      deviceId: 'desktop',
      folderPath: cwd,
    };
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

function parseExtData(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // ignore malformed extData
  }
  return undefined;
}

export default function TaskPageClient(_props: { params: Promise<{ sessionUid: string }> }) {
  const pathname = usePathname();
  const router = useRouter();
  const sessionUid = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'demo-running';
  }, [pathname]);

  const searchParams = useSearchParams();
  const dispatch = useAppDispatch();
  const events = useAppSelector((s) => s.chat.eventsBySession[sessionUid] ?? []);
  const status = useAppSelector((s) => s.chat.statusBySession[sessionUid]);
  const running = useAppSelector((s) => s.chat.running[sessionUid] ?? false);
  const error = useAppSelector((s) => s.chat.errorsBySession[sessionUid]);
  const draftText = searchParams.get('draft') || '';
  const draftMode = (searchParams.get('mode') as TaskMode) || 'standard';
  const cwd = searchParams.get('cwd') || undefined;
  const attachmentsParam = searchParams.get('attachments');
  const extDataParam = searchParams.get('extData');
  const draftAttachments = useMemo(() => parseAttachments(attachmentsParam), [attachmentsParam]);
  const draftExtData = useMemo(() => parseExtData(extDataParam), [extDataParam]);
  const draftLoamMode = typeof draftExtData?.loamMode === 'string' ? draftExtData.loamMode : undefined;
  // Neo N10: the draft extData can pre-select an output type / effort (a deep
  // link, or a starter card) and name the A/B arm models.
  const draftOutputType = typeof draftExtData?.outputType === 'string' ? draftExtData.outputType : undefined;
  const draftEffort = typeof draftExtData?.effort === 'string' ? draftExtData.effort : undefined;
  const draftAbModels = Array.isArray(draftExtData?.abModels)
    ? draftExtData.abModels.filter((m): m is string => typeof m === 'string')
    : undefined;
  const draftCompare = draftAbModels !== undefined && draftAbModels.length > 1;
  const socketRef = useRef<ChatSocket | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const sentDraft = useRef<{ uid: string; sent: boolean }>({ uid: '', sent: false });
  if (sentDraft.current.uid !== sessionUid) {
    sentDraft.current = { uid: sessionUid, sent: sentDraftSessions.has(sessionUid) };
  }
  const apiBase = useMemo(() => getApiBase(), []);
  const [shareOpen, setShareOpen] = useState(false);
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';
  const [approveForMe, setApproveForMe] = useState(false);
  // Neo N3: per-run Knowledge Garden toggle. Off by default so a run never reads
  // the user's imported sources unless they asked for it on this run.
  const [knowledgeOn, setKnowledgeOn] = useState(false);
  // D19 session runtime: sleep state + compute budget, shown by the badge.
  const runtime = useSessionRuntime(sessionUid);
  const terminalState = `${running}:${status}`;
  const previousTerminalState = useRef(terminalState);
  useEffect(() => {
    if (previousTerminalState.current !== terminalState) void runtime.refresh();
    previousTerminalState.current = terminalState;
  }, [terminalState, runtime.refresh]);
  // J7: hibernation state for this chat view (derived-cache release + wake).
  const hibernation = useSessionHibernation(sessionUid, events);
  // J7: expose the hibernate/wake surface for the e2e suite and the RSS bench.
  // The controller dispatches into the store and flips this view-local flag, so
  // it cannot disagree with what is on screen and it never re-releases state the
  // idle timer already released.
  const [hookHibernated, setHookHibernated] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hook = createHibernationTestHook({
      dispatch: (action) => dispatch(action as Parameters<typeof dispatch>[0]),
      isHibernated: (id) => id === sessionUid && (hookHibernated || hibernation.hibernated),
      setHibernated: (id, value) => {
        if (id !== sessionUid) return;
        setHookHibernated(value);
      },
      hibernateDaemon: (id) => requestHibernation(id, undefined).then(() => undefined),
      wakeDaemon: (id) => wakeHibernatedSessionWithAuth(id).then(() => undefined),
    });
    window.__loamHibernation = hook;
    resolveHibernationReady();
    return () => {
      delete window.__loamHibernation;
    };
  }, [dispatch, hibernation.hibernated, hookHibernated, sessionUid]);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [takeoverNote, setTakeoverNote] = useState('');
  const [controlBusy, setControlBusy] = useState(false);

  useEffect(() => {
    try {
      setApproveForMe(localStorage.getItem(`loam.approveForMe.${sessionUid}`) === '1');
      setKnowledgeOn(localStorage.getItem(`loam.knowledge.${sessionUid}`) === '1');
    } catch {
      // Non-browser environment: keep default.
    }
  }, [sessionUid]);

  const onAuthFailure = useMemo(() => () => {
    dispatch(setError({ sessionId: sessionUid, error: t('Session expired. Please sign in again.') }));
    handleAuthFailure();
  }, [dispatch, sessionUid]);

  const onRpcError = (message: string) => {
    dispatch(setError({ sessionId: sessionUid, error: message }));
  };

  useEffect(() => {
    const rpc = new RpcClient({
      getToken: getSessionToken,
      apiBase,
      onUnauthorized: onAuthFailure,
    });
    const socket = new ChatSocket({
      getToken: getSessionToken,
      socketBase: getSocketBase(),
      onMessage: (m: ServerMessage) => handleServerMessage(m, sessionUid, dispatch),
      onAuthFailure,
      onError: onRpcError,
    });
    socketRef.current = socket;
    let mounted = true;

    // BUILD_SPEC §6.4: remember the highest durable log `seq` the server has
    // sent for this session, so a reconnect resumes by sequence and never
    // re-renders a frame it already has. Declared outside the async closure so
    // the effect's cleanup can unsubscribe it.
    const onSeqFrame = (m: ServerMessage) => {
      if (m.type !== 'event') return;
      socket.noteSeq(sessionUid, m.seq);
    };
    const offSeqFrame = socket.onMessage(onSeqFrame);

    (async () => {
      // Read the pending prompt once from the URL when this session first mounts.
      // We intentionally do not list searchParams/router as effect deps so a URL
      // cleanup after sending does not tear down the socket and replay history.
      const draft = searchParams.get('draft') || '';
      const isNewDraft = Boolean(draft);
      let existingSession: { title: string; lastDisplayMessage?: string; icon?: string } | undefined;
      if (!isNewDraft) {
        try {
          const res = await rpc.getSession({ sessionUid });
          existingSession = res.session;
        } catch (e) {
          // Only show an error for reloads of real sessions; new drafts may 404.
          onRpcError(e instanceof Error ? e.message : String(e));
        }
      }

      try {
        await socket.connect();
      } catch {
        if (!mounted) return;
        onAuthFailure();
        return;
      }
      if (!mounted) return;
      // Join before sending so the first message is received on this socket.
      socket.join(sessionUid);

      if (draft && !sentDraft.current.sent) {
        sentDraft.current.sent = true;
        sentDraftSessions.add(sessionUid);
        const mode = (searchParams.get('mode') as TaskMode) || 'standard';
        const cwd = searchParams.get('cwd') || undefined;
        const attachmentsParam = searchParams.get('attachments');
        const draftAttachments = attachmentsParam ? parseAttachments(attachmentsParam) : [];
        socket.sendText(sessionUid, draft, mode, draftAttachments, makeExtData(cwd, draftExtData));
        // Show Stop right away; the server's status event may lag behind the first send.
        dispatch(setStatus({ sessionId: sessionUid, status: 'running' }));
        dispatch(addSession({
          uid: sessionUid,
          title: existingSession?.title ?? draft.slice(0, 60),
          status: 6,
          lastMessageTime: Date.now(),
          lastDisplayMessage: existingSession?.lastDisplayMessage ?? draft,
          icon: existingSession?.icon || '•',
        }));
        dispatch(selectSession(sessionUid));
        // Remove draft from the URL so a reload does not re-send it.
        const cleanParams = new URLSearchParams(searchParams.toString());
        cleanParams.delete('draft');
        const qs = cleanParams.toString();
        router.replace(`/app/${sessionUid}${qs ? `?${qs}` : ''}`, { scroll: false });
      } else if (existingSession?.title) {
        dispatch(addSession({
          uid: sessionUid,
          title: existingSession.title,
          status: 1,
          lastMessageTime: Date.now(),
          lastDisplayMessage: existingSession.lastDisplayMessage ?? '',
          icon: existingSession.icon || '•',
        }));
        dispatch(selectSession(sessionUid));
      }
    })();

    return () => {
      mounted = false;
      offSeqFrame();
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUid, apiBase, dispatch, onAuthFailure]);

  const clockEvent = useMemo(() =>
    [...events].reverse().find((e): e is CascadeTaskClockEvent => e.type === 'cascadeTaskClock'),
  [events]);

  const assistantText = useMemo(() => {
    const final = [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'assistant' && e.deliveryKind === 'result');
    return final?.content ?? '';
  }, [events]);

  const userText = useMemo(() => {
    const latest = [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'user');
    return latest?.content ?? '';
  }, [events]);

  // Phase-2 W5 voice: the LAST assistant message, streamed or final, feeds TTS.
  const assistantLive = useMemo(() => {
    const latest = [...events].reverse().find((e): e is ChatMessageEvent => e.type === 'chat' && e.sender === 'assistant');
    return {
      id: latest?.id ?? '',
      text: latest?.content ?? '',
      finished: latest ? latest.deliveryKind === 'result' : false,
    };
  }, [events]);

  const wasStoppedByUser = useMemo(() => events.some((e) => e.type === 'userStop'), [events]);

  const hasResult = useMemo(() => events.some((e) => e.type === 'chat' && e.sender === 'assistant' && e.deliveryKind === 'result'), [events]);
  const hasClockClosed = useMemo(() => events.some((e) => e.type === 'cascadeTaskClock' && e.clock.phase === 'closed'), [events]);
  const terminalErrorAt = useMemo(() => [...events].reverse().find((event) => {
    const candidate = event as unknown as { type?: string; agentStatus?: string };
    return candidate.type === 'error' || (candidate.type === 'statusUpdate' && candidate.agentStatus === 'error');
  })?.timestamp, [events]);
  const terminalStatusError = useMemo(() => [...events].reverse().find((event): event is StatusUpdateEvent => event.type === 'statusUpdate' && event.agentStatus === 'error'), [events]);
  const errorMessage = error ?? terminalStatusError?.brief ?? '';
  const failed = Boolean(errorMessage) || status === 'error';
  const visualStatus = taskVisualStatus({ running, wasStoppedByUser, failed, hasResult, hasClockClosed });
  const badgeSnapshot = ['Task completed', 'Task failed', 'Stopped'].includes(visualStatus) && runtime.snapshot
    ? { ...runtime.snapshot, state: 'idle', sleeping: false }
    : runtime.snapshot;
  const [selectedTool, setSelectedTool] = useState<ToolUsedEvent | null>(null);
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceOpenTarget | null>(null);
  const workspaceOpenActionRef = useRef<string>('');
  const editorsVersion = useSyncExternalStore(subscribeWorkspaceEditors, workspaceEditorsVersion, workspaceEditorsVersion);
  const [filesOpen, setFilesOpen] = useState(false);
  // Cap G: the App project bound to this task (if any), its workspace drawer,
  // and the composer Race chip state.
  const [appProject, setAppProject] = useState<AppProjectDto | null>(null);
  const [appBuilderOpen, setAppBuilderOpen] = useState(false);
  const [raceActive, setRaceActive] = useState(false);
  const [raceBranches, setRaceBranches] = useState<2 | 3 | 4>(2);
  const [raceEstimate, setRaceEstimate] = useState<RaceEstimateDto | null>(null);
  const [taskFiles, setTaskFiles] = useState<Array<{ name: string; path: string; size: number; kind: AttachmentKind }>>([]);
  const [taskFilesLoading, setTaskFilesLoading] = useState(false);
  const autoOpenedRef = useRef<Set<string>>(new Set());

  const taskId = useMemo(() => {
    const fromAttachment = events.find((e): e is AttachmentEvent => e.type === 'attachment');
    const fromClock = events.find((e): e is CascadeTaskClockEvent => e.type === 'cascadeTaskClock');
    return fromClock?.clock.taskId ?? fromAttachment?.taskId;
  }, [events]);

  // Cap G: resolve (and keep fresh) the App project bound to this task, and load
  // the Race estimate for the selected branch count whenever a project exists.
  useEffect(() => {
    if (!taskId) { setAppProject(null); return; }
    let alive = true;
    const timer = setInterval(() => {
      void findProjectByTask(taskId).then((p) => { if (alive) setAppProject(p); }).catch(() => {});
    }, 15_000);
    void findProjectByTask(taskId).then((p) => { if (alive) setAppProject(p); }).catch(() => {});
    return () => { alive = false; clearInterval(timer); };
  }, [taskId]);

  useEffect(() => {
    if (!appProject) { setRaceEstimate(null); return; }
    void fetchRaceEstimate(appProject.id, raceBranches).then((r) => setRaceEstimate(r.estimate)).catch(() => setRaceEstimate(null));
  }, [appProject, raceBranches]);

  const attachmentEvents = useMemo(() => events.filter((e): e is AttachmentEvent => e.type === 'attachment'), [events]);
  const presentationAttachment = useMemo(() => [...attachmentEvents].reverse().find((attachment) =>
    Boolean(attachment.taskId)
    && attachment.path?.toLowerCase().endsWith('.pptx')
    && attachmentEvents.some((preview) => preview.taskId === attachment.taskId && preview.path === 'previews/slide-1.png'),
  ), [attachmentEvents]);
  const eventListEvents = useMemo(() => presentationAttachment ? events.filter((event) => event.type !== 'attachment') : events, [events, presentationAttachment]);
  useConversationAutoScroll(conversationRef, eventListEvents);

  const loadTaskFiles = async () => {
    if (!taskId) return;
    setTaskFilesLoading(true);
    try {
      const headers = await getApiHeaders();
      const params = new URLSearchParams({ taskId, path: '', max: '300' });
      const res = await fetch(`${apiBase}/api/files?${params.toString()}`, { headers });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { entries?: Array<{ name: string; path: string; size: number; dir?: boolean }> };
      const entries = (data.entries ?? []).filter((e) => !e.dir);
      setTaskFiles(entries.map((e) => ({ ...e, kind: kindFromName(e.name) })));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('failed to load task files', e);
    } finally {
      setTaskFilesLoading(false);
    }
  };

  // Auto-open Loam's computer panel on the first tool/computer activity event.
  useEffect(() => {
    if (selectedTool || autoOpenedRef.current.has(sessionUid)) return;
    const firstTool = events.find((e): e is ToolUsedEvent => e.type === 'toolUsed');
    if (firstTool) {
      setSelectedTool(firstTool);
      autoOpenedRef.current.add(sessionUid);
    }
  }, [events, sessionUid, selectedTool]);

  // Auto-open the right panel on the Workspace tab when a tool touches a file
  // that a registered editor can open, or an office_*/video tool runs.
  const wsDecision = useMemo(() => latestWorkspaceDecision(events), [events, editorsVersion]);
  useEffect(() => {
    if (!wsDecision) return;
    const { event, target } = wsDecision;
    // A user-message decision (attached video + edit intent) is not a tool event;
    // wrap it in a studio stub so the panel can open on the Workspace tab.
    const actionId = event.type === 'toolUsed' ? event.actionId : event.id;
    if (workspaceOpenActionRef.current === actionId) return;
    workspaceOpenActionRef.current = actionId;
    setSelectedTool(event.type === 'toolUsed' ? event : videoStudioStub(event));
    setWorkspaceTarget((current) => mergeWorkspaceTarget(current, target));
    autoOpenedRef.current.add(sessionUid);
  }, [wsDecision, sessionUid]);

  const resolvedLoamMode = useMemo(() => {
    const ev = [...events].reverse().find((e): e is ModeEvent => e.type === 'mode');
    return ev ? { mode: ev.mode, label: ev.label, labelAr: ev.labelAr } : null;
  }, [events]);

  const handleSend = async (text: string, mode: TaskMode, files: File[], extData?: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket) return;
    // Cap G §4.13.2: a raced send goes to the App project's run endpoint instead
    // of the chat socket; the chip turns off again after every send. Until the
    // multi-agent engine lands the server answers engine_pending, which we show
    // verbatim instead of pretending a race started.
    const raceBranchCount = extData?.appRaceBranches;
    if (appProject && typeof raceBranchCount === 'number') {
      setRaceActive(false);
      try {
        await startRun(appProject.id, text, 'quick', { branches: raceBranchCount as 2 | 3 | 4 });
      } catch (err) {
        dispatch(setError({ sessionId: sessionUid, error: err instanceof Error ? err.message : 'فشل إرسال مقارنة الفروع' }));
      }
      void runtime.refresh();
      return;
    }
    dispatch(setStatus({ sessionId: sessionUid, status: 'running' }));
    let attachments = draftAttachments;
    if (files.length > 0) {
      const uploaded = await Promise.all(files.map((f) => uploadFile(apiBase, f)));
      attachments = [...attachments, ...uploaded];
    }
    socket.sendText(sessionUid, text, mode, attachments, makeExtData(cwd, { approveForMe, knowledge: knowledgeOn, ...legalExtData(), ...extData }));
    // The badge should react immediately rather than waiting for the poll.
    void runtime.refresh();
  };

  const handlePresentationVideo = (request: PresentationVideoRequest) =>
    handleSend(request.text, request.mode, [], request.extData);

  const handleStop = () => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.stop(sessionUid);
  };

  // Phase-2 W5 voice: a finalized mic segment replaces the draft and rides the
  // composer's own submit path, so mode chips and extData travel with it
  // exactly as with a typed message. Barge-in lives inside the hook.
  const composerRef = useRef<ComposerHandle>(null);
  // H5: completion card is dismissed per run and returns on the next run.
  const [completionDismissed, setCompletionDismissed] = useState(false);
  useEffect(() => {
    if (running) setCompletionDismissed(false);
  }, [running]);
  const voiceChat = useVoiceChat({
    onFinalTranscript: (text) => {
      const composer = composerRef.current;
      if (!composer) return;
      composer.setText(text);
      composer.focus();
      composer.submit();
    },
  });

  // Feed the growing last assistant reply to TTS while auto-speak is on. The
  // reply already on screen when the page (or session) first mounts is
  // remembered, never voiced; only replies that arrive afterwards speak.
  const voicedReplyRef = useRef<string | null>(null);
  useEffect(() => {
    voicedReplyRef.current = null;
  }, [sessionUid]);
  const { autoSpeak: voiceAutoSpeak, feedReply, resetReply } = voiceChat;
  useEffect(() => {
    if (voicedReplyRef.current === null) {
      voicedReplyRef.current = assistantLive.id;
      return;
    }
    const isNewReply = voicedReplyRef.current !== assistantLive.id;
    voicedReplyRef.current = assistantLive.id;
    if (!voiceAutoSpeak) return;
    if (isNewReply) resetReply();
    feedReply(assistantLive.text, assistantLive.finished);
  }, [assistantLive, voiceAutoSpeak, feedReply, resetReply]);

  // Time-travel: clicking a timeline step selects it and greys later steps.
  const handleSelectStep = (step: TimelineStep) => {
    setSelectedActionId(step.actionId);
    const ev = events.find((e): e is ToolUsedEvent => e.type === 'toolUsed' && e.actionId === step.actionId);
    if (ev) setSelectedTool(ev);
    if (step.actionId !== workspaceOpenActionRef.current) setWorkspaceTarget(null);
  };

  // H2 follow-live: while running and the user is on the newest step, new
  // steps advance the panel automatically; scrubbing back stops following
  // until the «مباشر» button returns to the newest step.
  const timelineSteps = useMemo(() => deriveTimelineSteps(events), [events]);
  const lastStep = timelineSteps.at(-1) ?? null;
  useEffect(() => {
    if (!running || !lastStep || !selectedTool) return;
    const onNewest = selectedActionId === null || selectedActionId === lastStep.actionId;
    if (onNewest && selectedTool.actionId !== lastStep.actionId) {
      const ev = events.find((e): e is ToolUsedEvent => e.type === 'toolUsed' && e.actionId === lastStep.actionId);
      if (ev) {
        setSelectedTool(ev);
        setSelectedActionId(lastStep.actionId);
      }
    }
  }, [running, lastStep, selectedTool, selectedActionId, events]);

  // D16: Pause the running agent, then take over with a "user changed X" note.
  const handlePause = async () => {
    if (!taskId) return;
    setControlBusy(true);
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/pause`, { method: 'POST', headers });
      if (res.ok) setPaused(true);
    } catch {
      // Best effort; the run keeps going if the control plane is unavailable.
    } finally {
      setControlBusy(false);
    }
  };

  const handleResume = async () => {
    if (!taskId) return;
    setControlBusy(true);
    try {
      const headers = await getApiHeaders();
      const res = await fetch(`${getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/resume`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ note: takeoverNote }),
      });
      if (res.ok) {
        setPaused(false);
        setTakeoverNote('');
      }
    } catch {
      // Best effort.
    } finally {
      setControlBusy(false);
    }
  };

  // Option 14: "Approve for me" chip — toggles per-task auto-approve. The flag
  // rides on the next message's extData and is pushed live for this session id.
  const handleToggleApproveForMe = () => {
    const next = !approveForMe;
    setApproveForMe(next);
    try {
      localStorage.setItem(`loam.approveForMe.${sessionUid}`, next ? '1' : '0');
    } catch {
      // Non-browser environment: skip persistence.
    }
    void (async () => {
      try {
        await fetch(`${getApiBase()}/api/approval-tasks/${encodeURIComponent(sessionUid)}`, {
          method: 'PUT',
          headers: { ...(await getApiHeaders()), 'content-type': 'application/json' },
          body: JSON.stringify({ auto: next }),
        });
      } catch {
        // Best effort: new sessions pick it up via extData on the next message.
      }
    })();
  };

  // Neo N3: the Knowledge Garden chip opts THIS run into the user's imported
  // sources. It is remembered per session so the next message keeps the choice.
  const handleToggleKnowledge = () => {
    const next = !knowledgeOn;
    setKnowledgeOn(next);
    try {
      localStorage.setItem(`loam.knowledge.${sessionUid}`, next ? '1' : '0');
    } catch {
      // Non-browser environment: skip persistence.
    }
  };

  const handleWorkspaceChatEdit = (instruction: string, file: WorkspaceFile) => {
    const socket = socketRef.current;
    if (!socket) return;
    const mode = (resolvedLoamMode?.mode as TaskMode) || 'standard';
    socket.sendText(sessionUid, `Edit ${file.path}: ${instruction}`, mode, [], makeExtData(cwd));
  };

  /**
   * Manual open (cr-03): the user clicked "Open in Loam Docs" on an attachment, so
   * the matching Craft app (or the built-in editor) mounts on the Workspace tab
   * with that file selected. The tool stub is only a carrier: the panel itself
   * renders the file list and the editor, exactly like the auto-open path.
   */
  const handleOpenFileInEditor = (file: { taskId: string; path: string; name: string; mime?: string }) => {
    const kind = editorKindForExtension(craftExtOf(file.path));
    if (!kind) return;
    const target: WorkspaceOpenTarget = { path: file.path, kind };
    if (kind === 'craft') target.craftApp = craftAppForExtension(craftExtOf(file.path));
    workspaceOpenActionRef.current = file.path;
    setSelectedTool({
      id: `open-${file.path}`,
      type: 'toolUsed',
      tool: kind === 'craft' ? 'office_craft' : kind === 'loam-video' ? 'video_studio' : 'office_open',
      actionId: `open-${file.path}`,
      status: 'success',
      timestamp: Date.now(),
      brief: t('Open in editor'),
    });
    setWorkspaceTarget(target);
    autoOpenedRef.current.add(sessionUid);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-row shrink-0 items-center justify-end gap-2 overflow-x-auto px-4 sm:px-6">
        {running && taskId && !paused && (
          <button
            type="button"
            onClick={() => void handlePause()}
            disabled={controlBusy}
            className="flex h-row-sm items-center gap-1 rounded-control px-2 text-sm text-text-secondary hover:bg-fill-hover disabled:opacity-40"
          >
            {t('Pause')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="flex h-row-sm items-center gap-1 rounded-control px-2 text-sm text-text-secondary hover:bg-fill-hover"
        >
          <Share className="size-4" /> {t('Share')}
        </button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><FileChartColumn className="size-4" /></button>
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><MoreHorizontal className="size-4" /></button>
        {appProject && (
          <button
            type="button"
            onClick={() => setAppBuilderOpen((v) => !v)}
            aria-pressed={appBuilderOpen}
            data-testid="appbuilder-toggle"
            title={t('App Builder workspace')}
            className={`rounded-control p-1.5 hover:bg-fill-hover ${appBuilderOpen ? 'text-icon-blue' : 'text-text-secondary'}`}
          >
            <AppWindow className="size-4" />
          </button>
        )}
        <button className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"><PanelRight className="size-4" /></button>
      </div>

      {paused && (
        <div className="flex items-center gap-2 border-b border-border-main bg-fill-tsp px-4 py-2 sm:px-6">
          <span className="text-sm text-function-warning">{t('Paused')}</span>
          <input
            type="text"
            value={takeoverNote}
            onChange={(e) => setTakeoverNote(e.target.value)}
            placeholder={t('What did you change?')}
            aria-label={t('What did you change?')}
            className="h-8 flex-1 rounded-control border border-border-main bg-bg-menu px-2 text-sm text-text-primary outline-none focus:border-icon-blue"
          />
          <button
            type="button"
            onClick={() => void handleResume()}
            disabled={controlBusy}
            className="flex h-8 items-center rounded-control bg-icon-blue px-3 text-sm font-medium text-white disabled:opacity-40"
          >
            {t('Take over')}
          </button>
        </div>
      )}

      <div className="flex h-dvh min-h-0 w-full flex-none overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div ref={conversationRef} data-testid="conversation-scroll" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[min(100%,48rem)] px-4 py-4 sm:px-6">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-lg">◉</span>
                <span className="text-base font-semibold text-text-primary">{PRODUCT}</span>
              </div>
              {/* D19: sleep state + compute budget for this session. */}
              <div className="mb-2">
                <SessionStatusBadge
                  snapshot={badgeSnapshot}
                  onRaiseBudget={() => void runtime.raiseBudget()}
                  onWake={() => void runtime.wake()}
                />
              </div>
              {/* J7: local status only — never a message to the model. */}
              <HibernationNotice hibernated={hibernation.hibernated} />
              <ThinkingTrace
                text={([...events].reverse().find((event): event is Extract<(typeof events)[number], { type: 'liveStatus' }> => event.type === 'liveStatus')?.text) ?? ''}
                active={running || Boolean(userText && !assistantText && !running && !wasStoppedByUser && !errorMessage)}
              />
              {clockEvent && !running && (
                <div className="mb-2 text-sm text-text-tertiary">
                  {t('Worked for {duration}', { duration: formatDuration(computeTaskClockDuration(clockEvent, errorMessage ? terminalErrorAt : undefined)) })} ›
                </div>
              )}
              {errorMessage && !draftText && (
                <div className="mb-2 rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error" role="alert">
                  <strong>{t('Task failed')}</strong>
                  <p className="mt-1">{t('The task stopped before producing a verified result.')}</p>
                  {userText && (
                    <button
                      type="button"
                      disabled={running}
                      onClick={() => void handleSend(userText, (resolvedLoamMode?.mode as TaskMode) || draftMode, [])}
                      className="mt-2 inline-flex items-center gap-1 rounded-control border border-current px-2 py-1 disabled:opacity-40"
                    >
                      <Repeat2 className="size-4" /> {t('Retry')}
                    </button>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer">{t('Technical details')}</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{errorMessage}</pre>
                  </details>
                </div>
              )}
              <TaskMetricsBand taskId={taskId} />
              <StepTimeline events={events} selectedActionId={selectedActionId} onSelect={handleSelectStep} />
              <EventList
                events={eventListEvents}
                sessionId={sessionUid}
                socket={socketRef.current}
                hibernated={hookHibernated || hibernation.hibernated}
                onOpenFile={handleOpenFileInEditor}
                onOpenComputer={(e) => {
                  setSelectedTool(e);
                  setSelectedActionId(e.actionId);
                  if (e.actionId !== workspaceOpenActionRef.current) setWorkspaceTarget(null);
                }}
              />

              {hasResult && hasClockClosed && !running && !wasStoppedByUser && (
                <div className="mx-auto w-full max-w-[min(100%,48rem)] px-4 sm:px-6">
                  {!completionDismissed && (
                    <CompletionCard
                      onFill={(text) => composerRef.current?.setText(text)}
                      onDismiss={() => setCompletionDismissed(true)}
                    />
                  )}
                  {attachmentEvents.length > 0 && (
                    <div className="mb-3 grid gap-2 sm:grid-cols-2">
                      {attachmentEvents.filter((a) => a.path !== 'previews/slide-1.png' && !a.path?.startsWith('assets/') && !a.path?.startsWith('generated-assets/')).map((a) => (
                        <AttachmentCard
                          key={a.id}
                          name={a.name}
                          mime={a.mime}
                          size={a.sizeBytes}
                          taskId={a.taskId}
                          path={a.path}
                          previewPath={kindFromName(a.name) === 'slide' && attachmentEvents.some((preview) => preview.taskId === a.taskId && preview.path === 'previews/slide-1.png') ? 'previews/slide-1.png' : undefined}
                          openLabel={openLabelForAttachment(a.path)}
                          onOpen={
                            a.taskId && a.path
                              ? () => handleOpenFileInEditor({ taskId: a.taskId, path: a.path, name: a.name, mime: a.mime })
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                  {taskId && (
                    <div className="mb-4">
                      <button
                        type="button"
                        onClick={() => { setFilesOpen(true); void loadTaskFiles(); }}
                        className="flex items-center gap-1.5 rounded-control px-2 py-1 text-sm font-medium text-text-secondary hover:bg-fill-hover"
                      >
                        <FileChartColumn className="size-4" />
                        {t('View all files in this task')}
                      </button>
                    </div>
                  )}
                  <div className="mb-4 flex items-center gap-2 text-sm text-text-tertiary">
                    <button
                      type="button"
                      aria-label={t('Copy message')}
                      title={t('Copy message')}
                      onClick={() => { if (assistantText) void navigator.clipboard.writeText(assistantText).catch(() => {}); }}
                      className="rounded-control p-1 hover:bg-fill-hover"
                    >
                      <Copy className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('Retry last message')}
                      title={t('Retry last message')}
                      disabled={running || !userText}
                      onClick={() => { if (userText) void handleSend(userText, (resolvedLoamMode?.mode as TaskMode) || draftMode, []); }}
                      className="rounded-control p-1 hover:bg-fill-hover disabled:opacity-40"
                    >
                      <Repeat2 className="size-4" />
                    </button>
                    <span className="ms-auto">{formatTime(Date.now())}</span>
                  </div>
                  <div className="mb-2 flex items-center gap-2 text-sm text-text-secondary">
                    <span className="ms-auto">{t('How was this result?')}</span>
                    {[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-4 text-[#d4d4d4]" />)}
                  </div>
                  {presentationAttachment?.taskId && presentationAttachment.path && (
                    <PresentationVideoCard
                      taskId={presentationAttachment.taskId}
                      path={presentationAttachment.path}
                      previewPath="previews/slide-1.png"
                      name={presentationAttachment.name}
                      disabled={running}
                      onCreateVideo={handlePresentationVideo}
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="mx-auto w-full max-w-[min(100%,48rem)] shrink-0 px-4 pb-4 sm:px-6">
            <div className="mb-2 flex min-h-8 items-center gap-2 rounded-control bg-fill-tsp px-2 py-1 text-sm text-text-secondary">
              <span className={running ? 'animate-pulse text-icon-blue' : wasStoppedByUser ? 'text-function-warning' : errorMessage ? 'text-function-error' : hasResult && hasClockClosed ? 'text-func-success' : 'text-text-tertiary'}>
                {running ? '●' : wasStoppedByUser ? '◼' : errorMessage ? '✕' : hasResult && hasClockClosed ? '✓' : '○'}
              </span>
              {t(visualStatus)}
            </div>
            {running && !selectedTool && (
              <ComputerDock
                sessionId={sessionUid}
                taskId={taskId ?? null}
                events={events}
                onOpen={(ev) => {
                  setSelectedTool(ev);
                  setWorkspaceTarget(null);
                }}
              />
            )}
            <MatterComposer />
            <VoiceChatControls voice={voiceChat} />
            <Composer
              ref={composerRef}
              onSend={handleSend}
              onStop={handleStop}
              running={running}
              onFirstInput={(draft) => void hibernation.onFirstInput(draft)}
              defaultLoamMode={draftLoamMode}
              resolvedLoamMode={resolvedLoamMode}
              assistantReply={assistantText}
              approveForMe={approveForMe}
              onToggleApproveForMe={handleToggleApproveForMe}
              knowledgeOn={knowledgeOn}
              onToggleKnowledge={handleToggleKnowledge}
              outputType={draftOutputType}
              effort={draftEffort}
              compareModels={draftCompare}
              abModels={draftAbModels}
              race={appProject ? {
                active: raceActive,
                onToggle: () => setRaceActive((v) => !v),
                branches: raceBranches,
                onBranches: setRaceBranches,
                extraCredits: raceEstimate?.extraCredits,
                maxTotalCredits: raceEstimate?.maxTotalCredits,
              } : null}
            />
            <SideChatPanel taskId={taskId ?? null} />
          </div>
        </div>
        {selectedTool && (
          <ComputerPanel
            sessionId={sessionUid}
            taskId={taskId ?? undefined}
            event={selectedTool}
            steps={timelineSteps}
            onSelectStep={handleSelectStep}
            live={running}
            onClose={() => {
              setSelectedTool(null);
              setWorkspaceTarget(null);
            }}
            focusWorkspace={Boolean(workspaceTarget)}
            workspaceSlot={
              taskId ? (
                <WorkspacePanel
                  taskId={taskId}
                  live={running}
                  events={events}
                  requestedPath={workspaceTarget?.path ?? null}
                  requestedKind={workspaceTarget?.kind ?? null}
                  requestedCraftApp={workspaceTarget?.craftApp ?? null}
                  onChatEdit={handleWorkspaceChatEdit}
                />
              ) : null
            }
          />
        )}
      </div>
      {taskId ? (
        <TaskRelayHost
          taskId={taskId}
          onOpen={(target) => {
            const actionId = `relay-${target.kind ?? 'open'}-${target.path ?? target.craftApp ?? ''}`;
            setSelectedTool({
              id: actionId,
              type: 'toolUsed',
              tool: target.kind === 'loam-video' ? 'video_studio' : 'office_craft',
              actionId,
              status: 'success',
              timestamp: Date.now(),
              brief: target.craftApp ?? target.kind ?? '',
            });
            setWorkspaceTarget(target);
            autoOpenedRef.current.add(sessionUid);
          }}
        />
      ) : null}
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} taskId={taskId ?? null} />

      {/* Cap G §4.16: the Agent Studio App Builder workspace drawer. */}
      {appBuilderOpen && appProject && (
        <div className="fixed inset-y-0 end-0 z-40 w-[min(35rem,100%)] border-s border-border-main bg-bg-panel shadow-xl" data-testid="appbuilder-workspace">
          <AppBuilderWorkspace projectId={appProject.id} onClose={() => setAppBuilderOpen(false)} />
        </div>
      )}

      {filesOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[min(80dvh,100%)] w-full max-w-[min(100%,40rem)] flex-col rounded-card border border-border-main bg-bg-menu shadow-lg">
            <div className="flex h-row items-center justify-between border-b border-border-main px-4">
              <h2 className="text-title-sm text-text-primary">{t('Files in this task')}</h2>
              <button
                type="button"
                onClick={() => setFilesOpen(false)}
                className="rounded-control p-1.5 text-text-secondary hover:bg-fill-hover"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {taskFilesLoading ? (
                <div className="flex items-center justify-center py-8 text-text-secondary">
                  <Loader2 className="mr-2 size-5 animate-spin" /> {t('Loading')}
                </div>
              ) : taskFiles.length === 0 ? (
                <p className="py-8 text-center text-sm text-text-tertiary">{t('No files found in this task.')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {taskFiles.map((f) => (
                    <li key={f.path}>
                      <AttachmentCard
                        name={f.name}
                        kind={f.kind}
                        size={f.size}
                        taskId={taskId}
                        path={f.path}
                        openLabel={openLabelForAttachment(f.path)}
                        onOpen={
                          taskId
                            ? () => handleOpenFileInEditor({ taskId, path: f.path, name: f.name })
                            : undefined
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Wrap a non-tool auto-open decision (attached video + edit intent) in a studio stub. */
function videoStudioStub(event: ChatEvent): ToolUsedEvent {
  return {
    id: event.id,
    type: 'toolUsed',
    tool: 'video_studio',
    actionId: event.id,
    status: 'running',
    timestamp: event.timestamp,
    brief: t('Loam Video'),
  };
}

/**
 * The button label for a task file, when a workspace editor can open it. Craft files
 * name the app that owns them (`Open in Loam Docs`); everything else the editors accept
 * gets a neutral label and non-editor files get `undefined` (plain download).
 */
function openLabelForAttachment(path: string): string | undefined {
  const kind = editorKindForExtension(craftExtOf(path));
  if (!kind) return undefined;
  if (kind === 'loam-video') return t('Loam Video');
  if (kind !== 'craft') return t('Open in editor');
  const app = craftAppForExtension(craftExtOf(path));
  return app ? t(`Open in ${CRAFT_APPS[app].displayName}`) : t('Open in editor');
}

function handleServerMessage(m: ServerMessage, sessionId: string, dispatch: AppDispatch) {
  if (m.type !== 'event') return;
  const ev = m.event;
  if (ev.type === 'eventsNotifyEventsAfter') {
    const notify = ev as unknown as EventsNotifyEventsAfterEvent;
    for (const rawInner of notify.events) {
      const inner = rawInner as ChatEvent;
      if (inner.type === 'chatDelta') {
        dispatch(applyDelta({ sessionId, delta: inner as ChatDeltaEvent }));
      } else {
        if (inner.type === 'statusUpdate') {
          dispatch(setStatus({ sessionId, status: (inner as StatusUpdateEvent).agentStatus }));
        }
        if (inner.type === 'cascadeTaskClock' && inner.clock.taskId) ensureTaskRelay(inner.clock.taskId);
        const errorLike = inner as unknown as { type?: string; message?: string };
        if (errorLike.type === 'error') {
          dispatch(setError({ sessionId, error: errorLike.message ?? t('An error occurred') }));
        }
        dispatch(appendEvent({ sessionId, event: inner }));
      }
    }
    return;
  }
  if (ev.type === 'chatDelta') {
    dispatch(applyDelta({ sessionId, delta: ev as ChatDeltaEvent }));
    return;
  }
  if (ev.type === 'statusUpdate') {
    dispatch(setStatus({ sessionId, status: (ev as StatusUpdateEvent).agentStatus }));
  }
  if (ev.type === 'cascadeTaskClock' && ev.clock.taskId) ensureTaskRelay(ev.clock.taskId);
  const errorLike = ev as unknown as { type?: string; message?: string };
  if (errorLike.type === 'error') {
    dispatch(setError({ sessionId, error: errorLike.message ?? t('An error occurred') }));
  }
  dispatch(appendEvent({ sessionId, event: ev }));
}
