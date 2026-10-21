/**
 * NOTICE: Behavioral design credit — this service host mirrors the *idea* of an
 * embedded studio registry described in docs/handoff/ARTCRAFT_ANALYSIS.md §7
 * (S-SERVICES): a small in-process host that lists available studio apps and
 * proxies a `{id, params}` command to one engine, where engines self-describe
 * their commands and expose an `enabled()` gate with a safe human-readable
 * reason. ArtCraft itself is an MIT/Apache Rust project; NO code, schema, route
 * table, or brand asset was copied. This file is an original clean-room
 * TypeScript implementation written only from that behavioral description.
 *
 * Loam Studio Host — a minimal registry of embedded studio engines
 * (video / doc / sheet / slides / design).
 *
 * Engines are plain objects registered at boot (or injected via a resolver for
 * tests and per-request overrides). The HTTP layer (src/server/routes/studioHost.ts)
 * asks this module to:
 *   - list registered studios with their availability (`listStudioEngines`), and
 *   - run a self-describing command (`runStudioCommand`), including the virtual
 *     `list_commands` id that returns an engine's command catalog.
 *
 * Failure policy: protocol problems (unknown app, malformed body) surface as
 * HTTP-level errors; engine-level problems (disabled gate, unsupported command,
 * engine crash) surface as `{ ok: false }` bodies so callers always receive a
 * JSON envelope instead of a thrown stack.
 */

/** Studio apps known to the host. Engines register under exactly one of these. */
export const STUDIO_APPS = ["video", "doc", "sheet", "slides", "design"] as const;
export type StudioApp = (typeof STUDIO_APPS)[number];

export function isStudioApp(value: unknown): value is StudioApp {
  return typeof value === "string" && (STUDIO_APPS as readonly string[]).includes(value);
}

/** Virtual command id handled by the host itself — never passed to an engine. */
export const LIST_COMMANDS_ID = "list_commands";

/** Self-describing parameter spec for one command argument. */
export interface StudioParamSpec {
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  description?: string;
}

/** Self-describing command catalog entry returned by engines. */
export interface StudioCommandSpec {
  id: string;
  title: string;
  description?: string;
  params?: Record<string, StudioParamSpec>;
}

/** Availability gate result. `reason` must be display-safe (no secrets/stacks). */
export interface StudioGate {
  enabled: boolean;
  reason?: string;
}

/** What an engine's `run` returns. */
export type StudioRunOutput =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

/** One embedded studio engine. */
export interface StudioEngine {
  app: StudioApp;
  title: string;
  description?: string;
  /** Safe availability check; called on every list + before every command run. */
  enabled(): StudioGate;
  /** Self-describing command list (must not include LIST_COMMANDS_ID). */
  commands(): StudioCommandSpec[];
  /** Executes one declared command. Called only when `enabled()` allows it. */
  run(commandId: string, params: Record<string, unknown>): StudioRunOutput | Promise<StudioRunOutput>;
}

/** How the HTTP layer resolves an engine for one app (injectable for tests). */
export type StudioEngineResolver = (app: string) => StudioEngine | undefined;

/** JSON payload for GET /api/studio entries. */
export interface StudioDescriptor {
  app: StudioApp;
  title: string;
  description?: string;
  available: boolean;
  reason?: string;
  /** Declared command ids (introspection is allowed even when unavailable). */
  commands: string[];
}

const registry = new Map<StudioApp, StudioEngine>();

export function registerStudioEngine(engine: StudioEngine): void {
  registry.set(engine.app, engine);
}

export function unregisterStudioEngine(app: StudioApp): boolean {
  return registry.delete(app);
}

export function clearStudioEngines(): void {
  registry.clear();
}

export function getRegisteredStudioEngine(app: string): StudioEngine | undefined {
  return isStudioApp(app) ? registry.get(app) : undefined;
}

/** Default resolver used when the HTTP context injects none. */
export const registryResolver: StudioEngineResolver = getRegisteredStudioEngine;

