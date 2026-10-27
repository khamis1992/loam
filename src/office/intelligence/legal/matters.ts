import { randomUUID } from "node:crypto";
import { allEntities, getEntity, putEntity } from "../../../server/sqliteStore.js";
import { loadOfficeArtifact, officeSourceAnchors } from "../artifactIO.js";
import { isRecord, OfficeIntelligenceError, type ArtifactRef, type OfficeScope, type SourceAnchor } from "../contracts.js";
import { findConflictCandidates, normalizeLegalName } from "./qatar.js";

const MATTER_KIND = "office-legal-matters";

export interface MatterParty { name: string; role: string }
export interface MatterDeadline { id: string; title: string; dueAt: string; status: "upcoming" | "completed"; owner?: string }
export interface MatterTask { id: string; title: string; owner?: string; dueAt?: string; status: "open" | "done"; sourceId?: string }
export interface MatterEvent { id: string; at: string; title: string; sourceId?: string }
export interface MatterRecord {
  id: string;
  tenantId: string;
  projectId?: string;
  title: string;
  client: string;
  practiceArea: string;
  summary: string;
  status: "active" | "on-hold" | "closed";
  parties: MatterParty[];
  deadlines: MatterDeadline[];
  tasks: MatterTask[];
  events: MatterEvent[];
  artifacts: ArtifactRef[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function text(value: unknown, name: string, max = 2000, optional = false): string {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) throw new OfficeIntelligenceError(`${name} is invalid`, 422, "invalid_matter");
  return value.trim();
}

function date(value: unknown, name: string): string {
  const parsed = text(value, name, 40);
  if (!Number.isFinite(Date.parse(parsed))) throw new OfficeIntelligenceError(`${name} is not a valid date`, 422, "invalid_matter");
  return parsed;
}

function id(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : randomUUID();
}

function parties(value: unknown): MatterParty[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => {
    if (!isRecord(entry)) throw new OfficeIntelligenceError("invalid matter party", 422, "invalid_matter");
    return { name: text(entry.name, "party.name", 500), role: text(entry.role, "party.role", 200) };
  });
}

function deadlines(value: unknown): MatterDeadline[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).map((entry) => {
    if (!isRecord(entry)) throw new OfficeIntelligenceError("invalid deadline", 422, "invalid_matter");
    return { id: id(entry.id), title: text(entry.title, "deadline.title", 500), dueAt: date(entry.dueAt, "deadline.dueAt"), status: entry.status === "completed" ? "completed" : "upcoming", ...(entry.owner ? { owner: text(entry.owner, "deadline.owner", 200) } : {}) };
  });
}

function tasks(value: unknown): MatterTask[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1000).map((entry) => {
    if (!isRecord(entry)) throw new OfficeIntelligenceError("invalid task", 422, "invalid_matter");
    return { id: id(entry.id), title: text(entry.title, "task.title", 1000), ...(entry.owner ? { owner: text(entry.owner, "task.owner", 200) } : {}), ...(entry.dueAt ? { dueAt: date(entry.dueAt, "task.dueAt") } : {}), status: entry.status === "done" ? "done" : "open", ...(entry.sourceId ? { sourceId: text(entry.sourceId, "task.sourceId", 100) } : {}) };
  });
}

function events(value: unknown): MatterEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2000).map((entry) => {
    if (!isRecord(entry)) throw new OfficeIntelligenceError("invalid event", 422, "invalid_matter");
    return { id: id(entry.id), at: date(entry.at, "event.at"), title: text(entry.title, "event.title", 2000), ...(entry.sourceId ? { sourceId: text(entry.sourceId, "event.sourceId", 100) } : {}) };
  });
}

