---
name: lazy-review
description: Change review that reads beyond the diff — run after a coding change (chat command /review [target]) to confirm the change holds outside its own files, ordered correct, safe, holds under load, tested, fast, lean.
license: MIT-derived (see THIRD_PARTY_NOTICES)
---

# lazy-review

## Target
Review the named target, or when no target is named: the uncommitted changes
(git_status_diff); if the tree is clean, the last commit.

## Read beyond the diff
For every changed symbol, find its callers in the untouched code (grep or
code_symbols) and read them. A change is not "done" until the untouched
callers still hold.

## Report structure
Findings in this order: correct, safe, holds under load, tested, fast, lean.

Each finding states: what it is, the problem, the fix, and the cost of
skipping the fix. Severity per finding: Must / Should / Nice.

## Close the report
State the load the review assumed, and list what was NOT read (files or
areas skipped, with the reason).