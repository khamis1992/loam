import type { MemoryRecord, RecallConfig } from "./types.js";
import type { RecallRepo } from "./repo.js";

const DAY = 24 * 60 * 60 * 1000;

export function utilityOf(memory: MemoryRecord): number {
  return memory.prominence * Math.log(2 + memory.confirmations);
}

export function recomputeProminence(memory: MemoryRecord, config: RecallConfig, now: number, coreLinked: boolean): number {
  const rate = memory.decayRate ?? config.decay.kindDailyRate[memory.kind] ?? 0.99;
  const ageDays = Math.max(0, (now - memory.documentAt) / DAY);
  const age = Math.pow(rate, ageDays);
  const confFreq = Math.min(1, memory.confirmations / 5);
  const sinceTouch = Math.max(0, (now - (memory.updatedAt || memory.documentAt)) / DAY);
  const confRecency = Math.exp(-sinceTouch / 30);
  const weights = config.decay.weights;
  let score = weights.age * age
    + weights.confFreq * confFreq
    + weights.confRecency * confRecency
    + weights.importance * (memory.importance / 10)
    + weights.confidence * memory.confidence;
  if (coreLinked || config.decay.floorKinds.includes(memory.kind)) score = Math.max(config.decay.floor, score);
  return Math.min(1, Math.max(0, score));
}

export function applyDecay(repo: RecallRepo, config: RecallConfig, now: number): { updated: number } {
  const rows = repo.latest(undefined, ["active", "dormant", "archived", "superseded"]);
  let updated = 0;
  for (const memory of rows) {
    const prominence = recomputeProminence(memory, config, now, false);
    let state = memory.state;
    if (state !== "superseded" && state !== "trashed") {
      if (prominence >= 0.5) state = "active";
      else if (prominence >= 0.1) state = "dormant";
      else state = memory.state === "archived" ? "archived" : "dormant";
    }
    if (prominence !== memory.prominence || state !== memory.state) {
      repo.update({ ...memory, prominence, state, updatedAt: now });
      updated += 1;
    }
  }
  return { updated };
}

export function applyForgetting(repo: RecallRepo, config: RecallConfig, now: number): { archived: number; trashed: number; deleted: number } {
  const rows = repo.latest(undefined, ["active", "dormant", "archived", "superseded"]);
  let archived = 0;
  let trashed = 0;
  let deleted = 0;
  for (const memory of rows) {
    if (memory.pinned) continue;
    const ageDays = (now - memory.documentAt) / DAY;
    const utility = utilityOf(memory);
    if (memory.state !== "archived" && memory.state !== "trashed" && memory.state !== "superseded"
      && utility < config.forget.utilityThreshold && ageDays >= config.forget.minAgeDays) {
      repo.update({ ...memory, state: "archived", updatedAt: now });
      repo.event(memory.id, "archive", { utility });
      archived += 1;
      continue;
    }
    if ((memory.state === "archived" || memory.state === "superseded") && memory.prominence < config.forget.hardDeleteBelow) {
      repo.update({ ...memory, state: "trashed", trashedAt: now, updatedAt: now });
      repo.event(memory.id, "trash");
      trashed += 1;
      continue;
    }
  }
  for (const memory of repo.byState(["trashed"])) {
    if (memory.trashedAt && now - memory.trashedAt >= config.forget.trashDays * DAY) {
      repo.hardDelete(memory.id);
      deleted += 1;
    }
  }
  return { archived, trashed, deleted };
}
