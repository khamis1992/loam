# Source SQL construction review — revision 23

Revision 23 adds library-specific pg-promise raw-parameter review, including real formatter validation and local driver provenance. See `security-pg-raw-format.md`; static query text with raw placeholders is not treated like ordinary escaped binding. General dynamic-SQL detection below remains a separate heuristic.

Revision 22 supersedes the const-only restriction below: local single-declaration `var` and `let` strings are followed only when no syntactic writes to that symbol occur anywhere in the file. Additional SQLite/pg-promise SQL-text method names are recognized. There is still no receiver-type verification or full taint/control-flow analysis. See `security-sql-external-benchmark.md` for exact support, write controls and the externally sourced 7→32 of 158 measurement. Historical revision notes below describe earlier behavior.

Revision 21 makes expression expansion limits observable. Depth, visit-budget or combined-prefix truncation returns `limit_reached` while retaining any candidates already found. The scanner counts affected files in `sqlLimited`, adds a file-specific generic warning and marks source coverage incomplete. Campaign status is partial, source diagnostics are incomplete, and Markdown/SARIF retain the coverage failure. The UI distinguishes expansion-limited files from syntax errors and fully analyzed files; old reports without the new counter display zero.

Tests exercise deep aliases, repeated expansion and long prefixes, campaign/report propagation and a corrected-fixture retest. The UI test includes a `deep.ts` fixture and asserts both the limited-file count and filename. These are resource bounds, not declarations that arbitrary unsupported data flows are covered.

Revision-21 validation: repository typecheck, SQL/source-coverage regressions, server build and source-server UI/SARIF test passed. Installed on Loam 0.5.16 preserving 64 tasks and the profile; backup `output/verification/security-runtime-backup-20261018-114804`. Source-server screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-rapYOT`.

The installed-runtime integration passed with source fixtures enabled: the UI displayed the expansion-limited file/count, and API/SARIF retained the partial assessment. Other account/evidence/retest/persistence checks also passed. Screenshot directory: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-qVrZBN`.

Revision 20 follows local `const` string initializers and aliases before ordinary query calls, including a local string passed as an inline query object's `text`/`sql` value. The TypeScript symbol binder resolves the actual declaration, preserving parameter, destructuring, catch and block shadowing. Resolution is lazy, single-file and entirely in memory; it does not load imports or library files. The declaration must precede the use and belong to the same enclosing function/source execution scope. It does not follow `let`/`var`, object-property mutations, closures, function returns or imported values. These exclusions remain coverage gaps, not evidence of safety.

Expansion is bounded to depth 32 and 2,048 expression visits per sink, retaining at most 4,096 characters of combined literal prefix. Exhausted expansion is treated as unknown dynamic text; a query prefix may consequently be missed or a static expression may become a review candidate. No source contents enter finding evidence. This is bounded syntactic propagation, not control-flow or whole-program taint analysis.

Validation added four positive cases and nine controls (12/20 total), plus a repeated-alias expansion stress fixture. The source-assessment regression now uses a query built in a variable and checks line/hash, review confidence and retest semantics. The UI/SARIF integration fixture likewise uses a local variable. The pre-change test failed on the new basic local-variable case, confirming the measured coverage gap.

Implementation reference: [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), specifically symbol lookup at an AST identifier. The remediation distinction remains consistent with the OWASP reference below.

The source scan now parses JavaScript/TypeScript syntax to identify selected dynamic SQL construction patterns at calls to `query`, `execute`, `raw`, `$queryRawUnsafe` and `$executeRawUnsafe`. Direct concatenation, template interpolation and `{text: ...}` / `{sql: ...}` arguments are supported. Findings use `source_sql`, include file/line and the scanned source hash, and carry **review** confidence. Query contents are omitted from the new detector's evidence.

Static query strings with separate bound values are not flagged by this rule, including parameterized `$queryRawUnsafe` calls. Comments, example strings, constant-only concatenation and ordinary tagged `$queryRaw` templates do not match. This does not certify that those queries or their callers are secure.

The remediation guidance recommends driver parameter binding for values and explicit allowlists for dynamic identifiers. It does not generate automatic SQL rewrites: placeholder conventions, identifier handling and application semantics require review. Disappearance of a static indicator remains **unverified** in the runtime repair comparison.

Scope and limits: syntactic analysis only, no imported-symbol resolution, interprocedural taint tracking, sanitizer validation, database execution or exploit confirmation. A custom method named `query` can produce a review candidate. Local variable propagation has the explicit revision-20 limits above; explicit unsafe methods still produce review candidates for unknown dynamic arguments. Unsupported languages, malformed source and unrecognized APIs are outside this rule. Existing scan limits remain 200 files and 300 KB per file. No claim of complete SQL injection detection or a full SAST engine.

Validation: `npx tsx src/scripts/check-security-source-sql.ts` covers 12 candidates and 20 controls, line/hash evidence, review confidence, persistence and post-edit retest semantics, plus nested paths, JS/MJS/CJS/TSX and bounded alias expansion. `check:security-http` includes a synthetic SQL fixture, persisted API result and visible finding in the source UI.

References used to check the remediation distinction:
- OWASP SQL Injection Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet
- Prisma raw query documentation: https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/raw-queries

Parameterized values are distinct from table/column identifiers. Prisma's unsafe-named API also supports parameterized use; the detector therefore does not flag the method name alone when the SQL argument is static.

Previous deployment: revision 20 installed on Loam 0.5.16, preserving 61 tasks and the profile. Backup: `output/verification/security-runtime-backup-20261018-114431`. Full repository typecheck, server build, SQL/source-coverage tests and source-server UI/SARIF integration passed. Source-server screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-mldsr9`.

Installed-runtime UI test also passed with the synthetic local-variable SQL source, source coverage and SARIF assertions enabled (`LOAM_SECURITY_TEST_REPAIRS=1`), alongside account matrix, evidence, task isolation and retest/persistence checks. Screenshots: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-F54moM`. This does not add authenticated Nutrio coverage or an independent benchmark.

Historical deployment: revision 15 installed on Loam 0.5.14, preserving 47 tasks and the profile. Backup: `output/verification/security-runtime-backup-20261018-110958`. Its typecheck had an unrelated slide-import error; the current revision-20 typecheck passed.

Installed UI regression also passed with `LOAM_SECURITY_TEST_REPAIRS=1`, exercising the synthetic SQL source fixture, visible finding and review confidence along with account matrix, evidence, retest persistence and reversible HTML repair. Screenshot artifacts: `C:/Users/khamis/AppData/Local/Temp/loam-security-http-LyzIvh`.
