# Control-flow guard modeling — revision 61

The third section-13 increment on the cross-file flow engine (`src/security/source-flow.ts`): **early-return validator guards** now cut flows position-aware, completing the platform's modeling of «فهم أدوات التحقق والتنقية وmiddleware» for the guard style.

## What it does

When the propagator meets `if (!valid…(x) …) return;` or `if (!schema.validate(x)) throw …` — a negated call to a validator-family name (`valid*`, `is*`, `assert*`, `check*`, `ensure*`, `verify*`, `schema.validate`, `validate`) whose then-branch consists **only** of `return`/`throw` statements (an early exit) — every tainted identifier tested by that call is marked guarded from the guard's end position onward. From that point the identifier:

- no longer reaches **sinks** in the same file (call sinks and HTML property writes are filtered by sink position), and
- no longer crosses **file boundaries** (guard-cut identifiers are dropped from cross-file call arguments, so they never seed taint roots in imported modules).

Cuts are counted in `flowScan.guardCuts` (bounded to 1000) and reported in the `source_flow` finding detail alongside the sanitizer counts. A guard that validates but does **not** exit early (e.g. `if (!isValidId(q)) { res.status(400); }` with the flow continuing) does **not** cut — the gate pins this distinction.

## Honest limits

- Position-aware within one file only: a guard in file A does not recognize that file B's exported function was already called after A's guard (that is handled only through the cross-file argument cut above, not by carrying guard state into the target file's other callers).
- Validator matching is by callee name; aliased or custom-named validators are not recognized, and a wrongly implemented guard still cuts (the name asserts validation; the engine does not verify semantics).
- Only the negated-call early-exit shape is modeled; `if (valid(x)) { …sink… } else return` (positive guard wrapping the sink) is not recognized, and neither are `switch`-based or multi-branch ladders.

## Validation

`npm run check:security-flow-guards` builds three real workspaces: an unguarded chain (`req.query.q` → imported `lookup` → `db.query` in another file) reporting one sql_like flow with zero cuts; the identical chain with an early-return `if (!isValidId(q)) return;` reporting **zero** flows with the cut counted; and a weak guard that sets a status without exiting — the flow survives. Two campaign runs (`includeSource`) confirm the guarded workspace emits no `source_flow` findings while the unguarded one does, at review confidence. During development the gate caught a real gap: guards initially filtered only same-file sinks while the cross-file call still seeded the target file — the argument filter now applies the same cut. All 35 `check:security*` gates, typecheck for the touched modules and `check:encoding` pass. Worktree-only; not yet in an installed release.
