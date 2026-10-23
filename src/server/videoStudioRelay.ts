/**
 * Loam Video Studio relay: backward-compatible facade.
 *
 * The Video Studio relay was generalised into the shared workspace relay
 * (cr-04, see `src/server/workspaceRelay.ts`), which now also carries the Craft
 * app targets (docs/sheets/slides/photo/design). This module keeps the fc-02
 * import path and names alive so existing Video Studio code, tests and tooling
 * keep working unchanged.
 *
 * Commands for the `film` / `effects` targets still publish the legacy
 * `video_studio_command` event type, so the Loam Video panel does not need any
 * change; only the Craft apps use the new `workspace_command` event.
 */
export {
  WorkspaceRelay as VideoStudioRelay,
  WorkspaceRelayError as VideoStudioRelayError,
  videoStudioRelay,
  workspaceRelay,
  isCraftTarget,
  type VideoStudioCommand,
  type VideoStudioRelayErrorCode,
  type VideoStudioRelayOptions,
  type VideoStudioResult,
  type VideoStudioTarget,
  type CraftRelayTarget,
  type WorkspaceRelayCommand,
  type WorkspaceRelayErrorCode,
  type WorkspaceRelayOptions,
  type WorkspaceRelayResult,
  type WorkspaceRelayTarget,
} from "./workspaceRelay.js";
