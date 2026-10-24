/**
 * QuickJS engine bootstrap.
 *
 * `@jitl/quickjs-singlefile-cjs-release-sync` embeds its engine bytes in the
 * CommonJS module, so no separate `emscripten-module.wasm` file is needed and
 * `build:server` can bundle the whole sandbox into `dist/server.cjs`. The
 * wasmfile variant (`@jitl/quickjs-wasmfile-release-sync`) cannot be used here:
 * its loader derives the wasm path from `import.meta.url`, which esbuild
 * replaces with an empty object when bundling to CJS, so the path resolution
 * throws inside the bundle.
 *
 * Adapted from jcode (MIT) ref/codemode/engine.rs (the engine bootstrap).
 */
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
// The variant package is CommonJS: under NodeNext its default export is typed as
// the module namespace, so the actual variant is unwrapped below.
import singleFileSyncVariantExport from "@jitl/quickjs-singlefile-cjs-release-sync";

/** A standard (sync) QuickJS build variant, as accepted by the core factory. */
type SyncVariant = Extract<Parameters<typeof newVariant>[0], { type: "sync" }>;

/** Unwrap the variant from either interop shape (direct, or `{ default }`). */
function syncVariant(): SyncVariant {
  const shape = singleFileSyncVariantExport as unknown as { type?: string; default?: SyncVariant };
  const variant = shape.type === "sync" ? (shape as unknown as SyncVariant) : shape.default;
  if (!variant || variant.type !== "sync") throw new Error("quickjs sync variant is unavailable");
  return variant;
}

/**
 * Create the QuickJS WASM module. The single-file variant needs no options, but
 * `newVariant` is still used so a variant that requires a wasm path override can
 * be pinned without changing this call site.
 */
export async function createQuickJSModule(): Promise<QuickJSWASMModule> {
  return newQuickJSWASMModuleFromVariant(newVariant(syncVariant(), {}));
}
