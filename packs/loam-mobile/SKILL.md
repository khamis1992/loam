---
name: loam-mobile
description: Build and verify a screen-based Loam mobile app without claiming a native package.
---

# Loam Mobile

1. Create or edit the app with the existing `loam_mobile` tool and preserve `expectedRevision`.
2. Keep primary sections and detail pages linked with valid navigation targets.
3. Inputs, toggles and collections must be real interactive state, not static text pretending to be data.
4. Finish with `mobile_present` only after the current mobile project validates. It exports the actual `mobile.json` and never claims an APK, Expo build or signed store package.
