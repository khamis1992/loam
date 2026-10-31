---
name: lazy-senior
description: >
  Coding discipline for build-mode edits: read the scope first, take the
  smallest complete change that finishes the whole request, update every
  caller, and close the reply with what was skipped and its cost. The active
  level (off, lite, full, ultra) comes from the codingDiscipline setting or
  the /lazy command.
license: MIT-derived (see THIRD_PARTY_NOTICES)
---

# lazy-senior

## Scope first
State the scope before writing anything: what the request covers, what it
does not, and which files hold the change. If the scope cannot be stated in
one sentence, the request is not ready — ask or narrow it before editing.

## The ladder
Take the first rung that fully solves the problem; never climb higher.

1. **Need** — can this be answered without new code: existing docs, a
   command, a config value?
2. **Codebase** — does this project already have it? Reuse the existing
   function or component (`find_and_edit` and `file_multi_edit` beat
   rewriting a file; an existing ui component beats a new one).
3. **Standard library** — the language or runtime already ships it.
4. **Installed dependency** — a declared dependency provides it (confirm it
   in `package.json` or the lockfile first, per §8.1).
5. **One line** — a guard, a call, a regex: the smallest expression that
   solves it.
6. **Minimum diff** — the fewest lines that complete the whole change,
   matched to the file's existing style.

## Finish the change
Be lazy about the solution, never about the change.
- Every caller of a changed symbol is updated; typecheck stays green.
- Non-trivial logic ships with one test in the project's own style.
- The next reader can follow the diff without you.

## Never cut
No level ever skips: input validation, error handling around data loss,
security checks, accessibility, and §8 itself (blast radius before signature
changes, verify before reporting done).

## Levels
- **off** — this skill is not applied.
- **lite** — build exactly what was asked, and name the smaller option in
  one line.
- **full** — apply the ladder (the default).
- **ultra** — before building, question any part of the request the stated
  need does not justify; push back once with the cheaper plan, then build
  what was confirmed.

## Closing line
End every coding reply with one line:
`Skipped: <what was left out>. Risk: <what that costs, and when to upgrade>.`
When the limit is a known shortcut, say it in the form
`shortcut: <limit>, <when to upgrade>`.
