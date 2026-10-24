/**
 * Loam Video guidance injected into agent prompts.
 *
 * The prose mirrors the §6.12 "Video editing" section of the master prompt asset
 * (`prompts/loam-master.md`), which is the human-editable source of truth. This
 * module exists so the guidance can be sent to runs that do not carry the whole
 * master prompt (and so it can be unit-tested in isolation), and so the
 * engine-routing tables live in one place next to the router that implements
 * them (`src/tools/videoStudioRouter.ts`).
 *
 * Branding contract (docs/filmcraft-integration.md, docs/effectcraft-integration.md):
 * the user-facing names are exactly "Loam Video" and "Loam Effects". The upstream
 * project names never appear here, in the UI, or in a tool description. Internal
 * ids (filmcraft, effectcraft) stay internal.
 */

/** Tool name whose presence should trigger the Loam Video guidance. */
export const VIDEO_STUDIO_TOOL_NAME = "video_studio";

/** The one product the user sees, and the hidden engine behind it. */
export const VIDEO_PRODUCT_NAME = "Loam Video";
export const EFFECTS_ENGINE_NAME = "Loam Effects";
export const TIMELINE_ENGINE_NAME = "the Loam Video timeline engine";

/**
 * Operations the timeline engine owns. These are the plain, always-available
 * edits; when an operation is not in this list and matches an effects phrase,
 * it belongs to the effects engine.
 */
export const FILM_OPERATIONS: readonly string[] = [
  "cut",
  "trim",
  "split",
  "delete",
  "move",
  "reorder",
  "speed",
  "audio",
  "music",
  "volume",
  "static (plain) text",
  "a basic dissolve/fade",
];

/**
 * Operations only the effects engine can do in full: transitions beyond a basic
 * dissolve, visual effects, colour looks, text/motion animation and keyframed
 * motion. The router degrades each of these to a timeline-engine basic command
 * when the effects engine is unavailable.
 */
export const EFFECTS_OPERATIONS: readonly string[] = [
  "transitions beyond a basic dissolve (wipes, zooms, glitches, spins, morphs)",
  "visual effects",
  "colour looks and grading",
  "text/motion animation",
  "keyframed motion",
  "animated titles",
];

/** `video_studio` actions, in the order the tool documents them. */
export const VIDEO_STUDIO_ACTIONS: readonly string[] = [
  "open",
  "state",
  "import",
  "cut",
  "trim",
  "delete",
  "move",
  "reorder",
  "split",
  "speed",
  "add_text",
  "add_audio",
  "music",
  "transition_basic",
  "effect_basic",
  "undo",
  "raw",
];

/** The five-step workflow §6.12 teaches, for the guidance block. */
export const VIDEO_EDITING_LOOP: readonly string[] = [
  "open — confirm the panel and bridge are alive and read the engine's real command catalog",
  "state — read the current sequences, tracks, clips and playhead before every mutating action",
  "incremental edits — one or a few actions at a time; never write media bytes with file_write",
  "verify — re-read state (and the panel screenshot for a visual change); a command that returned ok is not proof of the edit",
  "export — raw {command: \"export\"} (or the panel button) so the render lands in the task's files, then artifact_publish it as kind video",
];

/**
 * Guidance appended to the system prompt when a run can call `video_studio`.
 * Kept in sync with §6.12 of `prompts/loam-master.md`.
 */
export const VIDEO_EDITING_PROMPT: string = [
  `Loam Video: the user sees ONE product, Loam Video — a live editor in the Workspace panel. Behind it sit two engines, ${TIMELINE_ENGINE_NAME} and the ${EFFECTS_ENGINE_NAME} engine, and video_studio is the only agent tool that drives either. A video attached in chat opens the panel automatically, so the user edits the same timeline by hand while you work; never assume the project on disk (or your last read) is the current state.`,
  `Loop: (1) open; (2) state before every mutating action so manual panel edits are never lost; (3) apply the edit as one or a few incremental actions (cut, trim, delete, move, reorder, split, speed, add_text, add_audio / music, transition_basic, effect_basic, undo) and import media with import, never with file_write; (4) re-read state (and the panel screenshot when the result is visual) and confirm the edit is on the timeline — a command that returned ok is not proof of the edit; (5) finish with raw {command: "export"} (or tell the user to use the panel's export button) so the rendered file lands in the task's files, then artifact_publish it as kind video.`,
  `Route each operation, do not guess an engine. ${TIMELINE_ENGINE_NAME} owns ${FILM_OPERATIONS.join(", ")}. ${EFFECTS_ENGINE_NAME} owns ${EFFECTS_OPERATIONS.join(", ")}. video_studio does this for you: read the routing object in every result (route = the engine that owns the operation, target = the engine that actually ran it, degraded + reason when an effects request was downgraded) and never present a degraded edit as the full effect the user asked for.`,
  "Degrade, do not fail. When the effects engine is unavailable, an effects request is applied with the timeline engine's own basic command (transition_basic / effect_basic) and the result says so. State the limitation plainly in the user's language and keep going; do not retry the same richer operation, and do not silently claim the full effect was applied.",
  "Never invent a command id. Mutating actions resolve their real command ids from the owning engine's live catalog at runtime; raw executes any command id you name, but only after validating it against that catalog. If a build lacks a needed command, the tool answers with the ids it looked for, the closest catalog ids and the available list — read them and retry with raw, do not guess.",
  `Reply in the user's language (Arabic for an Arabic request, including any titles or captions you add with add_text, using the user's own wording). Never mention an internal engine id or an upstream project name in the UI, prompts or tool descriptions; the user sees only ${VIDEO_PRODUCT_NAME} and ${EFFECTS_ENGINE_NAME}.`,
].join("\n");

/** True when a run's tool list can drive the Loam Video editors. */
export function hasVideoStudioTool(toolNames: readonly string[]): boolean {
  return toolNames.includes(VIDEO_STUDIO_TOOL_NAME);
}
