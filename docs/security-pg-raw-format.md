# pg-promise raw-format source review — revision 23

The SQL source detector now identifies selected pg-promise raw placeholders (`$1:raw`, `$1^`, and named raw modifiers inside `{}`, `()`, `[]`, `<>`, `//`) whose supplied value is nonconstant. Static SQL text alone no longer causes these calls to be overlooked. Findings retain `source_sql`, file/line and source hashes with review confidence; query and value contents are omitted. No automatic SQL rewrite is offered.

The new branch requires locally resolved pg-promise provenance: an unshadowed CommonJS require or default ES import, an initialization call and a database construction call. It follows non-reassigned variable aliases, including module-level factories referenced by a function. Local require/receiver shadowing and writes exclude this provenance. Unknown initialization options and `pgFormatting:true` are excluded because they may select native pg formatting. The existing general dynamic-SQL heuristic is unchanged.

Supported inputs include second-argument values and inline query objects with `text`/`values`, scalar first parameters, indexed literal arrays and named/nested literal objects. Known constant raw values and ordinary escaped values do not trigger the new rule. Unknown values may be review candidates even when a caller sanitizes them; this is not taint tracking or sanitizer verification. Object aliases, custom formatters, `this:raw`, task/transaction receiver inference, native prepared-query objects, `:value`/`#` quote context, external query files and arbitrary wrapper functions are not fully modeled. No complete driver semantic analysis is claimed.

## Runtime-confirmed syntax distinction

Official [pg-promise documentation](https://github.com/vitaly-t/pg-promise#raw-text) places named filters inside the delimiter. With pg-promise **12.7.1**, a local formatting-only check verifies:

- `${id:raw}` inserts the value without escaping.
- `${id}:raw` escapes the value normally and appends the literal suffix `:raw`.
- `$1` escapes a value; `$1:raw` does not.

Some named-placeholder examples in the pinned CodeQL development corpus use the second spelling. They remain in the original denominator, but their alert labels are not treated as proof that this spelling performs raw interpolation in 12.7.1. The implementation follows observed formatter behavior, not score maximization. This is not a conclusion about every CodeQL version or the full query semantics.

The formatter dependency is pinned in `output/verification/pg-format-runtime`, installed with scripts disabled, and is not an application dependency. No database connection, credentials or target requests are used by this validation.

## Verification

`npx tsx src/scripts/check-security-pg-format.ts output/verification/pg-format-runtime` covers 13 positive cases and 19 controls, repeats the core cases for JavaScript and TypeScript, checks the actual formatter, source findings/hash/redaction and persistent/edited retests. Removing a static indicator stays unverified for runtime remediation.

The unchanged external corpus matches **36/158** sink ranges (revision 22: 32/158), with 122 missed reference locations and two unmatched candidates. Report: `output/verification/security-sql-expanded-r23.json`. This is development-set location overlap, not precision, an independent audit or production recall. See `security-sql-external-benchmark.md` for provenance, licensing and limitations.

Typecheck, SQL/source-coverage regressions, real formatter tests, server build and source-server UI integration passed. Source-server screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-nHogWk`. Revision 23 installed on Loam 0.5.17 preserving 69 tasks and the profile; backup `output/verification/security-runtime-backup-20261018-120250`.

Installed-runtime integration passed, including the visible raw-format review finding, source/SARIF coverage, account matrix, evidence, task isolation and retest persistence. Screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-iE1pyY`.
