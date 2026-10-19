# Direct file search defect

During ticket repair, the agent invoked `file_search` with a concrete verification report path. The implementation only called `readdirSync`, swallowed the resulting non-directory error, and falsely returned `no matches`. This is a confirmed tool defect, but is not proven to be the sole cause of repair failure.

Added a shared bounded file scanner and explicit file/directory dispatch. Direct files now return matching line numbers; recursive directory limits and exclusion behavior remain unchanged. Missing paths return an error instead of an empty result. The path still goes through the existing workspace containment policy.

Regression test `src/scripts/check-bot-file-search.ts` failed before the fix on a real temporary report containing the search term and passed afterward. It covers direct/directory paths, CRLF line numbers, maxResults, case-insensitive matching, no-match results, glob filtering, missing paths, malformed regex, and outside-workspace rejection. Typecheck passed. The test is included in `check:bot-runtime`.

This source change is not built or installed yet. Do not replace the installed runtime or trial scripts while fixed-build cohort session 15545 runs. Its current task is independent of this pending improvement; do not attribute any cohort results to this fix.

Validation update: full `npm run verify` and `npm run build:server` passed, session 84852 exit 0. Log `output/verification/bot-file-search-verify.log`. Built candidate SHA256 `5AA0E9A81F0EA153098F7039031617866D8815B93CCB0260ABCBCFF2144867FC`. Not installed: cohort 15545 remains active on the prior pinned runtime. Verify the candidate hash again before eventual installation.
