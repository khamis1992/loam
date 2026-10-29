/**
 * Real static cloud deploys for delivered company runs (BUILD_SPEC §6.7,
 * proposal 5). Invoked ONLY by the user-initiated, origin-checked launch
 * endpoint — never registered as an agent tool — so no model can publish
 * through this module.
 *
 * The provider implementation is shared with the deploy tool path and lives
 * in ./staticDeploy.ts; this module re-exports that exact surface unchanged
 * (launch endpoint, its tests and check scripts keep importing from here).
 * The launch endpoint itself additionally gates on confirm:true and an
 * origin check before calling deployStatic.
 */
export {
  CLOUD_TARGETS,
  MAX_DEPLOY_BYTES,
  MAX_DEPLOY_FILES,
  MAX_FILE_BYTES,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  PROVIDER_TOKEN_ENV,
  SAME_ORIGIN_REFUSAL,
  callsSameOriginApi,
  collectStaticBundle,
  deployStatic,
  deployStaticTo,
  deployToNetlify,
  deployToVercel,
  redactToken,
  safeProjectName,
} from "./staticDeploy.js";
export type {
  CloudDeployOutcome,
  CloudDeployRequest,
  CloudTarget,
  StaticBundle,
  StaticDeployOptions,
  StaticDeployOutcome,
} from "./staticDeploy.js";
