'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  X,
  Settings,
  Play,
  Loader2,
  AlertCircle,
  Plus,
  Send,
  Mail,
  Trash2,
  Monitor,
  Maximize2,
  ChevronRight,
  ArrowLeft,
  Bell,
  BellOff,
} from 'lucide-react';
import { t } from '@/i18n/t';
import { Button, Spinner } from '@/components/ui/Button';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import {
  getAgentMemory,
  listApprovalRules,
  removeApprovalRule,
  listScratchpad,
  addScratchpadItem,
  completeScratchpadItem,
  listWatches,
  addWatch,
  deleteWatch,
  listSchedules,
  runScheduleNow,
  listChannelStatus,
  listChannelBindings,
  bindChannel,
  unbindChannel,
  listChildren,
  getLiveViewStatus,
  getLiveViewFrame,
} from '@/services/agentInfoApi';
import type {
  MemoryEntry,
  Schedule,
  ApprovalRuleRow,
  UrlWatch,
  ChannelStatus,
  ChannelBinding,
  ScratchpadItem,
  ChildAgent,
  LiveFrame,
} from '@/services/agentInfoApi';
import { LiveView } from '@/components/computer/LiveView';
import { TeamRunsList } from './TeamRunsList';
import type { AgentCardAgent } from './AgentCard';
import { AgentAvatar, AVATAR_SHAPES, AVATAR_COLORS } from './AgentAvatar';
import { agentLabel } from './agentLabels';
import { AgentContextMenu } from './AgentContextMenu';
import { GroupMembersTab } from './GroupMembersTab';
import type { GroupChat } from './groupTypes';

interface AgentWithMeta extends AgentCardAgent {
  description?: string;
  instructions?: string;
  effort?: string;
  allowedServices?: string[];
  workMode?: string;
  title?: string;
  notifications?: boolean;
}

interface AgentInfoPaneProps {
  agent: AgentWithMeta;
  threadUid: string | null;
  onClose: () => void;
  /** Opens the rename dialog for this agent. */
  onRenameAgent?: () => void;
  /** Permanently deletes this agent (the context menu asks for confirmation). */
  onDeleteAgent?: () => void;
  /** Optional pin/hide handlers; the header menu items stay stubs without them. */
  onTogglePin?: () => void;
  onToggleHide?: () => void;
  /** Reloads the agent list after the per-agent settings subpage saves. */
  onSaved?: () => void;
  /** When set, the pane shows group details instead of the selected agent. */
  group?: GroupChat | null;
  onGroupChanged?: (group: GroupChat) => void;
}

