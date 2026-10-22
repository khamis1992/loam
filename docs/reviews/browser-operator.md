# Review — `src/tools/browserOperator.ts`

Scope: frontier-quality review and hardening of the `browser_operator` observe → plan →
act → verify loop over the existing local browser session. Behaviour preserved; fixes are
targeted and covered by new regression tests. No public API removed (only one new export,
`operatorSurfaceAllowed`).

## What the module is

`browser_operator` is an always-on tool (`src/server/runTools.ts`) that drives the same
isolated Playwright session as the other `browser_*` tools. The loop is a pure function
(`runBrowserOperatorLoop`) over a small `OperatorSurface`, so it is unit-testable with a
fake page. Planning/parsing helpers (`parseIntent`, `planOperatorAction`, `goalSatisfied`,
`parseObservationTable`) are exported and were already covered by
`src/tools/__tests__/browserOperator.test.ts` (24 tests, all green before this change).

## Findings and fixes

### 1. [HIGH] Policy bypass: inner `browser_*` calls ignored the run allowlist
`runBrowserTool` looked the tool up in the module-level `browserTools` array and called
`run(args, ctx)` directly, bypassing `ToolRegistry` (allowlist + lifecycle hooks). Because
`browser_operator` is merged into *every* run as an always-on tool, a read-only mode
(e.g. `ask`/Explore, whose tool list excludes `browser_*`) could still open, click, type
and submit through the operator — and PreToolUse/approval hooks never ran for the inner
calls. `wideResearch` already guards this with `ctx.allowedTools`
(`resolveChildAllowlist`); the operator did not.

Fix: `runBrowserTool` now refuses any inner tool not present in `ctx.allowedTools` when the
run scope is known (undefined scope stays permissive, matching the fan-out convention), and
the tool's `run` fails fast with a clear message via the new `operatorSurfaceAllowed`
helper. Residual: inner calls still dispatch directly rather than through the run
`ToolRegistry`, so user `PreToolUse`/`PostToolUse` hooks do not wrap them; `browser_*` tools
are not approval-gated, so this is left as a follow-up rather than fixed here.

### 2. [HIGH] Empty / stopword-only payloads verified as satisfied
`parseIntent('type ""')` produced `{ kind: "type", text: "" }`, and `goalSatisfied` then
matched `element.value.includes("") === true` for any element — a false "goal-reached"
without acting. `search for` similarly yielded the bare stopword `"for"`, and
`select ""` / `search ""` produced empty operands.

Fix: new `hasMeaningfulPayload` gate drops empty and stopword-only payloads in
`parseIntent` (they now fall back to `generic`), plus defensive non-empty guards in the
`search`/`type` branches of `goalSatisfied`.

### 3. [HIGH for local use] URL parsing dropped ports and rejected localhost
`URL_RE` did not capture `:port`, so `127.0.0.1:3000` became `https://127.0.0.1/`
(port lost, wrong scheme). `normalizeUrl` rejected any host without a dot, so
`localhost:3000` produced no intent at all. Loam is a local agent whose dev servers,
`preview_serve` output and pentest targets are loopback URLs, so this made the common case
fail.

Fix: `URL_RE` now captures an optional `:port` and a `localhost` form; `normalizeUrl`
accepts localhost / IP / IPv6 literals, preserves the port, keeps the `https` default for
public hosts, and falls back to `http` for loopback/private hosts.

### 4. [MED] Text inputs classified by label, not role
`isTextInput` tested `role + name` against `/textbox|search|combobox|textarea|input/i`, so
a link or button merely *labelled* "Search" was treated as a text field (dangerous when the
element's capability list was unknown and `supports()` is permissive).

Fix: role-first classification via `TEXT_INPUT_ROLES`; names are no longer consulted.

### 5. [MED] Quoted text satisfied click/type/select goals from page copy alone
The quoted-literal short-circuit in `goalSatisfied` fired for any intent once
`requireAction` was set, so a `select "Germany"` or `type "X"` goal could be "verified" by
the operand text appearing anywhere on the page.

Fix: the quoted literal is now only a page-level assertion for `navigate`/`search`/`generic`
intents; `click`/`type`/`select` must be proven by their own branch (acted value / URL
change).

### 6. [LOW] Cancellation not honoured mid-step
The abort signal was only checked at the top of each iteration, so an action could still be
dispatched after cancellation arrived during planning, and a screenshot could be taken
after abort.

Fix: additional abort checks before acting and before the verification observation, and
`finish` skips the screenshot when aborted.

### 7. [LOW] Fragile screenshot path parsing
`/^saved (.+) \(\d+ bytes\)$/` could mis-split a path containing `" ("`. Now anchored on
the trailing byte count: `/^saved\s+(.+?)\s+\(\d+\s+bytes\)\s*$/m`.

### 8. [LOW] Dead/redundant check
The duplicated `if (!text.includes(query))` in the search branch was collapsed into a single
non-empty guarded check.

## Tests

Added a `browser_operator hardening` suite (9 tests) to
`src/tools/__tests__/browserOperator.test.ts`, covering: empty/stopword payloads never
satisfy a goal; no false `goal-reached` for `type ""`; port preservation + http fallback for
loopback/localhost; role-first input classification; allowlist refusal (both the
`operatorSurfaceAllowed` helper and the tool's `run`); quoted operands not satisfying
click/type/select from page text; observation failure → `error` status; and cancellation
during planning dispatching no action.

Run:

```
npm run test:browser-operator
# or: node --import tsx --test src/tools/__tests__/browserOperator.test.ts
```

33 tests pass (24 pre-existing + 9 new).

## Not changed (deliberate)

- No second browser is created; the operator still delegates to `browser.ts`.
- `browser.ts` was not modified (its `roleToOp` still labels `<input type=checkbox>` as
  TYPE_TEXT-capable); the operator's role-first gate plus the `supports()` check keeps that
  harmless in practice, and changing the shared table format was out of scope.
- No UI strings were added, so `packages/web` i18n files are untouched.
