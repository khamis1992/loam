# RE Core (ALL_SERVICES §14)

Status: integrated (Revision 45).

## What runs today (first-party, offline, never executes the subject)

- `src/re/types.ts` — `ReEvidence` (id `ev_` + sha256 of kind/artifact/note — the REA
  convention), `ReFinding` (a normalize `RawFinding` with engine `re` + evidence chain),
  `RebuildVerify`.
- `src/re/binary.ts` — magic identification (PE incl. e_lfanew/PE\0\0 + machine→arch,
  ELF class/machine, Mach-O fat/ Thin magics, APK/JAR/zip central-directory sniffing,
  Java class, PDF), Shannon entropy over a 1 MiB window with a packing signal (>7.2),
  printable strings with a suspicious-string pass (remote URLs by TLD family, shell
  payloads, classic injection imports). 64 MiB analysis cap.
- `src/re/rebuildVerify.ts` — reconstruction fidelity (reagent/dx-ball technique, rebuilt):
  JS token-stream Dice similarity (whitespace/minifier differences don't count;
  match >95 / partial >60 / mismatch), byte 8-gram shingle similarity otherwise.
  sha256-bound evidence id per verdict.

## Tools (`src/tools/reTools.ts`, registered; build mode via the `RE` group)

- `re_analyze` — the offline pass above; states rea-agents availability honestly
  (`npx -y rea-agents@6.7.0 --version` probe) and skips the deep pass when absent.
- `re_decompile` — engine-backed only; refuses with install guidance when no engine is
  present (Loam never bundles engines — GPL/NOASSERTION rule for ImHex/x64dbg, and
  rea-agents stays a pinned external).
- `re_rebuild_verify` — verdict + match% + evidence id.

The existing `reverse-engineer` mode alias resolves to build, whose tool list now
carries the `RE` group; `check:modes` green.

## Verification

`node --import tsx --test src/security/__tests__/re1.test.ts` — 5 tests: identity table
(PE/ELF/Mach-O/APK/unknown), analyze pass (evidence chain + strings finding), rebuild
fidelity bands, tool wiring (offline analyze + honest degradation + missing-file
refusal), content-bound evidence ids.

## Deferred

rea-agents deep pass integration surface confirmation on a real install (U-ALL-5 —
the wrapper is version-pinned and degrades until then), wakaru-style JS un-bundling,
Ghidra/x64dbg bridge manifests (user-installed), ASAR graph analysis.
