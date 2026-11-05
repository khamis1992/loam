import fs from "node:fs";
import path from "node:path";
import type { PackId, ServicePackManifest } from "./types.js";

type ManifestBase = Omit<ServicePackManifest, "modelTools">;

function define(base: ManifestBase): ServicePackManifest {
  return { ...base, modelTools: [...new Set([...base.ownedTools, ...base.wrappedTools])] };
}

const skill = (id: PackId) => [{ name: id, path: `packs/${id}/SKILL.md` }];

export const PACK_MANIFESTS: Readonly<Record<PackId, ServicePackManifest>> = {
  "loam-slides": define({
    schema: "loam.service-pack/v1", id: "loam-slides", version: "1.0.0", modes: ["slides", "write"], skills: skill("loam-slides"),
    wraps: ["office_craft", "loam_studio", "office_export", "PresentationPipeline", "design_brief"],
    ownedTools: ["deck_init", "deck_author", "deck_review", "deck_organize", "deck_export", "deck_attach", "deck_notes"],
    wrappedTools: ["office_craft", "loam_studio", "office_export", "design_brief", "design_image_generate", "design_create", "loam_canvas"],
    hostTools: ["deck_present"], gate: { tool: "deck_present", timeoutMs: 60_000 }, legacyRoutes: "keep", update: "hot",
  }),
  "loam-localfile": define({
    schema: "loam.service-pack/v1", id: "loam-localfile", version: "1.0.0", modes: ["localfile"], skills: skill("loam-localfile"),
    wraps: ["expectedRevision"], ownedTools: ["local_bind", "local_write_guarded", "local_backup"], wrappedTools: [],
    hostTools: ["local_watch"], gate: { tool: "local_watch", timeoutMs: 30_000 }, legacyRoutes: "keep", update: "hot",
  }),
  "loam-video": define({
    schema: "loam.service-pack/v1", id: "loam-video", version: "1.0.0", modes: ["video", "media"], skills: skill("loam-video"),
    wraps: ["video_studio", "creative_timeline", "video_edit", "ffmpeg-static"],
    ownedTools: ["vproj_manage", "vtimeline_get", "vtimeline_edit", "vmedia_import", "vmedia_inspect", "vtranscribe", "vexport", "vgenerate"],
    wrappedTools: ["video_studio", "video_edit", "creative_timeline", "creative_export", "creative_export_status", "creative_export_result", "creative_subtitles", "office_craft", "loam_canvas"],
    hostTools: ["video_present"], gate: { tool: "video_present", timeoutMs: 120_000 }, legacyRoutes: "keep",
    providers: [{ capability: "video", optional: true }, { capability: "tts", optional: true }], update: "hot",
  }),
  "loam-build": define({
    schema: "loam.service-pack/v1", id: "loam-build", version: "1.0.0", modes: ["websites", "build"], skills: skill("loam-build"),
    wraps: ["web_scaffold", "preview_serve", "deploy_app"],
    ownedTools: ["site_init", "site_attach", "site_checkpoint"],
    wrappedTools: ["web_scaffold", "preview_serve", "preview_status", "preview_stop", "preview_screenshot", "app_task_create", "app_task_finish", "app_context_write", "app_verify", "app_version_note", "app_db_query", "app_add_dependency"],
    hostTools: ["site_publish_request", "site_secrets_request"], gate: { tool: "site_publish_request", timeoutMs: 120_000 }, legacyRoutes: "keep", update: "restart",
  }),
  "loam-image": define({
    schema: "loam.service-pack/v1", id: "loam-image", version: "1.0.0", modes: ["image", "media"], skills: skill("loam-image"),
    wraps: ["imageProvider", "design_image_generate"], ownedTools: ["image_generate"],
    wrappedTools: ["design_brief", "design_image_generate", "design_create", "loam_canvas"],
    hostTools: ["image_present"], gate: { tool: "image_present", timeoutMs: 60_000 }, legacyRoutes: "keep",
    providers: [{ capability: "image", optional: true }], update: "hot",
  }),
  "loam-audio": define({
    schema: "loam.service-pack/v1", id: "loam-audio", version: "1.0.0", modes: ["audio", "media"], skills: skill("loam-audio"),
    wraps: ["gen_music"], ownedTools: ["tts_generate", "music_generate"], wrappedTools: [],
    hostTools: ["audio_present"], gate: { tool: "audio_present", timeoutMs: 60_000 }, legacyRoutes: "keep",
    providers: [{ capability: "tts", optional: true }, { capability: "music", optional: true }], update: "hot",
  }),
  "loam-office": define({
    schema: "loam.service-pack/v1", id: "loam-office", version: "1.0.0", modes: ["document", "spreadsheet", "visualization", "write", "data"], skills: skill("loam-office"),
    wraps: ["office_craft", "loam_studio", "office_export"], ownedTools: [],
    wrappedTools: ["office_craft", "loam_studio", "office_import", "office_export", "office_status", "design_brief", "design_image_generate", "loam_canvas"],
    hostTools: ["office_present"], gate: { tool: "office_present", timeoutMs: 60_000 }, legacyRoutes: "keep", update: "hot",
  }),
  "loam-research": define({
    schema: "loam.service-pack/v1", id: "loam-research", version: "1.0.0", modes: ["research"], skills: skill("loam-research"),
    wraps: ["wide_research", "deep_research"], ownedTools: [], wrappedTools: ["web_search", "web_fetch", "deep_research", "wide_research"],
    hostTools: ["research_present"], gate: { tool: "research_present", timeoutMs: 60_000 }, legacyRoutes: "keep", update: "hot",
  }),
  "loam-schedule": define({
    schema: "loam.service-pack/v1", id: "loam-schedule", version: "1.0.0", modes: ["automate"], skills: skill("loam-schedule"),
    wraps: ["schedule_create", "schedule_update"], ownedTools: [], wrappedTools: ["schedule_create", "schedule_list", "schedule_update", "schedule_delete", "schedule_self_reminder"],
    hostTools: ["schedule_present"], gate: { tool: "schedule_present", timeoutMs: 30_000 }, legacyRoutes: "keep", update: "hot",
  }),
  "loam-mobile": define({
    schema: "loam.service-pack/v1", id: "loam-mobile", version: "1.0.0", modes: ["mobile", "mobile-app"], skills: skill("loam-mobile"),
    wraps: ["loam_mobile"], ownedTools: [], wrappedTools: ["loam_mobile"],
    hostTools: ["mobile_present"], gate: { tool: "mobile_present", timeoutMs: 30_000 }, legacyRoutes: "keep", update: "hot",
  }),
  "loam-game": define({
    schema: "loam.service-pack/v1", id: "loam-game", version: "1.0.0", modes: ["game", "game-dev"], skills: skill("loam-game"),
    wraps: ["file_write", "file_edit", "preview_serve"], ownedTools: [], wrappedTools: ["file_write", "file_edit", "preview_serve"],
    hostTools: ["game_present"], gate: { tool: "game_present", timeoutMs: 30_000 }, legacyRoutes: "keep", update: "hot",
  }),
};

