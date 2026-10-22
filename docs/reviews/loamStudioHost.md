# Frontier review — `src/tools/loamStudioHost.ts` (Loam Studio Host)

Date: 2026-10-22. Scope: the studio-host registry/command proxy and its HTTP
layer `src/server/routes/studioHost.ts`. Clean-room module (see NOTICE header);
no ArtCraft code reused.

## Summary

The module is a small, well-shaped in-process registry that lists embedded
studio engines and proxies `{id, params}` commands to them. Its public contract
and error envelope are sensible. It had **no production hardening**: a single
misbehaving engine could throw through the list/command path, truncation could
split a Unicode surrogate pair, the route could emit an unhandled rejection on a
circular payload, and registration accepted any object. All of those are fixed
below with focused unit tests.

## Findings and fixes

### Fixed in this change

1. **Unguarded engine calls (correctness/robustness).**
   `describeStudio`, `listStudios`, and `runStudioCommand` called
   `engine.enabled()` and `engine.commands()` directly. An engine that throws (or
   returns a malformed catalog) propagated a rejection out of `runStudioCommand`
   and out of `listStudios`, so the route's `await` rejected and the client got
   no JSON envelope — violating the module's own failure policy. Fixed with
   `readGate()` / `readCommands()` guards: a throwing gate is reported as
   disabled with a safe reason; a throwing/non-array catalog yields an empty
   catalog. Resolver throws are contained too.

2. **Catalog validation.** `describeStudio` mapped `engine.commands()` entries
   blindly, so a `null` entry or a non-string `id` crashed the list. Now
   invalid entries, duplicate ids, and the virtual `list_commands` id are
   dropped, and missing titles default to the id. Introspection can no longer
   shadow the host-owned virtual command.

3. **Surrogate-pair truncation.** `safeReason` used `String.prototype.slice`,
   which can cut a surrogate pair in half and produce `U+FFFD`. Replaced with
   code-point truncation (`truncateCodePoints`) plus control-character
   sanitisation (`oneLine`). Covered by a test using an emoji repeated 300x.

4. **`engine.run` result not validated.** A run returning `undefined`, `null`,
   or a non-object produced a confusing result. Now non-conforming results map
   to `{ ok:false, kind:"engine_error", error:"command failed" }`, and thrown
   non-`Error` values are stringified safely.

5. **Unvalidated registration.** `registerStudioEngine` accepted any value and
   stored it. It now validates the minimal engine shape and throws a clear
   `TypeError` for a bad registration (runtime callers/JS).

6. **`command` body not null-safe.** `runStudioCommand` indexed `command.id`
   without checking; a `null`/`undefined` body threw a `TypeError`. Now returns
   `bad_request`.

7. **Route: unserializable payload / unhandled rejection.**
   `sendJson` used raw `JSON.stringify`; a circular or `BigInt` `data` value
   threw, escaping the async handler. `safeStringify` now falls back to an
   `{ ok:false }` envelope. A top-level `try/catch` converts any unexpected
   error into a 500 envelope instead of a hung socket.

8. **Route: request lifecycle + method metadata.** `readJson` now settles once
   and rejects on `aborted`; `405` responses include `Allow: POST`.

### Not fixed here (documented, needs a decision)

9. **Route is not mounted.** `handleStudioHostRoutes` is imported only by its
   test; `src/server/http.ts` never dispatches it, so `GET /api/studio` (no
   `taskId`) currently falls through to the legacy artifact handler and returns
   400. This matches the `designStudio.ts` "supervisor adds one import + one
   dispatch line" pattern, so it is intentional sequencing (CR2 launcher
   pending). **Caution before mounting:** `src/scripts/check-studio.ts` and
   `src/scripts/check-studio-http.ts` both assert
   `(await fetch(base + "/api/studio")).status === 400`. Mounting the route will
   flip that to 200, so those checks must be updated in the same change.

10. **Payload contract mismatch with the web launcher.** The route returns
    `{ studios: [{ app, title, description, available, reason, commands }] }`,
    but `packages/web/src/components/studio/studioTools.ts` `pickStudioTools`
    expects `{ tools: [{ kind, id?, name?, subtitle?, prompt?, mode? }] }`. With
    no `tools` key the client returns `null` and silently falls back to
    `STATIC_STUDIO_TOOLS`. When the route is mounted, add a `tools` projection
    (map `app → kind`/`mode`) so the launcher receives live availability instead
    of the static list. This was left out to keep the change focused and to
    avoid guessing the final launcher contract.

11. **No production engines registered.** `registerStudioEngine` has no
    non-test callers, so the registry is always empty. The host is
    infrastructure awaiting the V1–V4 / O1–O4 studio engines. The API is ready
    for them; nothing else to do here.

## Tests

- New: `src/tools/__tests__/loamStudioHost.test.ts` (14 cases) covering
  registration validation, gate/catalog throw containment, resolver throw
  containment, catalog filtering, surrogate-pair-safe truncation, null command
  body, malformed run results, thrown non-Error values, async engines, and
  params defaulting.
- Existing: `src/server/__tests__/studioHost.test.ts` (12 cases) — unchanged and
  still green.
- Run: `node --import tsx --test src/tools/__tests__/loamStudioHost.test.ts`
  (and the existing route test). No `package.json` script was added to avoid a
  merge conflict with parallel workers.

## Gates

- `npx tsc --noEmit` → 0 errors.
- `npm run build:server` → exit 0.
- `cd packages/web && npx tsc --noEmit` → 0 errors;
  `npx vitest run src/components/studio/studioTools.test.ts` → 4 passed.
