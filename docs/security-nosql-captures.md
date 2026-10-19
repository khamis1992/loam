# NoSQL lexical captures — revision 26

The source analyzer now follows stable local filter bindings captured by nested functions and callbacks. It uses TypeScript symbols, preserving parameter and block shadowing. Binding declarations must precede their textual use and belong to an enclosing lexical function/source scope. Local object-property construction remains restricted to standalone assignments in the declaration's block/function, before the sink's source position. It does not infer callback execution order, propagate arguments into arbitrary functions, follow imported bindings, or prove that a function executes.

This closes a common MongoDB callback gap: constructing `filter.title = req.body.title` before `connect(..., () => collection.find(filter))`. Reassigned bindings and deferred mutation in another callback remain outside the supported path. The existing depth/visit bounds and partial-analysis reporting remain in force.

## Precision controls

Blind capture propagation initially changed the unchanged development corpus from 81/158 matches and six unmatched candidates to 92/158 and fourteen. Seven extra Mongoose candidates used callback error objects or numeric count results as query receivers.

A narrow provenance check now recognizes a locally resolved `require('mongoose')` or default import, a `model()` result, selected query calls and `exec()`. For those origins only, error callback parameters, promise rejection parameters and numeric count results are excluded as query receivers. Unknown origins remain candidates; reassignment or direct replacement of modeled methods invalidates the provenance. This is not general receiver typing, whole-program mutation analysis, or a guarantee against monkey-patching through aliases.

The callback convention is documented in [Mongoose 6 query documentation](https://mongoosejs.com/docs/6.x/docs/queries.html): the first callback argument represents an error, while the result type depends on the operation. This historical API documentation fits the pinned corpus; recognition does not certify compatibility with a currently installed Mongoose version. Modern [Mongoose queries](https://mongoosejs.com/docs/queries.html) also describe operation-dependent result types.

Final artifact: `output/verification/security-database-captures.json` — **92/158 reference sink locations matched, 66 missed, seven unmatched candidates**. The denominator and external fixtures are unchanged. Six unmatched locations retain the revision 25 adjudications; the additional `mongodb_bodySafe.js:18` uses `bodyParser.urlencoded({extended:false})`, which the reference treats as safe. Middleware/parser configuration is not modeled by this detector; this candidate remains a documented over-report relative to the reference, without a runtime exploit claim. The seven error/numeric callback candidates were removed without removing reference matches.

This is a development corpus already inspected during implementation, not a held-out benchmark, precision estimate, or independent assessment. Findings remain review confidence and disappearance after source edits remains unverified, not a proven runtime fix.

## Tests

`check-security-source-nosql.ts` exercises 24 filter candidates and 29 controls in JS/TS, plus five known callback-receiver controls and five unknown/mutated receiver candidates in both languages. It covers nested captures, aliases, shadowing, callback mutation, source ordering, evidence hashes, SARIF, persistent/unverified retests, cyclic expansion and wide write budgets. The HTTP/UI fixture uses a captured property-built filter so the service and visible finding exercise the new path.

Passed: source suite, source-coverage suite, server build, source-server HTTP/UI integration and scoped TypeScript verification (`npx tsc -p output/verification/tsconfig-security-captures.json --noEmit`). UI screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-vUPYVf`.

The initial deployment gate failed in `src/scripts/check-mobile-records-build.ts:9`: its ChatResult fixture had `tool_calls` and lacked `toolCalls` and `usage`. A follow-up corrected only those fixture fields to the current contract; its existing destructive-field-change repair test passed, followed by the full project typecheck and a fresh server build. The narrower security typecheck was not used as a substitute for the full-project gate.

## Installed runtime

After the concurrent Loam 0.5.19 installer finished, the guarded security installer deployed revision 26. Verification confirmed Loam 0.5.19, security revision 26, matching installed file hashes, the same profile and all 78 existing tasks. Backup and machine-readable verification: `output/verification/security-runtime-backup-20261018-123151/verification.json`.

Installed-runtime HTTP/UI integration passed with `LOAM_SECURITY_TEST_REPAIRS=1`: the captured property-built NoSQL fixture appeared as a review finding, alongside source coverage, SARIF, authorization matrix/evidence, task isolation and retest persistence. Screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-Il0Ecw`. These are synthetic regression fixtures; they do not substitute for authenticated Nutrio tests or an independent benchmark.
