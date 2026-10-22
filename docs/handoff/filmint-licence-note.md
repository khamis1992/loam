# Loam Video (vendored filmcraft) - licence note

Date: 2026-10-21 (Asia/Riyadh)

Loam is a PRIVATE, LOCAL, NON-COMMERCIAL project (decision by Khamis). On that
basis the vendored editor engine under `electron/filmcraft/` in the `mf/filmint`
worktree has had its ArtCraft/FilmCraft branding, logos and the bundled licence/
attribution files removed:

- Deleted: electron/filmcraft/LICENSE-MIT, LICENSE-APACHE, NOTICE, ATTRIBUTION.md
- Stripped user-visible "FilmCraft"/"ArtCraft" names and logos from the vendored
  dist (index.html, favicon, UI strings) and the Loam video panel UI, replaced
  with "Loam Video".

## IMPORTANT - restore before any distribution

The upstream engine (github.com/storytold/filmcraft) is licensed **MIT OR
Apache-2.0**, which require preserving the copyright/licence notices when the
software is **distributed**. The pristine upstream clone is kept untouched at:

    C:\Users\khamis\Desktop\mf-wt\rust-film\filmcraft

If Loam (or this video engine) is EVER distributed, shared outside this machine,
or used commercially, you MUST restore the licence and attribution files and the
upstream copyright/NOTICE text before doing so. The originals are in the clone
above (LICENSE-MIT, LICENSE-APACHE, NOTICE, ATTRIBUTION.md) and in upstream git
history. Removing them is only acceptable for a private, non-distributed build.
