---
name: screen-watch
description: Use when the user asks to watch/monitor the screen for a duration and report frames and change percentage (screen_watch tool).
---

# screen_watch

## When to Use
User asks to monitor/watch the screen for a short duration and report activity (frame count, change %), or you need to verify whether the screen is static or active.

## Procedure
1. Call `screen_watch` with the duration in seconds (e.g. 4 for a 4-second watch). No other setup needed.
2. Read the result fields:
   - frame count + sampling interval (fixed ~1000 ms per frame)
   - average change between frames (%)
   - largest change (%) with its timestamp
   - an attached frame file (`watch_<timestamp>.j…`) = last captured frame
3. Interpretation: 0.00% average and largest change = fully static screen (app idle / waiting for input / nothing running). Any nonzero % = on-screen activity during the window.

## Pitfalls
- A watch of N seconds yields about N−1 frames (4 s → 3 frames @ 1000 ms), not N frames — don't report N as the expected count.
- Change % is measured between consecutive frames only; it says nothing about what happened before the watch started.
- A static result is not a failure — it usually means the target app is finished or waiting for input.

## Verification
Output must include a frame count, average/largest change %, and an attached frame file. If the tool errors, retry once with a shorter duration (e.g. 2 s) before investigating.
