# Loam Slides

Create editable PowerPoint decks through the existing Loam Studio and Office exporter.

1. Call `deck_init` once with the full outline. If a project already exists, use `deck_attach`; never initialize a second project.
2. Author each slide with `deck_author`. Use real copy and real task assets, concise sections, and deliberate RTL/LTR hierarchy.
3. Review every slide with `deck_review`. A pending, authored, or invalid slide cannot be presented.
4. Use `deck_organize` for structural edits; affected slides return to pending and must be reviewed again.
5. Export with `deck_export` in `pptx` mode, then call `finish`. The host runs `deck_present`; do not claim completion before it succeeds.

Only PPTX is supported. HTML returns `mode_not_supported`; image-slide generation returns `provider_not_configured` until a real provider and renderer are configured.
