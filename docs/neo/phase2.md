# Phase-2 Capabilities Guide (English)

This guide covers the capabilities that shipped in update 0.5.32 ("bridges complete + reaching the world"). Every feature is described by its actual behavior in this build; where it needs a key from you (BYOK) or a setting, it says so explicitly.

---

Related: [README.md](README.md) · [knowledge-garden.md](knowledge-garden.md) · [missions.md](missions.md)

## Chat with your files (RAG in the conversation)

The Knowledge Garden tools (kb_*) are now available in the **ask** and **build** modes by default — no special mode needed.

- The **"Chat with your files"** button next to the composer filters the current task's files into the Knowledge Garden, then answers from your files only.
- The `task_files_ingest` tool is invoked by the agent automatically and can be requested explicitly.
- To turn it off: General settings → disable `knowledgeRag`.
- The legacy `rag_index`/`rag_query` tools now route to the same Knowledge Garden (the broken external bridge is gone).

## Automatic subtitles (SRT/VTT)

`creative_subtitles {mediaPath}`: speech-to-text through the local STT server, then `.srt` and `.vtt` files written next to the video. Available in the "صمّم" media mode and its starter chip. Requires the local STT server: `npm run stt` (local whisper, no cloud).

## The App Run Engine

- **Build mode**: send an app brief → clarifying questions (a question card) → a plan draft you approve or edit → implementation → verification (check/lint/typecheck/build) → a version snapshot. Every run is recorded in `app_runs` and serialized per project.
- **Goal mode**: a multi-task plan with approval, then sequential execution per task.
- **Race**: parallel branches on differentiated cloud models with different creativity temperatures, then the best branch is chosen and promoted. All routes are live now (no more 501 placeholders).
- Strict rule: build and planning steps are **cloud-only** — no local model for those steps (the run fails with a clear Arabic message when no cloud model is configured).

## Deploy and backend services

- **Real deploy targets**: `deploy_app` with `target: vercel|netlify` really deploys when `VERCEL_TOKEN`/`NETLIFY_AUTH_TOKEN` is in the environment (static only — any page calling same-origin APIs is refused).
- **Stripe with your key**: put your key in the vault (apps scope) or `STRIPE_KEY` in the environment — it reaches the generated app's server automatically and is never logged.
- **SQLite sync**: `__loam/sync/pull|push` endpoints (25MB cap, atomic writes).
- **Store builds**: `npm run eas:build -- --platform android` (requires the eas CLI logged in with your account).

## Images and voice

- **AI image generation**: add `cloudModel.images.model` in config.json (or `LOAM_IMAGE_MODEL`+`LOAM_IMAGE_BASE_URL`+`LOAM_IMAGE_API_KEY`) — any openai-compatible provider with your key.
- **Voice in the chat**: the mic button ("Talk") next to the composer — Arabic speech recognition with live interim text; the speaker toggle auto-speaks replies; speaking over playback stops it (barge-in).

## Loam Remote (from your phone)

Open `http://<machine-address>:<port>/remote` from a phone on the same network (or over Tailscale), paste the token once, then: live task list, outputs, stop/resume. Add it to the home screen as a PWA.

## GitHub dev flow

The **devflow** mode: issue → branch → نتريو swarm → PR → review → CI, plus a security quadrant (remediation scan → fixes → PR). Skill: `skills/dev-flow`.

## The marketplace

The skills page now has a third tab "السوق": a unified grid to install/enable skills, bridges and connectors from one place.

## The update channel

Installed builds check GitHub Releases automatically. To publish: `npm run dist && npm run publish:release` (requires an authenticated gh CLI). Full documentation lives in docs/update-channel.md inside the repository.
