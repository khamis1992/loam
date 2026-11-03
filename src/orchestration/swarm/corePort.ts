/**
 * C11 -> C1/C2/C3/C5 binding. The coding team never imports inner Core files: it talks to
 * the rest of the Core only through this adapter over src/orchestration/public.ts and the
 * Core facade (core.ts). Tests use NOOP_CORE_PORT or test doubles of SwarmCorePort.
 */
import type { Config } from "../../config.js";
import type { OllamaClient } from "../../ollama.js";
import type { WorkerCheckpoint } from "../../agent/checkpoint.js";
import { createOrchestrationCore, type OrchestrationCore } from "../core.js";
import { judgeProgress, loadLatestKeyedCheckpoint, saveKeyedCheckpoint, selectWithCore } from "../public.js";
import type { Span } from "../tracing/tracer.js";
import type { SwarmCorePort, SwarmSpan } from "./types.js";

function isWorkerCheckpoint(v: unknown): v is WorkerCheckpoint {
  const c = v as Partial<WorkerCheckpoint> | undefined;
  return !!c && typeof c === "object" && Array.isArray(c.messages) && typeof c.steps === "number" && typeof c.prompt === "string";
}

export function coreSwarmPort(
  core: OrchestrationCore,
  opts: { progressJudgement: boolean; selectCompetingPatches: boolean; taskId?: string; sessionId?: string },
): SwarmCorePort {
  const spans = new WeakMap<SwarmSpan, Span>();
  return {
    ...(opts.progressJudgement
      ? {
          progress: {
            async judgeProgress(input) {
              const digest = `${input.recentTurns.join("\n---\n")}\n\nBoard:\n${input.boardExcerpt}`.slice(-4000);
              const j = await judgeProgress(core, { goal: input.goal, recentDigest: digest, context: `coding-team worker ${input.workerId}` });
              if (!j) return undefined;
              const why = j.inLoop.value ? j.inLoop.reason : j.progressing.reason;
              return { isInLoop: j.inLoop.value, isProgressBeingMade: j.progressing.value, reason: [why, j.instruction].filter(Boolean).join(" Next: ").slice(0, 600) };
            },
          },
        }
      : {}),
    checkpoints: {
      saveWorker(key, checkpoint, revision) {
        saveKeyedCheckpoint(core, key, checkpoint, revision);
      },
      loadLatestWorker(key) {
        const v = loadLatestKeyedCheckpoint(core, key);
        return isWorkerCheckpoint(v) ? v : undefined;
      },
    },
    ...(opts.selectCompetingPatches
      ? {
          selection: {
            async selectBest(input) {
              const r = await selectWithCore(core, `${input.goal}\nWork label: ${input.label}`, input.candidates.map((c) => ({ id: c.branch, label: c.workerId, ok: true, text: c.evidence, ...(c.diff ? { diff: c.diff } : {}) })), undefined, input.signal);
              return { chosenBranch: r.winnerId, method: r.method, reason: r.reason };
            },
          },
        }
      : {}),
    tracing: {
      startSpan(name, attrs, parent) {
        const p = parent ? spans.get(parent) : undefined;
        const span = core.tracer.startSpan(name, {
          parent: p?.context ?? core.runSpan.context,
          attributes: attrs,
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        });
        const handle: SwarmSpan = {
          traceId: span.context.traceId,
          end(endAttrs, error) {
            if (endAttrs) span.setAttributes(endAttrs);
            span.end(error ? "error" : "ok", error);
          },
        };
        spans.set(handle, span);
        return handle;
      },
    },
  };
}

/** One Core per coding-team run (root span loam.run), as index.ts builds one per orchestrated run. */
export interface SwarmCoreBinding { port: SwarmCorePort; traceId?: string; end(): void }
export type SwarmCoreFactory = (run: { runId: string; taskId: string }) => SwarmCoreBinding;

export function loamSwarmCoreFactory(cfg: Config, ollama: OllamaClient): SwarmCoreFactory {
  return (run) => {
    const core = createOrchestrationCore(cfg, ollama, run.taskId, run.runId);
    const sc = core.cfg.swarm;
    return {
      port: coreSwarmPort(core, { progressJudgement: sc.progressJudgement, selectCompetingPatches: sc.selectCompetingPatches, taskId: run.taskId, sessionId: run.runId }),
      traceId: core.runSpan.context.traceId,
      end: () => core.runSpan.end(),
    };
  };
}

export const NOOP_CORE_FACTORY: SwarmCoreFactory = () => ({ port: {}, end: () => undefined });
