# In-App Browser visibility fix — lifecycle handoff

## Problem

The in-app browser's preview is a **native Electron `WebContentsView`**
(`electron/inAppBrowser.cjs`) overlaid on the shell window. Native child views
ignore CSS stacking, `visibility`, `overflow` and z-index, so once attached the
page kept painting **on top of everything**: the settings dialog closed but
still mounted, modals opened over it, other routes (Studio/Agents/…), even a
minimized/unfocused window — always at the last measured bounds.

## Fix model: visibility = renderer intent AND window factor

Two independent booleans, maintained in `electron/inAppBrowser.cjs`, are ANDed
into an *effective visibility* that is enforced with `WebContentsView.setVisible()`:

| Factor | Meaning | Owner |
| --- | --- | --- |
| `rendererWantsVisible` | the preview surface is mounted AND on screen | renderer pane via IPC `setVisible` (`iabSetVisible`) |
| `windowAllows` | host window focused AND not minimized/hidden | `electron/main.cjs` window events via `inAppBrowser.setWindowAllows()` |

`applyVisibility()` recomputes `attached && rendererWantsVisible && windowAllows`
and calls `view.setVisible(effective)` (guarded against a destroyed view). The
view stays **attached and loaded** whenever it is merely hidden — hiding is
cheap, the page and bounds survive.

## IPC surface changes

- `inAppBrowser.setVisible(v)` (new handler + preload bridge + renderer
  `iabSetVisible`): renderer-declared intent. `true` from the pane means
  “preview is mounted and intersecting the viewport”.
- `inAppBrowser` state now carries `visible: boolean` (effective visibility),
  pushed through the usual `onStateChanged` event.

## Lifecycle

### attach
- Renderer mounts the pane → `iabAttach()` → view created (or reused) and added
  as a child view of the shell window.
- **Every `attach()` starts hidden**: the renderer intent is reset to false and
  `setVisible(false)` applied. The pane then measures bounds and re-asserts
  visibility (`applyVisibility()` → `iabSetVisible(true)` only when on screen).

### bounds
- Pane pushes the window-relative rect (`iabSetBounds`) from
  `getBoundingClientRect()` in CSS pixels. Electron keeps renderer CSS px and
  native view DIP bounds aligned (devicePixelRatio = displayScale × zoomFactor,
  shell zoom always 1), so the rect passes through 1:1; when
  `devicePixelRatio !== 1` the rect is snapped onto the physical-pixel grid
  (round in physical px, back to DIPs) so edges land exactly on the host
  element. Re-measured from:
  - `ResizeObserver` on the preview element **plus the surrounding layout
    containers** (covers sidebar collapse/expand),
  - window `resize` (also fires on OS display-scale/DPI changes),
  - capture-phase `document` `scroll` (dialog scrolls).

### visible → shown
Shown only when **all** renderer-side factors hold (checked in
`InAppBrowserPane.applyVisibility()`):
1. preview intersecting (`IntersectionObserver`, ratio > 0),
2. `document.visibilityState === 'visible'`,
3. host window focused (`window` focus/blur),
4. no top-layer dialog opened **over** the pane (`[role="dialog"]`,
   `[aria-modal="true"]`, `dialog[open]` — excluding dialogs that *contain* the
   preview, i.e. Settings itself) — `MutationObserver` on `document.body`.

Becoming intersecting again re-pushes bounds *before* showing so the view never
repaints at a stale rect.

### hidden (any of these hides immediately, without detaching)
- intersection lost (route change away from the pane, pane scrolled off,
  settings dialog closed while still mounted),
- `visibilitychange` → hidden,
- `window` blur,
- a blocking modal appears,
- **window factor false**: `win` `blur` / `minimize` / `hide` →
  `inAppBrowser.setWindowAllows(false)` (main.cjs),
- `inAppBrowser.hide()` — host-facing force-hide that also clears the renderer
  intent; only a fresh `setVisible(true)` re-shows.

Window `focus` / `restore` / `show` → `setWindowAllows(true)`: re-shows only if
the renderer *still* wants the view.

### detach (full teardown)
- Renderer unmounts the pane: `iabSetVisible(false)` → `iabDetach()`
  (`removeChildView`). The renderer intent is cleared; the view and its page
  stay in memory for the next attach.
- `clearData` additionally destroys the `webContents`, so history/storage
  (persist:loam-iab partition) are really gone before the view is dropped.
- A crashed guest process (`render-process-gone`) drops the view immediately so
  it can never float dead over the app.

## Files

- `electron/inAppBrowser.cjs` — visibility state machine, `setVisible`/`hide`/
  `setWindowAllows`, attach-starts-hidden, `state.visible`.
- `electron/main.cjs` — window focus/minimize/restore wiring for the window
  factor.
- `electron/preload.cjs` — exposes `inAppBrowser.setVisible` over the bridge.
- `packages/web/src/lib/inAppBrowser.ts` — `iabSetVisible`, stream state gains
  `visible`.
- `packages/web/src/components/settings/InAppBrowserPane.tsx` — renderer-side
  visibility factors, bounds pushing (DPI snap + layout observers).
- `electron/__tests__/inAppBrowser.test.cjs` — `node:test` unit suite
  (`npm run test:electron`) with a mocked `electron` for the state machine.

## Verification

```
npx tsc --noEmit          # pass
npm run build:server      # pass
npm run test:electron     # pass, 4 tests
```
