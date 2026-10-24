/**
 * Codemode — sandboxed JavaScript that chains harness tools in one turn.
 *
 * Adapted from jcode (MIT) ref/codemode/lib.rs.
 *
 * Codemode lets the model write a short JavaScript program that orchestrates
 * Loam tool calls instead of issuing them one model turn at a time. Intermediate
 * results stay inside the sandbox, so only what the script returns reaches the
 * transcript.
 *
 * The sandbox runs where Loam runs, not where `shell_run` runs. It has no
 * filesystem, network, timer, or process API — `require`, `process`, `fetch`
 * and `setTimeout` are all `undefined` in the script. The only way to affect
 * the outside world is through `tools.<name>(args)`, which is routed by the
 * caller through Loam's normal tool registry and approval/policy path.
 */

export { DEFAULT_CODEMODE_LIMITS, runCodemode, loadQuickJS, decodeToolOutput, truncateResult } from "./engine.js";
export type { CodemodeHost, CodemodeLimits, CodemodeRunOutput, CodemodeToolInfo } from "./engine.js";
export { CODEMODE_MAX_CODE_CHARS, CODEMODE_TOOL, createCodemodeTool, createUnboundCodemodeTool, formatCodemodeResult, resolveCodemodeSettings } from "./tool.js";
export type { CodemodeRegistry, CodemodeSettings, CodemodeToolOptions } from "./tool.js";
export { codemodeTier, createCodemodeGate } from "./policyGate.js";
export type { CodemodeGate, CodemodeGateInput } from "./policyGate.js";
export { createQuickJSModule } from "./wasmLoader.js";
