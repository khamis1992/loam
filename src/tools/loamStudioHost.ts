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

/** True when a value has the minimal shape of a studio engine. */
function isEngineShape(value: unknown): value is StudioEngine {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StudioEngine>;
  return (
    isStudioApp(candidate.app) &&
    typeof candidate.title === "string" &&
    typeof candidate.enabled === "function" &&
    typeof candidate.commands === "function" &&
    typeof candidate.run === "function"
  );
}

export function registerStudioEngine(engine: StudioEngine): void {
  if (!isEngineShape(engine)) {
    throw new TypeError(
      `invalid studio engine: expected { app: ${STUDIO_APPS.join("|")}, title, enabled(), commands(), run() }`,
    );
  }
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

/** Collapse control characters and whitespace runs into one display-safe line. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Truncate by Unicode code points so a surrogate pair is never split. */
function truncateCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/** Truncate + single-line a message so responses stay safe to display. */
function safeMessage(text: string | undefined, fallback: string): string {
  const raw = typeof text === "string" && text.trim() ? text : fallback;
  return truncateCodePoints(oneLine(raw), MAX_REASON_LENGTH) || fallback;
}

/** Display-safe engine title (never trusts an injected engine). */
function engineTitle(engine: StudioEngine): string {
  return typeof engine.title === "string" && engine.title.trim() ? engine.title.trim() : "Studio";
}

/**
 * Read an engine's availability gate without letting a misbehaving engine throw.
 * A throw or a malformed gate is reported as disabled with a safe reason.
 */
function readGate(engine: StudioEngine): StudioGate {
  try {
    const gate = engine.enabled();
    if (gate && typeof gate === "object") {
      return {
        enabled: gate.enabled === true,
        reason: typeof gate.reason === "string" ? gate.reason : undefined,
      };
    }
  } catch {
    // fall through to the safe disabled gate
  }
  return { enabled: false, reason: `${engineTitle(engine)} is not responding` };
}

/**
 * Read + validate an engine's command catalog without letting it throw.
 * Invalid entries, duplicate ids, and the virtual LIST_COMMANDS_ID are dropped.
 */
function readCommands(engine: StudioEngine): StudioCommandSpec[] {
  let raw: unknown;
  try {
    raw = engine.commands();
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const specs: StudioCommandSpec[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as {
      id?: unknown;
      title?: unknown;
      description?: unknown;
      params?: unknown;
    };
    if (typeof candidate.id !== "string" || !candidate.id.trim()) continue;
    const id = candidate.id.trim();
    if (id === LIST_COMMANDS_ID || seen.has(id)) continue;
    seen.add(id);
    specs.push({
      id,
      title:
        typeof candidate.title === "string" && candidate.title.trim()
          ? candidate.title.trim()
          : id,
      ...(typeof candidate.description === "string" && candidate.description.trim()
        ? { description: candidate.description.trim() }
        : {}),
      ...(candidate.params && typeof candidate.params === "object" && !Array.isArray(candidate.params)
        ? { params: candidate.params as Record<string, StudioParamSpec> }
        : {}),
    });
  }
  return specs;
}

export function describeStudio(engine: StudioEngine): StudioDescriptor {
  const gate = readGate(engine);
  const title = engineTitle(engine);
  const descriptor: StudioDescriptor = {
    app: engine.app,
    title,
    available: gate.enabled,
    commands: readCommands(engine).map((c) => c.id),
  };
  if (typeof engine.description === "string" && engine.description.trim()) {
    descriptor.description = engine.description.trim();
  }
  if (!gate.enabled) descriptor.reason = safeMessage(gate.reason, `${title} is currently unavailable`);
  return descriptor;
}

/** Descriptors for every app a resolver returns an engine for, in STUDIO_APPS order. */
export function listStudios(resolver: StudioEngineResolver = registryResolver): StudioDescriptor[] {
  const studios: StudioDescriptor[] = [];
  for (const app of STUDIO_APPS) {
    let engine: StudioEngine | undefined;
    try {
      engine = resolver(app);
    } catch {
      continue;
    }
    if (!engine) continue;
    try {
      studios.push(describeStudio(engine));
    } catch {
      // describeStudio is defensive; skip an engine that still misbehaves.
    }
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
 *
 * Every engine touch is guarded: a misbehaving engine yields an `{ ok: false }`
 * envelope instead of a thrown stack, so callers always get JSON.
 */
export async function runStudioCommand(
  app: string,
  command: { id?: unknown; params?: unknown } | null | undefined,
  resolver: StudioEngineResolver = registryResolver,
): Promise<StudioCommandOutcome> {
  if (!isStudioApp(app)) {
    return { ok: false, kind: "unknown_app", app, error: `unknown studio app "${app}"` };
  }

  let engine: StudioEngine | undefined;
  try {
    engine = resolver(app);
  } catch {
    engine = undefined;
  }
  if (!engine) {
    return { ok: false, kind: "unknown_app", app, error: `no studio engine registered for "${app}"` };
  }

  if (!isPlainObject(command)) {
    return { ok: false, kind: "bad_request", error: "command body must be a JSON object" };
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
    return { ok: true, kind: "commands", commands: readCommands(engine) };
  }

  const title = engineTitle(engine);
  const gate = readGate(engine);
  if (!gate.enabled) {
    return {
      ok: false,
      kind: "disabled",
      error: "studio_disabled",
      reason: safeMessage(gate.reason, `${title} is currently unavailable`),
    };
  }

  if (!readCommands(engine).some((c) => c.id === id)) {
    return {
      ok: false,
      kind: "unsupported_command",
      error: `command "${id}" is not supported by ${title}`,
      commandId: id,
    };
  }

  let output: unknown;
  try {
    output = await engine.run(id, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "engine_error", error: safeMessage(message, "command failed") };
  }

  if (output && typeof output === "object" && (output as { ok?: unknown }).ok === true) {
    return { ok: true, kind: "result", data: (output as { data?: unknown }).data ?? null };
  }
  if (output && typeof output === "object" && typeof (output as { error?: unknown }).error === "string") {
    return {
      ok: false,
      kind: "engine_error",
      error: safeMessage((output as { error: string }).error, "command failed"),
    };
  }
  return { ok: false, kind: "engine_error", error: "command failed" };
}
