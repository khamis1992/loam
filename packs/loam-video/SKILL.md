# Loam Video

Use real media and the existing EDL/FFmpeg pipeline. Import and inspect first; never treat PPTX as a playable video. Read the timeline before editing and preserve user revisions with `expectedRevision`.

`vexport` returns a job id. Poll its status or cancel it; a cancelled export leaves the editable project intact. Publication is host-only through `video_present` after duration, size and hook/middle/end review frames pass.

`vtranscribe` requires `LOAM_STT_URL`; no Whisper runtime is bundled. `vgenerate` requires an optional `VideoProvider` and returns `provider_not_configured` when absent. Do not open WebGL merely to import, inspect, render or export.