export function createMatter(input: unknown): MatterRecord {
  if (!isRecord(input)) throw new OfficeIntelligenceError("matter body is required", 422, "invalid_matter");
  const now = new Date().toISOString();
  const matter: MatterRecord = {
    id: `matter_${randomUUID()}`,
    tenantId: text(input.tenantId, "tenantId", 200),
    ...(input.projectId ? { projectId: text(input.projectId, "projectId", 200) } : {}),
    title: text(input.title, "title", 500),
    client: text(input.client, "client", 500),
    practiceArea: text(input.practiceArea, "practiceArea", 200),
    summary: text(input.summary, "summary", 20_000, true),
    status: input.status === "closed" ? "closed" : input.status === "on-hold" ? "on-hold" : "active",
    parties: parties(input.parties),
    deadlines: deadlines(input.deadlines),
    tasks: tasks(input.tasks),
    events: events(input.events),
    artifacts: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  putEntity(MATTER_KIND, matter);
  return matter;
}

export function getMatter(id: string): MatterRecord {
  const matter = getEntity<MatterRecord>(MATTER_KIND, id);
  if (!matter) throw new OfficeIntelligenceError("matter not found", 404, "matter_not_found");
  return matter;
}

export function listMatters(scope: OfficeScope): MatterRecord[] {
  return allEntities<MatterRecord>(MATTER_KIND).filter((matter) => matter.tenantId === scope.tenantId && (!scope.projectId || matter.projectId === scope.projectId) && (!scope.matterId || matter.id === scope.matterId));
}

export function updateMatter(idValue: string, expectedRevision: number, patch: unknown): MatterRecord {
  const matter = getMatter(idValue);
  if (matter.revision !== expectedRevision || !Number.isSafeInteger(expectedRevision)) throw new OfficeIntelligenceError("matter revision conflict", 409, "revision_conflict");
  if (!isRecord(patch)) throw new OfficeIntelligenceError("matter patch is required", 422, "invalid_matter");
  const next: MatterRecord = {
    ...matter,
    ...(patch.title !== undefined ? { title: text(patch.title, "title", 500) } : {}),
    ...(patch.summary !== undefined ? { summary: text(patch.summary, "summary", 20_000, true) } : {}),
    ...(patch.status !== undefined ? { status: patch.status === "closed" ? "closed" : patch.status === "on-hold" ? "on-hold" : "active" } : {}),
    ...(patch.parties !== undefined ? { parties: parties(patch.parties) } : {}),
    ...(patch.deadlines !== undefined ? { deadlines: deadlines(patch.deadlines) } : {}),
    ...(patch.tasks !== undefined ? { tasks: tasks(patch.tasks) } : {}),
    ...(patch.events !== undefined ? { events: events(patch.events) } : {}),
    revision: matter.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  putEntity(MATTER_KIND, next);
  return next;
}

export function attachMatterArtifact(idValue: string, ref: ArtifactRef, expectedRevision: number): MatterRecord {
  const matter = getMatter(idValue);
  if (matter.tenantId !== ref.tenantId) throw new OfficeIntelligenceError("artifact and matter tenants must match", 403, "scope_denied");
  if (matter.artifacts.some((item) => item.taskId === ref.taskId && item.path === ref.path)) throw new OfficeIntelligenceError("artifact is already attached", 409, "artifact_already_attached");
  const next: MatterRecord = { ...matter, artifacts: [...matter.artifacts, ref], revision: matter.revision + 1, updatedAt: new Date().toISOString() };
  if (matter.revision !== expectedRevision) throw new OfficeIntelligenceError("matter revision conflict", 409, "revision_conflict");
  putEntity(MATTER_KIND, next);
  return next;
}

export function checkMatterConflicts(matterId: string): ReturnType<typeof findConflictCandidates> {
  const matter = getMatter(matterId);
  const incoming = [matter.client, ...matter.parties.map((party) => party.name)];
  const existing = listMatters({ tenantId: matter.tenantId }).filter((candidate) => candidate.id !== matter.id)
    .map((candidate) => ({ matterId: candidate.id, client: candidate.client, parties: candidate.parties.map((party) => party.name) }));
  return findConflictCandidates(incoming, existing);
}

export function matterDashboard(matterId: string, now = new Date()): { openTasks: number; overdueDeadlines: MatterDeadline[]; upcomingDeadlines: MatterDeadline[]; artifacts: number; events: number } {
  const matter = getMatter(matterId);
  const pending = matter.deadlines.filter((deadline) => deadline.status !== "completed");
  return {
    openTasks: matter.tasks.filter((task) => task.status === "open").length,
    overdueDeadlines: pending.filter((deadline) => Date.parse(deadline.dueAt) < now.getTime()),
    upcomingDeadlines: pending.filter((deadline) => Date.parse(deadline.dueAt) >= now.getTime()).sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
    artifacts: matter.artifacts.length,
    events: matter.events.length,
  };
}

export async function searchMatterArchive(
  scope: OfficeScope,
  query: string,
  resolveWorkspace: (taskId: string) => string,
): Promise<{ results: Array<{ matterId: string; source: SourceAnchor; score: number }>; staleArtifacts: string[] }> {
  const terms = [...new Set(normalizeLegalName(query).split(" ").filter((term) => term.length >= 2))];
  const results: Array<{ matterId: string; source: SourceAnchor; score: number }> = [];
  const staleArtifacts: string[] = [];
  for (const matter of listMatters(scope)) {
    for (const ref of matter.artifacts) {
      try {
        const loaded = await loadOfficeArtifact(resolveWorkspace(ref.taskId), ref);
        for (const source of officeSourceAnchors(loaded)) {
          const textValue = normalizeLegalName(source.excerpt);
          const score = terms.reduce((total, term) => total + (textValue.includes(term) ? 1 : 0), 0);
          if (terms.length && score) results.push({ matterId: matter.id, source, score });
        }
      } catch {
        staleArtifacts.push(`${ref.taskId}/${ref.path}`);
      }
    }
  }
  return { results: results.sort((a, b) => b.score - a.score).slice(0, 100), staleArtifacts };
}