const MAX_REASON_LENGTH = 240;

/** Truncate + single-line a gate reason so responses stay safe to display. */
function safeReason(reason: string | undefined, engineTitle: string): string {
  const fallback = `${engineTitle} is currently unavailable`;
  const text = typeof reason === "string" && reason.trim() ? reason.trim() : fallback;
  return text.replace(/[\r\n]+/g, " ").slice(0, MAX_REASON_LENGTH);
}

export function describeStudio(engine: StudioEngine): StudioDescriptor {
  const gate = engine.enabled();
  const descriptor: StudioDescriptor = {
    app: engine.app,
    title: engine.title,
    available: gate.enabled,
    commands: engine.commands().map((c) => c.id),
  };
  if (engine.description) descriptor.description = engine.description;
  if (!gate.enabled) descriptor.reason = safeReason(gate.reason, engine.title);
  return descriptor;
}

/** Descriptors for every app a resolver returns an engine for, in STUDIO_APPS order. */
export function listStudios(resolver: StudioEngineResolver = registryResolver): StudioDescriptor[] {
  const studios: StudioDescriptor[] = [];
  for (const app of STUDIO_APPS) {
    const engine = resolver(app);
    if (engine) studios.push(describeStudio(engine));
  }
  return studios;
}

/** Registry-backed convenience for the route layer. */
export function listStudioEngines(): StudioDescriptor[] {
  return listStudios();
}

/** Result envelope of one proxied command; the route maps these to HTTP. */
export type StudioCommandOutcome =
  | { ok: true; kind: "commands"; commands: StudioCommandSpec[] }
  | { ok: true; kind: "result"; data: unknown }
  | { ok: false; kind: "bad_request"; error: string }
  | { ok: false; kind: "unknown_app"; app: string; error: string }
  | { ok: false; kind: "disabled"; error: string; reason: string }
  | { ok: false; kind: "unsupported_command"; error: string; commandId: string }
  | { ok: false; kind: "engine_error"; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Proxy one command to one studio engine.
 * - `id === "list_commands"` returns the engine's self-describing catalog
 *   without consulting the gate (catalogs are static metadata).
 * - any other id requires the gate to pass and the command to be declared.
 */
export async function runStudioCommand(
  app: string,
  command: { id?: unknown; params?: unknown },
  resolver: StudioEngineResolver = registryResolver,
): Promise<StudioCommandOutcome> {
  if (!isStudioApp(app)) {
    return { ok: false, kind: "unknown_app", app, error: `unknown studio app "${app}"` };
  }
  const engine = resolver(app);
  if (!engine) {
    return { ok: false, kind: "unknown_app", app, error: `no studio engine registered for "${app}"` };
  }
  const id = typeof command.id === "string" ? command.id.trim() : "";
  if (!id) {
    return { ok: false, kind: "bad_request", error: "command id is required" };
  }
  const params = command.params === undefined ? {} : command.params;
  if (!isPlainObject(params)) {
    return { ok: false, kind: "bad_request", error: "command params must be a JSON object" };
  }

  if (id === LIST_COMMANDS_ID) {
    return { ok: true, kind: "commands", commands: engine.commands() };
  }

  const gate = engine.enabled();
  if (!gate.enabled) {
    return { ok: false, kind: "disabled", error: "studio_disabled", reason: safeReason(gate.reason, engine.title) };
  }

  if (!engine.commands().some((c) => c.id === id)) {
    return { ok: false, kind: "unsupported_command", error: `command "${id}" is not supported by ${engine.title}`, commandId: id };
  }

  try {
    const output = await engine.run(id, params);
    if (output.ok) return { ok: true, kind: "result", data: output.data ?? null };
    return { ok: false, kind: "engine_error", error: typeof output.error === "string" && output.error ? output.error : "command failed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "engine_error", error: message.slice(0, MAX_REASON_LENGTH) || "command failed" };
  }
}
