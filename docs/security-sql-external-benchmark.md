# External-source SQL detector measurement — revision 22

## Corpus and reproducibility

The complete `javascript/ql/test/query-tests/Security/CWE-089/untyped` directory from [github/codeql](https://github.com/github/codeql/tree/ff3231c5ac4779befd8c8690bb04f447fc6a8d13/javascript/ql/test/query-tests/Security/CWE-089/untyped) is pinned at commit `ff3231c5ac4779befd8c8690bb04f447fc6a8d13`. Local files, upstream expected output, per-file SHA256 manifest and MIT/BSD notices are in `output/verification/codeql-sql-corpus`. Source is parsed as data only; none of these samples is executed.

Run `npx tsx src/scripts/benchmark-security-sql.ts output/verification/codeql-sql-corpus output/verification/security-sql-benchmark.json`. The runner rejects modified corpus bytes, validates expected-file presence, and includes every unique sink range in the upstream `#select` table. Other tables are dataflow edges/nodes, not separate alerts. The reference contains 158 unique sink ranges across 31 JS/TS files.

Matching compares an upstream sink's range with a call expression starting on a Loam candidate's line. This accommodates multi-line query objects. It is a location-overlap metric, not proof of the same dataflow reasoning. Multiple calls on one line can be ambiguous. No CodeQL executable was run and no comparative speed, precision or production recall claim is made. The corpus includes NoSQL, LDAP, GraphQL, cloud SDKs and inter-file flows beyond Loam's SQL-string detector. Those cases remain in the denominator.

## Measured result

| Version | Reference sink matches | Missed reference sinks | Unmatched Loam candidates |
| --- | ---: | ---: | ---: |
| 21, before changes | 7 / 158 | 151 | 0 |
| 22 | 32 / 158 | 126 | 2 |
| 23, raw-format review | 36 / 158 | 122 | 2 |

Reports: `output/verification/security-sql-baseline-r21.json` and `output/verification/security-sql-expanded-r22.json`. They retain every missed sink location, file analysis status and unmatched candidate line. The two unmatched candidates are `hana.js:93` and `hana.js:94`, dynamic SQL in a request callback without an upstream alert label; their absence from expected output does not alone establish false positives or additional confirmed vulnerabilities.

Revision-23 report: `output/verification/security-sql-expanded-r23.json`. Real pg-promise 12.7.1 formatter validation distinguishes `${id:raw}` from `${id}:raw`; some upstream sample comments use the latter spelling. All upstream expected ranges remain unchanged, but these labels must not be interpreted as runtime ground truth for current raw formatting. See `security-pg-raw-format.md`.

This is an external-source development corpus, not a held-out benchmark or independent audit. The implementation was changed after examining misses, so post-change scores measure improvement on known samples. A separate holdout, negative ground truth and real-project validation remain necessary. No frontier-level conclusion is supported by these counts.

## Implemented gap closure

Single-declaration local `var`/`let` string initializers now propagate like `const` when the symbol has no syntactic writes anywhere in the file. Assignment, compound assignment, increment/decrement, destructuring and for-in/of writes prevent propagation. Symbol-based checks respect shadowing and catch writes in nested functions. This is conservative: even an assignment after the query excludes propagation. Dynamic evaluation and full control-flow semantics are not modeled.

Supported method names now also include `get`, `all`, `run`, `each`, `exec`, `prepare`, and pg-promise's `any`, `many`, `manyOrNone`, `map`, `multi`, `multiResult`, `none`, `one`, `oneOrNone`, `result`. Except for existing explicit-unsafe APIs, candidates still require dynamic text and an SQL prefix. Driver identity is not resolved: custom methods may produce review candidates. Parameterized constant strings remain controls. Raw pg-promise formatting modifiers are still a known gap.

Primary API references: [SQLite API](https://github.com/TryGhost/node-sqlite3/wiki/API), [pg-promise Database API](https://vitaly-t.github.io/pg-promise/Database.html). These document SQL-text and bound-parameter arguments; they do not validate this detector.

Regression coverage: 17 dynamic candidates and 32 controls, including closure writes, destructuring, loop writes, shadowing, static bound queries and non-SQL methods. Source coverage limits and retest semantics remain tested. The UI fixture now uses `var` plus `db.any`, exercising the new path through persisted findings and SARIF.

Typecheck, source-coverage regression, server build and source-server UI integration passed. Source-server screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-cmOy3W`. Revision 22 installed on Loam 0.5.16 preserving 66 tasks and the profile; backup `output/verification/security-runtime-backup-20261018-115451`.

Installed-runtime integration also passed with source fixtures enabled, including the new `var`/`any` finding, source limits, SARIF, account matrix, task isolation and retest persistence. Screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-ssxozX`.
