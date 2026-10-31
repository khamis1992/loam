'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, MonitorOff } from 'lucide-react';
import type { ChatEvent, PlanUpdateEvent, ToolUsedEvent } from '@shared/socket';
import { t } from '@/i18n/t';
import { getApiBase, getApiHeaders } from '@/services/rpc';
import { humanizeToolName } from '@/components/chat/toolLabels';

/** H1 (docs/UI_GAP_ANALYSIS §4): persistent progress dock shown while a task
 *  runs and the computer panel is closed. Loam-original implementation of the
 *  generic pattern: live thumbnail (≤2s lag) + current tool label + step
 *  counter; click or Enter opens the computer panel on the matching tab. */
interface ComputerDockProps {
  sessionId: string;
  taskId: string | null;
  events: ChatEvent[];
  onOpen: (event: ToolUsedEvent) => void;
}

export function ComputerDock({ sessionId, taskId, events, onOpen }: ComputerDockProps) {
  const toolEvents = useMemo(
    () => events.filter((e): e is ToolUsedEvent => e.type === 'toolUsed'),
    [events],
  );
  const lastTool = toolEvents.at(-1) ?? null;
  const plan = useMemo(
    () => [...events].reverse().find((e): e is PlanUpdateEvent => e.type === 'planUpdate') ?? null,
    [events],
  );

  // Step counter: within the plan when one exists (active step / total),
  // otherwise the number of tool steps executed so far.
  const activeIndex = plan ? plan.tasks.findIndex((task) => task.status !== 'done') : -1;
  const stepN = activeIndex >= 0 ? activeIndex + 1 : toolEvents.length;
  const stepNTotal = plan ? plan.tasks.length : null;
  const stepLabel = stepNTotal
    ? t('Step {n} of {total}', { n: stepN, total: stepNTotal })
    : t('Step {n}', { n: Math.max(stepN, 1) });

  if (!lastTool) return null;
  return (
    <div
      data-testid="computer-dock"
      role="button"
      tabIndex={0}
      aria-label={t('Open computer panel')}
      onClick={() => onOpen(lastTool)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(lastTool);
        }
      }}
      className="mb-2 flex h-dock cursor-pointer items-center gap-3 rounded-card border border-border-main bg-bg-menu px-3 shadow-card transition-colors duration-fast hover:bg-fill-hover"
    >
      <DockThumbnail sessionId={sessionId} taskId={taskId} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="status-active-dot shrink-0" aria-hidden />
          <span className="truncate text-sm text-text-primary" dir="auto">
            {humanizeToolName(lastTool.tool)}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-text-tertiary">{stepLabel}</div>
      </div>
      <Maximize2 className="size-4 shrink-0 text-text-tertiary" aria-hidden />
    </div>
  );
}

/** Live thumbnail polled from the same frame endpoint LiveView falls back to.
 *  Crossfades between frames via a stacked pair; the enter animation is
 *  disabled under prefers-reduced-motion (globals.css). */
function DockThumbnail({ sessionId, taskId }: { sessionId: string; taskId: string | null }) {
  const apiBase = useMemo(() => getApiBase(), []);
  const [layers, setLayers] = useState<{ id: number; src: string }[]>([]);
  const idRef = useRef(0);
  const lastDataRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const keyFor = taskId || sessionId;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ taskId: keyFor, source: 'screen' });
        const res = await fetch(`${apiBase}/api/live-view/frame?${params}`, { headers: await getApiHeaders() });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { frame?: { data: string | null; mediaType: string } | null };
        const frame = body.frame;
        if (!frame?.data || cancelled) return;
        if (frame.data === lastDataRef.current) return; // unchanged frame — skip
        lastDataRef.current = frame.data;
        const src = `data:${frame.mediaType};base64,${frame.data}`;
        idRef.current += 1;
        const next = { id: idRef.current, src };
        setLayers((prev) => [prev.at(-1)!, next].filter(Boolean)); // keep [old, new]
      } catch {
        /* keep polling; offline state shows through */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiBase, sessionId, taskId]);

  return (
    <div
      className="relative h-dock-thumb w-dock-thumb shrink-0 overflow-hidden rounded-control bg-bg-nav"
      data-testid="computer-dock-thumb"
    >
      {layers.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center text-text-tertiary" aria-hidden>
          <MonitorOff className="size-4" />
        </div>
      ) : (
        layers.map((layer, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- inline base64 frame, not a remote asset
          <img
            key={layer.id}
            src={layer.src}
            alt=""
            className={
              i === layers.length - 1
                ? 'dock-thumb-in absolute inset-0 h-full w-full object-cover' // new frame fades in…
                : 'absolute inset-0 h-full w-full object-cover' // …over the previous one
            }
          />
        ))
      )}
    </div>
  );
}