export const PACK_BASE_TOOLS = [
  "think", "finish", "plan", "phase_set", "message", "plan_exit", "suggest_plan", "ask_user", "todo_write",
  "file_read", "file_list", "file_search", "file_stat", "file_write", "file_edit", "file_mkdir",
] as const;

export function validatePackManifest(manifest: ServicePackManifest): void {
  if (manifest.schema !== "loam.service-pack/v1") throw new Error(`unsupported pack schema: ${manifest.schema}`);
  if (!PACK_MANIFESTS[manifest.id]) throw new Error(`unknown pack: ${manifest.id}`);
  if (!manifest.version || manifest.modes.length === 0) throw new Error(`invalid pack manifest: ${manifest.id}`);
  if (!manifest.gate?.tool || !Number.isFinite(manifest.gate.timeoutMs) || manifest.gate.timeoutMs <= 0) throw new Error(`invalid pack gate timeout: ${manifest.id}`);
  if (manifest.ownedTools.includes(manifest.gate.tool)) throw new Error(`pack gate must be host-only: ${manifest.gate.tool}`);
  const host = new Set(manifest.hostTools);
  if (!host.has(manifest.gate.tool)) throw new Error(`pack gate is not declared in hostTools: ${manifest.gate.tool}`);
  const owned = new Set(manifest.ownedTools);
  if (owned.size !== manifest.ownedTools.length) throw new Error(`duplicate owned tools: ${manifest.id}`);
  if (manifest.wrappedTools.some((tool) => owned.has(tool))) throw new Error(`pack owned and wrapped tools overlap: ${manifest.id}`);
  if (manifest.modelTools.some((tool) => host.has(tool))) throw new Error(`pack model and host tools overlap: ${manifest.id}`);
  if (manifest.legacyRoutes !== "keep" && manifest.legacyRoutes !== "retired") throw new Error(`invalid legacyRoutes: ${manifest.id}`);
  for (const entry of manifest.skills) {
    if (!entry.name || !entry.path.startsWith(`packs/${manifest.id}/`)) throw new Error(`invalid pack skill: ${manifest.id}`);
  }
}

const DEFAULT_PACKS_DIR = path.resolve(process.cwd(), "packs");

export function loadPackManifests(root = DEFAULT_PACKS_DIR): ServicePackManifest[] {
  return Object.values(PACK_MANIFESTS).map((base) => {
    const file = path.join(root, base.id, "pack.json");
    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ServicePackManifest>;
    const diskGate = typeof disk.gate === "string" ? { tool: disk.gate } : disk.gate;
    const manifest: ServicePackManifest = {
      ...base,
      ...disk,
      skills: disk.skills ?? base.skills,
      wraps: disk.wraps ?? base.wraps,
      ownedTools: disk.ownedTools ?? base.ownedTools,
      wrappedTools: disk.wrappedTools ?? base.wrappedTools,
      gate: { ...base.gate, ...diskGate },
      modelTools: [...new Set([...(disk.ownedTools ?? base.ownedTools), ...(disk.wrappedTools ?? base.wrappedTools)])],
    };
    validatePackManifest(manifest);
    return manifest;
  });
}

export function getPackManifest(id: PackId): ServicePackManifest {
  const manifest = loadPackManifests().find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`unknown pack: ${id}`);
  return manifest;
}

export function listPackManifests(): ServicePackManifest[] {
  return loadPackManifests();
}

for (const manifest of listPackManifests()) validatePackManifest(manifest);
