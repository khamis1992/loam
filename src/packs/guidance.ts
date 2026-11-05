import type { PackId } from "./types.js";

export function packSystemGuidance(packId: PackId | undefined): string | undefined {
  if (packId === "loam-build") {
    return "Loam Build service pack: call site_init once, then write the requested page directly without reading the whole UI kit or producing oversized source files. Keep App.tsx below 250 lines. Run web_scaffold once after editing with install=true and build=true, use preview_serve, then site_checkpoint and finish. Never call deploy_app; publication is host-only through site_publish_request after user approval. Do not create a Git commit or tag.";
  }
  if (packId === "loam-slides") {
    return "Loam Slides service pack: use deck_init once, deck_author and deck_review for every slide, deck_export in pptx mode, then finish. Use deck_attach after a transport error instead of reinitializing. Every slide must be final before presentation.";
  }
  if (packId === "loam-video") {
    return "Loam Video service pack: inspect real media, read the timeline before editing, preserve expectedRevision, then vexport and poll status. Do not open the visual studio for rendering. Use video_present through finish only after the export is final. Text-to-video and STT must return provider_not_configured when no provider is configured.";
  }
  if (packId === "loam-localfile") {
    return "Loam Local File service pack: bind only exact user-selected paths with local_bind. Use local_write_guarded with the current SHA-256 baseline, preserve backups, and stop on baseline_conflict. Never bypass guarded writes through shell or generic file tools.";
  }
  if (packId === "loam-image") {
    return "Loam Image service pack: use image_generate for real assets. SVG works locally; PNG/JPEG/WebP requires the configured image provider. Use design_brief and the existing creative tools when they improve the result. Return provider_not_configured rather than a placeholder.";
  }
  if (packId === "loam-audio") {
    return "Loam Audio service pack: use tts_generate or music_generate only with a real configured provider. Do not claim bundled Piper, Whisper or Arabic voice support. Return provider_not_configured when unavailable.";
  }
  if (packId === "loam-office") {
    return "Loam Office service pack: use the existing office_craft, loam_studio and office_export tools for the requested document or workbook. Verify the real file before finish; do not route document work to web_scaffold.";
  }
  if (packId === "loam-research") {
    return "Loam Research service pack: use the existing research tools, preserve source citations and write a real report before finish. Do not convert research into a website or presentation unless asked.";
  }
  if (packId === "loam-schedule") {
    return "Loam Schedule service pack: use the existing schedule tools and preserve their approval and recurrence behavior. Report the actual schedule id and next run; do not claim a schedule was created when the tool failed.";
  }
  return undefined;
}
