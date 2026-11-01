---
name: lazy-audit
description: Whole-repo ranked audit, strictly read-only (chat command /audit [path]) — maps entry points and flows, ranks what to fix, and states what was not read.
license: MIT-derived (see this file's license line and THIRD_PARTY_NOTICES)
---

# lazy-audit

## Read-only contract
Nothing is modified: no file writes, no state-changing commands, no external
actions. The run is granted read-only tools; a tool that cannot run without
writing is skipped and reported in the unread list.

## Map first
Map the target's entry points and the flows that connect them (entry points →
call paths → outputs), then read the load-bearing files on those flows.

## Report structure
1. A one-paragraph map of what the target is and how it works.
2. A ranked list of findings — rank by risk × reach, each with evidence
   (file:line), the problem, and the cost of leaving it.
3. The ranked list ends with one line: `fix first: <the single item to fix
   before anything else>`.
4. The unread list: which parts were not read, with the reason (size, time,
   or unavailable dependency).

## Scope
With a path argument, the audit is bounded to that path. Without one, the
audit covers the current task workspace root.