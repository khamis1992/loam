# wakaru

## When to use
Decompile minified JS or unpack webpack/vite/metro bundles inside the workspace.

## Rules
- Binary is fetched on demand and hash-verified before every launch.
- Write outputs only inside the workspace.
- If Defender blocks the exe, tell the user in Arabic: «تعذّر تشغيل wakaru — قد يكون Defender حظره».
