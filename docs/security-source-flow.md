# Cross-file data-flow source review — revision 59

Campaign assessments with `includeSource` now run a cross-file data-flow pass (`src/security/source-flow.ts`) after the existing per-file scans — closing the largest documented gap of section 13: tracking data across functions and files through imports and middleware-style request passing.

## What it does

1. **Module graph** — parses every eligible workspace file (TypeScript parser, same conventions as the existing source scans: 200-file limit, 300 KB per file, skip `node_modules`/`dist`/dot-directories, UTF-8 only) and resolves relative `import` / `require` specifiers to files; collects each file's exports and their function parameters (ESM named exports, `module.exports = { fn }` including shorthand, `exports.fn = ...`).
2. **Sources** — request-shaped roots: variables bound from `req/request/ctx/context.query|body|params|headers|cookies`, `location.hash|search|href`, `new URLSearchParams`, plus route/middleware handler parameters named `req|request|ctx` (the whole request object is tainted — this is the middleware hop).
3. **Propagation** — bounded syntactic fixed-point (4 passes per file): assignments, derived variables, template/binary expressions, and calls that pass tainted identifiers as arguments.
4. **Cross-file hops** — when a tainted argument is passed to an imported function, the target file's exported function parameter becomes a taint root there, carrying a hop record (`fn(arg 0) ← origin file:line`). The worklist follows chains up to 4 files deep, deduplicating edges; the reported `source` always stays the original request-shaped entry.
5. **Sinks** — `sql_like` (`.query(...)`), `html_like` (`innerHTML/outerHTML =`, `insertAdjacentHTML`, `document.write`) and `command_like` (`.exec/execSync/spawn(...)`) receiving tainted data; one flow per sink (longest chain wins), capped at 50 reported flows.

## Findings and coverage

Each flow emits a `source_flow` finding (medium; command-like sinks high) at `sinkFile:sinkLine` with the full hop chain in the detail — review confidence, like every static indicator in the platform: a review candidate, not taint proof, and absence of flows proves nothing. Bounded scans (file/flow limits) add a `source_flow_coverage` error keeping the run partial. Results are stored on the assessment as `flowScan` (files scanned, imports resolved, flows, coverage), and section-13 items now have their first real increment: تتبع البيانات عبر الدوال والملفات through الاستيرادات والوسائط.

## Honest limits

- Syntactic approximation over the TypeScript parser — no type checking, no library models, no framework routing semantics; aliased re-exports and dynamic `require(variable)` are not resolved; `__proto__`/getter indirection and class methods are not followed.
- Handler-parameter tainting is name-based (`req|request|ctx`); differently named request objects (destructuring in signatures, adapters) need the variable-based roots to catch them.
- Sink kinds are name-based heuristics (`query/exec/spawn` and HTML property writes); framework-specific sinks (`renderRaw`, `sendFile`, ORM methods) are not recognized yet — the item «فهم أدوات التحقق والتنقية وmiddleware» (validators/sanitizers interrupting flows) remains open: the current propagator does not model sanitizers, so a sanitized value still reports a flow (over-approximation, review-side safe).
- Types/control-flow understanding, additional frameworks and languages, and linking static findings to dynamic evidence (correlating a `source_flow` with a matching dynamic proof on the same route) remain open items of section 13.

## Validation

`npm run check:security-source-flow` builds a real five-file workspace fixture: a routes file importing helpers, `db.js` with an exported function reaching `.query` via string concatenation and another reaching `innerHTML`, `mw.js` middleware receiving the whole `req` and reaching `.exec`, a constants-only control producing no flow, and a deliberately broken file surfaced as a parse error. The gate asserts: cross-file flows with hop chains naming the target parameter and its origin file, the middleware `req` hop reaching the command sink, no false positive on constants, parse-error coverage, bounded deduplication, campaign wiring with review-confidence findings, and workspace-relative targets. All 33 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