export function AgentInfoPane({ agent, threadUid, onClose, onRenameAgent, onDeleteAgent, onTogglePin, onToggleHide, onSaved, group, onGroupChanged }: AgentInfoPaneProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const showHeaderMenu = !group && Boolean(onRenameAgent || onDeleteAgent);
  const headerTitle = group ? group.name : agent.name;
  const headerSubtitle = group ? t('Group chat') : agent.title || agent.description || agent.mode || 'loam';

  if (settingsOpen && !group) {
    return (
      <aside className="flex w-[340px] shrink-0 flex-col border-s border-border-main bg-bg-menu">
        <AgentSettingsSubpage
          agent={agent}
          onBack={() => setSettingsOpen(false)}
          onClose={onClose}
          onSaved={() => {
            onSaved?.();
            setSettingsOpen(false);
          }}
        />
      </aside>
    );
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-s border-border-main bg-bg-menu">
      <div
        className="flex h-row items-center justify-between border-b border-border-main px-4"
        onContextMenu={
          showHeaderMenu
            ? (e) => {
                e.preventDefault();
                setHeaderMenu({ x: e.clientX, y: e.clientY });
              }
            : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <AgentAvatar
            name={group ? group.name : agent.name}
            id={group ? group.id : agent.id}
            avatarShape={agent.avatarShape}
            avatarColor={agent.avatarColor}
            avatarImage={agent.avatarImage}
            emoji={group ? '👥' : agent.emoji}
            size={32}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{headerTitle}</p>
            <p className="truncate text-xs text-text-tertiary">{headerSubtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!group && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              className="h-row-sm w-row-sm px-0"
              aria-label={t('Agent settings')}
              title={t('Agent settings')}
            >
              <Settings className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-row-sm w-row-sm px-0"
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!group && <ComputerPreviewCard agentId={agent.id} agentName={agent.name} threadUid={threadUid} />}

        <div className="flex flex-col gap-6 p-4">
          {group ? (
            <Section title={t('Members')}>
              <GroupMembersTab groupId={group.id} onChanged={onGroupChanged} />
            </Section>
          ) : (
            <>
              <Section title={t('Overview')}>
                <OverviewSection agent={agent} />
              </Section>
              <Section title={t('Routines')}>
                <RoutinesTab agentId={agent.id} />
              </Section>
              <Section title={t('Channels')}>
                <ChannelsTab agentId={agent.id} />
              </Section>
              <Section title={t('Members')}>
                <MembersTab agentId={agent.id} />
              </Section>
            </>
          )}
        </div>
      </div>

      {headerMenu && (
        <AgentContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          agentName={agent.name}
          onRename={() => onRenameAgent?.()}
          onTogglePin={() => onTogglePin?.()}
          onToggleHide={() => onToggleHide?.()}
          onDelete={() => onDeleteAgent?.()}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </aside>
  );
}

/** A titled block in the pane's single scroll. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Per-agent settings subpage opened from the header gear (Grok Bot parity):
 * avatar, name, title, description and the per-agent notifications toggle.
 */
function AgentSettingsSubpage({
  agent,
  onBack,
  onClose,
  onSaved,
}: {
  agent: AgentWithMeta;
  onBack: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title ?? '');
  const [description, setDescription] = useState(agent.description ?? '');
  const [notifications, setNotifications] = useState(agent.notifications !== false);
  const [avatarShape, setAvatarShape] = useState(agent.avatarShape);
  const [avatarColor, setAvatarColor] = useState(agent.avatarColor);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) {
      setError(agentLabel('nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${getApiBase()}/api/agents/${encodeURIComponent(agent.id)}`, {
        method: 'POST',
        headers: {
          ...(await getApiHeaders()),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: name.trim(),
          title: title.trim(),
          description: description.trim(),
          notifications,
          ...(avatarShape ? { avatarShape } : {}),
          ...(avatarColor ? { avatarColor } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `status ${res.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark placeholder:text-text-tertiary';

  return (
    <>
      <div className="flex h-row items-center gap-2 border-b border-border-main px-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="h-row-sm w-row-sm px-0"
          aria-label={t('Back')}
          title={t('Back')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{t('Agent settings')}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-row-sm w-row-sm px-0"
          aria-label={t('Close')}
          title={t('Close')}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-3 pb-4">
          <AgentAvatar
            name={name || agent.name}
            avatarShape={avatarShape}
            avatarColor={avatarColor}
            avatarImage={agent.avatarImage}
            size={64}
          />
          <p className="text-sm font-medium text-text-primary">{name || agent.name}</p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-tertiary">{t('Avatar')}</span>
            <div className="flex flex-wrap gap-2">
              {AVATAR_SHAPES.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  onClick={() => setAvatarShape(shape)}
                  aria-label={shape}
                  title={shape}
                  className={[
                    'rounded-control p-1 transition-colors hover:bg-fill-hover',
                    avatarShape === shape ? 'ring-2 ring-text-primary' : '',
                  ].join(' ')}
                >
                  <AgentAvatar name={name || agent.name} avatarShape={shape} avatarColor={avatarColor} size={28} />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setAvatarColor(color)}
                  aria-label={color}
                  title={color}
                  className={[
                    'rounded-control p-1 transition-colors hover:bg-fill-hover',
                    avatarColor === color ? 'ring-2 ring-text-primary' : '',
                  ].join(' ')}
                >
                  <AgentAvatar name={name || agent.name} avatarShape={avatarShape} avatarColor={color} size={28} />
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-sm text-text-secondary">
            {t('Name')}
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-text-secondary">
            {t('Title')}
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('Title')}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-text-secondary">
            {t('Description')}
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-control border border-border-main bg-bg-main p-3 hover:bg-fill-hover">
            <input
              type="checkbox"
              checked={notifications}
              onChange={(e) => setNotifications(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-text-primary"
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm text-text-primary">
                {notifications ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                {t('Per-agent notifications')}
              </p>
              <p className="text-xs text-text-tertiary">{t('Notifications for this agent')}</p>
            </div>
          </label>

          {error && (
            <p className="rounded-control bg-function-error-tsp px-3 py-2 text-sm text-function-error">{error}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-main p-4">
        <Button type="button" variant="ghost" onClick={onBack} disabled={saving}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={saving}
          disabled={saving || !name.trim()}
          onClick={handleSave}
        >
          {t('Save')}
        </Button>
      </div>
    </>
  );
}

/**
 * Live computer preview area (Grok Bot parity).
 *
 * Collapsed: a compact thumbnail that polls the latest screen frame so the
 * area shows real computer activity. Expanded: the full LiveView stream
 * (screen + browser) over a full-screen overlay with an X close.
 */
function ComputerPreviewCard({ agentId, agentName, threadUid }: { agentId: string; agentName: string; threadUid: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const key = threadUid ?? agentId;
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [liveAvailable, setLiveAvailable] = useState(true);

  useEffect(() => {
    if (expanded) return;
    let mounted = true;
    const tick = async () => {
      try {
        const status = await getLiveViewStatus(key);
        const next = await getLiveViewFrame(key, 'screen');
        if (!mounted) return;
        setLiveAvailable(status.available ?? true);
        setFrame(next);
      } catch {
        if (mounted) setLiveAvailable(true);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 4000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [key, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-bg-main">
        <div className="flex h-row shrink-0 items-center justify-between border-b border-border-main px-4">
          <span className="min-w-0 truncate text-sm font-medium text-text-primary">
            {agentName} · {t('Computer preview')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(false)}
            className="h-row-sm w-row-sm px-0"
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <LiveView sessionId={key} taskId={threadUid ?? undefined} />
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-4 pb-1 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-tertiary">{t('Computer preview')}</span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={t('Open full screen')}
          title={t('Open full screen')}
          className="rounded-control p-1 text-text-tertiary transition-colors hover:bg-fill-hover hover:text-text-primary"
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={t('Open full screen')}
        title={t('Open full screen')}
        className="relative mt-1 flex h-28 w-full items-center justify-center overflow-hidden rounded-card border border-border-main bg-bg-main px-3 text-center transition-colors hover:bg-fill-hover"
      >
        {liveAvailable && frame?.data ? (
          <img
            src={`data:${frame.mediaType};base64,${frame.data}`}
            alt={frame.title || t('Computer preview')}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <span className="flex flex-col items-center gap-1.5">
            <Monitor className="size-5 text-text-tertiary" />
            <span className="text-xs text-text-secondary">{t('No live preview yet')}</span>
            <span className="text-[11px] text-text-tertiary">{t('Click for full screen')}</span>
          </span>
        )}
      </button>
    </div>
  );
}

function OverviewSection({ agent }: { agent: AgentWithMeta }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('Name')} value={agent.name} />
      {agent.title && <Field label={t('Title')} value={agent.title} />}
      {agent.description && <Field label={t('Description')} value={agent.description} />}
      {agent.instructions && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-tertiary">{t('Instructions')}</span>
          <p className="whitespace-pre-wrap text-sm text-text-primary">{agent.instructions}</p>
        </div>
      )}
      <Field label={t('Mode')} value={agent.mode || '—'} />
      <Field label={t('Work mode')} value={agent.workMode || 'loam'} />

      <button
        type="button"
        onClick={() => setAdvancedOpen((prev) => !prev)}
        aria-expanded={advancedOpen}
        className="flex items-center justify-between rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-fill-hover"
      >
        {t('Advanced')}
        <ChevronRight className={`size-4 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
      </button>

      {advancedOpen && (
        <div className="flex flex-col gap-4">
          <Field label={t('Model')} value={agent.model || t('Default')} />
          <Field label={t('Effort')} value={agent.effort ? agent.effort.toUpperCase() : '—'} />
          <AllowedServicesBlock agent={agent} />
          <MemorySection agentId={agent.id} />
          <ScratchpadSection agentId={agent.id} />
          <ApprovalRulesSection agentId={agent.id} />
        </div>
      )}
    </div>
  );
}

function AllowedServicesBlock({ agent }: { agent: AgentWithMeta }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-tertiary">{t('Allowed services')}</span>
      {agent.allowedServices && agent.allowedServices.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {agent.allowedServices.map((svc) => (
            <li key={svc} className="rounded-control bg-fill-tsp px-2 py-1 text-xs text-text-secondary">{svc}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-secondary">{t('All services')}</p>
      )}
    </div>
  );
}

function MemorySection({ agentId }: { agentId: string }) {
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    getAgentMemory(agentId)
      .then((entries) => {
        if (mounted) setMemory(entries);
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-text-tertiary">{t('Memory')}</span>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner className="size-4" /> {t('Loading')}
        </div>
      ) : error ? (
        <p className="text-xs text-function-error">{error}</p>
      ) : memory.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('No memory entries yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {memory.slice(0, 20).map((entry) => (
            <li key={entry.id} className="rounded-card border border-border-main bg-bg-main p-2">
              <p className="text-sm text-text-primary">{entry.text}</p>
              <p className="mt-1 text-[11px] text-text-tertiary">
                {entry.kind} · {entry.source}
                {entry.at && ` · ${new Date(entry.at).toLocaleString()}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** MF4 option 14: saved approval rules ("always allow") for this agent, with remove. */
function ApprovalRulesSection({ agentId }: { agentId: string }) {
  const [rules, setRules] = useState<ApprovalRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRules(await listApprovalRules(agentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    listApprovalRules(agentId)
      .then((rows) => {
        if (mounted) setRules(rows);
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  const handleRemove = async (id: string) => {
    setRemovingIds((prev) => new Set(prev).add(id));
    try {
      await removeApprovalRule(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-text-tertiary">{t('Approval rules')}</span>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner className="size-4" /> {t('Loading')}
        </div>
      ) : error ? (
        <p className="text-xs text-function-error">{error}</p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('No approval rules yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-2 rounded-card border border-border-main bg-bg-main p-2">
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                  rule.decision === 'allow' ? 'bg-function-success-tsp text-function-success' : 'bg-function-error-tsp text-function-error'
                }`}
              >
                {rule.decision === 'allow' ? t('Always allow') : t('Deny')}
              </span>
              <div className="min-w-0 flex-1">
                <code className="block truncate text-xs text-text-primary">{rule.tool}</code>
                <p className="text-[11px] text-text-tertiary">
                  {rule.agentId ? t('This agent') : t('Global')}
                  {rule.pattern && ` · ${rule.pattern}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(rule.id)}
                disabled={removingIds.has(rule.id)}
                className="rounded-control p-1 text-text-tertiary hover:bg-fill-hover hover:text-text-primary disabled:opacity-50"
                aria-label={t('Remove')}
                title={t('Remove')}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-tertiary">{label}</span>
      <p className="text-sm text-text-primary">{value}</p>
    </div>
  );
}

function ChannelsTab({ agentId }: { agentId: string }) {
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [bindings, setBindings] = useState<ChannelBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [statusList, bindingList] = await Promise.all([
          listChannelStatus(),
          listChannelBindings(agentId).catch(() => [] as ChannelBinding[]),
        ]);
        if (mounted) {
          setChannels(statusList);
          setBindings(bindingList);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (mounted) setError(message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [agentId]);

  const bind = async (channel: ChannelStatus['name']) => {
    const chatId = (chatIds[channel] ?? '').trim();
    if (!chatId) return;
    setBusy(true);
    try {
      const binding = await bindChannel(agentId, channel, chatId);
      setBindings((prev) => [...prev, binding]);
      setChatIds((prev) => ({ ...prev, [channel]: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (bindingId: string) => {
    setBusy(true);
    try {
      await unbindChannel(agentId, bindingId);
      setBindings((prev) => prev.filter((b) => b.id !== bindingId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <Spinner className="size-4" /> {t('Loading')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="flex items-center gap-1 text-xs text-function-error">
          <AlertCircle className="size-3.5" /> {t('Failed to load channels')} {error}
        </p>
      )}
      {(['telegram', 'email'] as const).map((name) => {
        const status = channels.find((c) => c.name === name);
        const bound = bindings.filter((b) => b.channel === name);
        return (
          <div key={name} className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-main p-3">
            <div className="flex items-center gap-2">
              {name === 'telegram' ? <Send className="size-4 text-text-secondary" /> : <Mail className="size-4 text-text-secondary" />}
              <span className="text-sm font-medium text-text-primary">{t(name === 'telegram' ? 'Telegram' : 'Email')}</span>
              <span
                className={[
                  'ms-auto rounded-control px-2 py-0.5 text-[11px]',
                  status?.configured ? 'bg-fill-tsp text-text-secondary' : 'bg-fill-tsp text-text-tertiary',
                ].join(' ')}
              >
                {status ? (status.configured ? t('Configured') : t('Not configured')) : t('Not configured')}
              </span>
            </div>
            {status && !status.configured && (
              <p className="text-[11px] text-text-tertiary">
                {status.hint || t('Not configured - set {var}', { var: status.envVarNames.join(', ') })}
              </p>
            )}
            {bound.length === 0 ? (
              <p className="text-xs text-text-tertiary">{t('No chats bound yet.')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {bound.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 rounded-control bg-fill-tsp px-2 py-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{b.chatId}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void unbind(b.id)}
                      className="h-row-sm w-row-sm px-0"
                      aria-label={t('Remove binding')}
                      title={t('Remove binding')}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <input
                value={chatIds[name] ?? ''}
                onChange={(e) => setChatIds((prev) => ({ ...prev, [name]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void bind(name);
                }}
                placeholder={name === 'telegram' ? t('Chat id') : t('Email address')}
                className="h-row-sm min-w-0 flex-1 rounded-control border border-border-main bg-bg-menu px-2 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
              />
              <Button type="button" variant="secondary" size="sm" disabled={busy || !(chatIds[name] ?? '').trim()} onClick={() => void bind(name)}>
                {t('Bind')}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ScratchpadSection({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<ScratchpadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listScratchpad(agentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    listScratchpad(agentId)
      .then((rows) => {
        if (mounted) setItems(rows);
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  const handleAdd = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await addScratchpadItem(agentId, trimmed);
      setText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const handleComplete = async (id: string) => {
    setCompletingIds((prev) => new Set(prev).add(id));
    try {
      await completeScratchpadItem(agentId, id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCompletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-text-tertiary">{t('To-do')}</span>
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
          placeholder={t('Add to-do')}
          className="min-w-0 flex-1 rounded-control border border-border-main bg-bg-main px-2 py-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-text-primary"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={adding}
          disabled={adding || !text.trim()}
          onClick={() => void handleAdd()}
          aria-label={t('Add')}
          title={t('Add')}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner className="size-4" /> {t('Loading')}
        </div>
      ) : error ? (
        <p className="text-xs text-function-error">{t('Failed to load to-do')} {error}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('No to-do items yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 rounded-card border border-border-main bg-bg-main p-2">
              <input
                type="checkbox"
                checked={item.status === 'done'}
                disabled={completingIds.has(item.id) || item.status === 'done'}
                onChange={() => void handleComplete(item.id)}
                aria-label={t('Mark as done')}
                title={t('Mark as done')}
                className="mt-0.5 size-4 shrink-0 accent-text-primary"
              />
              <div className="min-w-0 flex-1">
                <p className={`text-sm text-text-primary ${item.status === 'done' ? 'line-through text-text-tertiary' : ''}`}>{item.text}</p>
                <p className="text-[11px] text-text-tertiary">
                  {item.status === 'done' ? t('Done') : t('Open to-do')} · {new Date(item.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutinesTab({ agentId }: { agentId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setSchedules(await listSchedules(agentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    listSchedules(agentId)
      .then((rows) => {
        if (mounted) setSchedules(rows);
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  const handleRunNow = async (id: string) => {
    setRunningIds((prev) => new Set(prev).add(id));
    try {
      await runScheduleNow(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-text-secondary">
        <Loader2 className="size-5 animate-spin" /> {t('Loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-function-error">
        <AlertCircle className="size-5" />
        <p className="text-sm">{t('Failed to load routines')}</p>
        <p className="text-center text-xs">{error}</p>
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <WatchesSection agentId={agentId} />
        <p className="text-sm text-text-tertiary">{t('No routines for this agent.')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <WatchesSection agentId={agentId} />
      <div className="flex flex-col gap-2">
        <p className="text-[11px] text-text-tertiary">{t('Scheduled routines')}</p>
        {schedules.map((s) => (
        <div key={s.id} className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-main p-3">
          <p className="text-sm font-medium text-text-primary">{s.prompt.slice(0, 120)}{s.prompt.length > 120 ? '…' : ''}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
            <span className={`rounded-full px-2 py-0.5 ${s.enabled ? 'bg-function-success-tsp text-function-success' : 'bg-fill-tsp text-text-tertiary'}`}>
              {s.enabled ? t('Enabled') : t('Disabled')}
            </span>
            <span>{cadenceLabel(s)}</span>
          </div>
          {(s.cron || s.runAt) && s.timezone && (
            <p className="text-[11px] text-text-tertiary">{t('Time zone: {tz}', { tz: s.timezone })}</p>
          )}
          {s.nextRunAt && (
            <p className="text-[11px] text-text-tertiary">{t('Next run')} · {formatDateTime(s.nextRunAt)}</p>
          )}
          {s.lastRunAt && (
            <p className="text-[11px] text-text-tertiary">{t('Last run')} · {formatDateTime(s.lastRunAt)}</p>
          )}
          {statusLabel(s) && (
            <p className={`text-[11px] ${s.lastStatus === 'ok' ? 'text-text-tertiary' : 'text-function-error'}`}>{statusLabel(s)}</p>
          )}
          {s.lastStatus === 'failed' && s.lastError && (
            <p className="text-[11px] text-function-error">{s.lastError}</p>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={runningIds.has(s.id)}
            disabled={runningIds.has(s.id)}
            onClick={() => handleRunNow(s.id)}
            className="mt-1 w-full"
          >
            <Play className="size-3.5" />
            {t('Run now')}
          </Button>
        </div>
      ))}
      </div>
    </div>
  );
}

interface WatchesState {
  watches: UrlWatch[];
  loading: boolean;
}

function WatchesSection({ agentId }: { agentId: string }) {
  const [state, setState] = useState<WatchesState>({ watches: [], loading: true });
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('5');
  const [selector, setSelector] = useState('');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    try {
      const watches = await listWatches(agentId);
      setState({ watches, loading: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState((prev) => ({ ...prev, loading: false }));
    }
  };

  useEffect(() => {
    let mounted = true;
    listWatches(agentId)
      .then((watches) => {
        if (mounted) setState({ watches, loading: false });
      })
      .catch((e: unknown) => {
        if (mounted) {
          setError(e instanceof Error ? e.message : String(e));
          setState({ watches: [], loading: false });
        }
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  const handleAdd = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      await addWatch(agentId, {
        url: url.trim(),
        intervalMinutes: Math.max(5, Math.floor(Number(intervalMinutes) || 5)),
        ...(selector.trim() ? { selector: selector.trim() } : {}),
        prompt: prompt.trim(),
      });
      setUrl('');
      setSelector('');
      setPrompt('');
      setIntervalMinutes('5');
      setShowForm(false);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteWatch(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const inputClass = 'rounded-control border border-border-main bg-bg-main px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark';

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-text-tertiary">{t('URL watches')}</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm((prev) => !prev)}>
          <Plus className="size-3.5" />
          {t('Add watch')}
        </Button>
      </div>
      {error && (
        <p className="text-xs text-function-error">{t('Failed to load watches')} · {error}</p>
      )}
      {showForm && (
        <div className="flex flex-col gap-2 rounded-card border border-border-main bg-bg-main p-3">
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('URL')}
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/news" className={inputClass} />
          </label>
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-text-secondary">
              {t('Interval (minutes)')}
              <input type="number" min={5} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-text-secondary">
              {t('Selector (optional)')}
              <input type="text" value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="#feed" className={inputClass} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('Prompt when content changes')}
            <input type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} className={inputClass} />
          </label>
          {formError && <p className="text-xs text-function-error">{t('Failed to add watch')} · {formError}</p>}
          <Button type="button" variant="secondary" size="sm" loading={submitting} disabled={submitting || !url.trim() || !prompt.trim()} onClick={handleAdd} className="w-full">
            {t('Add watch')}
          </Button>
        </div>
      )}
      {state.loading ? (
        <Loader2 className="size-4 animate-spin text-text-secondary" />
      ) : !error && state.watches.length === 0 ? (
        <p className="text-xs text-text-tertiary">{t('No URL watches yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.watches.map((w) => (
            <li key={w.id} className="flex flex-col gap-1 rounded-card border border-border-main bg-bg-main p-3">
              <p dir="ltr" className="truncate text-xs font-medium text-text-primary">{w.url}</p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-tertiary">
                <span className="rounded-full bg-fill-tsp px-2 py-0.5">{formatInterval(w.intervalMinutes * 60)}</span>
                {w.selector && <span dir="ltr" className="rounded-full bg-fill-tsp px-2 py-0.5">{w.selector}</span>}
                <span>{t('Last checked')} · {w.lastCheckedAt ? formatDateTime(w.lastCheckedAt) : t('Never')}</span>
                <span className={w.lastChangedAt ? 'text-function-success' : ''}>{t('Last changed')} · {w.lastChangedAt ? formatDateTime(w.lastChangedAt) : t('Never')}</span>
              </div>
              <p className="text-[11px] text-text-tertiary">{w.prompt.slice(0, 100)}{w.prompt.length > 100 ? '…' : ''}</p>
              <Button type="button" variant="ghost" size="sm" className="mt-0.5 self-end text-function-error" onClick={() => handleDelete(w.id)}>
                {t('Delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return t('{s}s', { s: seconds });
  if (seconds < 3600) return t('{m}m', { m: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('{h}h', { h: Math.floor(seconds / 3600) });
  return t('{d}d', { d: Math.floor(seconds / 86400) });
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function cadenceLabel(s: Schedule): string {
  if (s.cron) return t('Cron: {cron}', { cron: s.cron });
  if (s.runAt) return t('At {time}', { time: formatDateTime(s.runAt) });
  return formatInterval(s.intervalSeconds);
}

function statusLabel(s: Schedule): string | null {
  if (s.lastStatus === 'ok') return t('Last run ok');
  if (s.lastStatus === 'retrying') return t('Retrying · attempt {n}', { n: s.attempts ?? 1 });
  if (s.lastStatus === 'failed') return t('Failed · attempt {n}', { n: s.attempts ?? 1 });
  return null;
}

function MembersTab({ agentId }: { agentId: string }) {
  return (
    <div className="flex flex-col gap-4">
      <ChildrenSection agentId={agentId} />
      <TeamRunsList />
    </div>
  );
}

/** MF6: the child agents this companion spawned (persistent, reusable). */
function ChildrenSection({ agentId }: { agentId: string }) {
  const [children, setChildren] = useState<ChildAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    listChildren(agentId)
      .then((rows) => {
        if (mounted) setChildren(rows);
      })
      .catch((e: unknown) => {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [agentId]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-text-tertiary">{t('Child agents')}</span>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Spinner className="size-4" /> {t('Loading')}
        </div>
      ) : error ? (
        <p className="text-xs text-function-error">{t('Failed to load children')} {error}</p>
      ) : children.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('No child agents yet.')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {children.map((child) => (
            <li key={child.childId} className="flex items-start gap-2 rounded-card border border-border-main bg-bg-main p-2">
              <AgentAvatar
                name={child.name}
                id={child.childId}
                emoji={child.emoji}
                size={28}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{child.name}</p>
                {child.description && (
                  <p className="truncate text-xs text-text-secondary">{child.description}</p>
                )}
                <p className="text-[11px] text-text-tertiary">
                  {t('Spawn key')}: {child.spawnKey} · {new Date(child.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
