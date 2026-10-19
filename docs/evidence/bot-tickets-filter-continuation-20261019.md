# Prepared follow-up evaluation

src/scripts/check-bot-tickets-filter-continuation.ts adds two filter scenarios to
the exact seven original ticket scenarios. It checks all/open/closed filtering,
invalid/duplicate query rejection, unchanged versions/data and persistence after
process restart. It includes an external API/SQLite probe with three records.

Dry-run contract parsing and TypeScript typecheck passed. This follow-up has NOT
been executed. It requires task_mveumcvtdbf76a7e226c to be done with exactly one
user request and a passing baseline report for that exact task/contract. The
original baseline failed on visual timeout, so the default report cannot authorize
the follow-up. A recovered pass can be supplied explicitly with
--prior-evidence=bot-installed-tickets-fresh-full-gate-1792390885363.json only AFTER
that observer records pass=true. This never overwrites the original failed trial.

Recovery observer 52180 ended with a failed independent-author contract (>4
scenarios); its report cannot authorize this continuation either. The instruction
conflict was fixed and installed as build
8A2C2E6535316FFD484DD1DC90DE7E89D5A20A6833101D72B42564BEB7D988D2.
Current recovery observer 51631 writes
bot-installed-tickets-fresh-full-gate-1792391378865.json. Only a future pass=true
in that exact report can authorize the follow-up via --prior-evidence. This is
recovery across builds, not first-pass success. Do not restart or edit its source.
