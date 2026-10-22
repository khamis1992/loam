---
name: OpenMontage Nutrio video
description: - Use when making or remaking a Nutrio promo video with OpenMontage (or when the user asks for a short vertical food video for Nutrio TikTok/Instagram prep that should follow the free or paid OpenMontage path).
---

---
name: OpenMontage Nutrio video
description: >-
  Use when making or remaking a Nutrio promo video with OpenMontage (or when the
  user asks for a short vertical food video for Nutrio TikTok/Instagram prep
  that should follow the free or paid OpenMontage path).
---
# OpenMontage Nutrio video

## When
Making a short vertical Nutrio promo with [OpenMontage](https://github.com/calesthio/OpenMontage) installed at `/workspace/tools/OpenMontage` (official `calesthio/OpenMontage` only; never forks or the nonexistent npm package `openmontage`).

## Hard rules (every run)
1. **Meal is the hero.** Food fills the frame. No identifiable faces unless the owner supplies talent and asks for it.
2. **Brand colors:** green `#1BB996`, sky `#40B9FB`, orange `#F36B06`, periwinkle `#6F7FF3`, coral `#FC5D6A`, navy `#0C1222` for text. Navy text on brand-color surfaces and light backgrounds — never white text on green/sky/orange (contrast fails).
3. **Logo:** only `/workspace/brand/ui/logo.png`, as-is. Never recolor, stretch, or distort. End card: logo + `nutrio.me`.
4. **Claims:** no medical/health-cure language, no weight numbers, no paid-ads wording. Check recent social posts for repeated hooks before locking copy.
5. **Arabic:** Gulf-friendly short captions. Render RTL with joined letters (IBM Plex Sans Arabic or another OFL Arabic font). Animate whole phrases, not letter-by-letter. Visually verify frames (no tofu, no reversed punctuation).
6. **TikTok:** prep-only unless the owner explicitly orders upload. Instagram/X publish only under existing social standing orders.
7. **Spend:** default to free path only (Mixkit keyless stock, Pixabay music keyless, local Remotion/ffmpeg; no fal.ai, paid TTS or paid stock keys). Use a paid provider only when the owner explicitly authorizes budget for that run.
8. **Delivery gate:** before handing the file over, review text, formatting, colors, logo identity, and overall quality. Sample frames at hook, mid, reveal, and end card; fix and re-render if anything fails.

## Creative gate (before any production) — mandatory
The owner rejected the format "colored frames/bands/apertures + swapping meal photos + a short word" as uncreative. It must never be the concept again.
1. Write 3–5 genuinely non-traditional concepts first: a story, a surprise or twist, a character or POV (e.g. the fridge, the plate, the delivery bag), a local Gulf/Qatari touch, or unexpected sound. For each: one-line idea, why it stops the scroll in the first 2 s, shot-by-shot script with timing, on-screen Arabic, sound, and whether it is doable free (stock + Remotion) or needs real footage / AI generation.
2. Banned as the core idea: photo carousels, colored frames or cutouts that just swap dishes, dish lists with labels, and any hook already used (وش ناكل اليوم؟ / جوع؟ / اشتراك واحد، مطاعم كثيرة).
3. Present the concepts to the owner, or pick the strongest when production is already ordered, and state why. Design polish never substitutes for an idea.

## Install / preflight (once per machine)
1. `git clone https://github.com/calesthio/OpenMontage.git` → `/workspace/tools/OpenMontage`, then `make setup` (or README no-make fallback). Needs `make`, ffmpeg, Node 18+.
2. Remotion is the default renderer on Node 20. HyperFrames needs Node ≥ 22 — skip unless upgraded.
3. Free Mixkit path may need `beautifulsoup4` in the OpenMontage venv. If Mixkit download fails, re-apply the local scraper fix in `mixkit-local-patch.diff` under `/workspace/nutrio/video/openmontage-test-*/` — do not submit upstream unless asked.
4. Read `AGENT_GUIDE.md` and `PROJECT_CONTEXT.md`. Drive work through a pipeline (`cinematic` works for short promos); write schema-valid checkpoints under `projects/<slug>/`.

## Produce (only after the creative gate)
1. **Brief:** chosen concept, length (default 15 s), 9:16 1080×1920, language, budget, destination (prep-only vs publish).
2. **Copy:** follows the concept's story beats; short, Gulf-friendly, fresh wording.
3. **Assets:** free Mixkit clips (trim out hands/faces); Pixabay royalty-free music; logo as above. Prefer real Nutrio partner dish footage when available — stock is for tests and mocks.
4. **Voice:** skip unless a Gulf-Arabic voice is available and approved. Music-only beats a robotic non-Gulf voice.
5. **Pipeline:** research → proposal → script → scene_plan → assets → edit → compose via OpenMontage stage directors; Remotion atelier for a hand-authored composition.
6. **Render:** H.264 yuv420p + AAC, ~15 s, faststart, loudness about −14 to −12 LUFS.
7. **Output folder:** `/workspace/nutrio/video/openmontage-<slug>-YYYY-MM-DD/` with mp4, sampled PNGs, and `NOTES.md` (concept, sources, licenses, spend, skips, issues).

## Review checklist
- [ ] Concept passed the creative gate (not a colored-frame carousel)
- [ ] ffprobe: duration, 1080×1920, h264+aac
- [ ] Arabic RTL, joined, no wrong-side ellipsis
- [ ] Logo byte-identical / visually unaltered
- [ ] Navy text; no white-on-green/sky/orange
- [ ] No watermarks, medical claims, or faces
- [ ] No blank/flash frames at cuts
- [ ] Spend matches authorization (default $0)
- [ ] Nothing uploaded unless explicitly ordered

## Honest quality note when stock footage is used
Free Mixkit is often 720p landscape upscaled into 9:16, so sharpness lags true 1080p, and stock dishes are not partner restaurants — fine as a test, weaker as a final ad.
