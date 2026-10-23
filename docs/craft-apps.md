# Loam Craft apps (Loam Docs / Sheets / Slides / Photo / Design)

Loam embeds the original ArtCraft applications, vendored as wasm web builds and
rebranded, so a file attached in chat opens directly in the matching editor in
the Workspace panel. The apps are driven live by the agent over a
`craft:*` postMessage bridge; the user can also edit by hand and export from
the panel or by asking in chat.

This document covers the vendored dists, the `loamcraft://` scheme, the fetch
scripts and the layout. The web-side bridge (`packages/web/src/lib/craft.ts`) and
the Workspace registration are added by cr-02/cr-03.

## Apps and branding

| Internal id | User-facing name | Formats |
| --- | --- | --- |
| `wordcraft` | Loam Docs | docx / doc / odt / rtf / md / html |
| `gridcraft` | Loam Sheets | xlsx / csv / ods |
| `deckcraft` | Loam Slides | pptx / odp / key |
| `photocraft` | Loam Photo | psd / png / jpg / webp / tiff / raw / heif |
| `designcraft` | Loam Design | idml / pdf / epub / pptx export |

The user-facing names are exactly **Loam Docs, Loam Sheets, Loam Slides, Loam
Photo, Loam Design**. Never show WordCraft / GridCraft / DeckCraft / PhotoCraft /
DesignCraft in the UI, prompts or tool descriptions. Internal ids and engine
globals keep the `wordcraft` / `gridcraft` / ... names.

## Bridge protocol (postMessage, iframe URL must contain `loam=1`)

- host → app: `{type:'craft:call', id, method, params}` ; `{type:'craft:open', name, bytes:Uint8Array}` (same path as a dropped file)
- app → host: `{type:'craft:ready', app, version}` ; `{type:'craft:result', id, ok, result?, error?}` (result is the control reply, usually `{ok:true, result:...}`) ; `{type:'craft:save', app, name, bytes:Uint8Array}` — EVERY save/export (`file.save`, `file.saveAs`, `file.exportPdf`…) is handed to the host instead of downloading.
- Only messages whose source is `window.parent` are accepted.

The bridge lives in the app itself: `scripts/vendor/craft/loam_bridge.rs` is
compiled into each wasm build (applied by `scripts/vendor/craft/apply_patch.py`).
Unlike Loam Video there is no injected relay overlay.

Verified save/export paths: Loam Docs/Sheets `file.save`; Loam Slides
`file.save` (native) or `app.saveAsDialog {format:'pptx'}`; Loam Photo/Design use
the UI-level export commands (routed to `craft:save`). Opening is
`{type:'craft:open', name, bytes}` (Design: `file.new {preset:'A4'}`).

## Layout

| Path | What it is |
| --- | --- |
| `scripts/vendor/craft/` | Source of truth for the patch: `loam_bridge.rs`, `apply_patch.py`, `rebrand_src.py`, `build-craft-web.sh`, `manifest.json`. |
| `scripts/vendor/fetch-craft.mjs` | CLI: fetch and install the dists. |
| `scripts/vendor/lib/` | Shared, dependency-free zip/vendor helpers (also used by `fetch-filmcraft.mjs` and `fetch-effectcraft.mjs`). |
| `electron/craft/<app>/dist/` | Installed dist (gitignored). Contains the bundle, e.g. `index.html`, `<app>_web_bg.wasm`, and Photo's `app/` parts, plus a `.vendor.json` sidecar. |
| `electron/vendorProtocol.cjs` | Shared static-file serving for `loamfilm://` and `loamcraft://`. |
| `src/server/craftStatus.ts`, `src/server/routes/craft.ts` | `GET /api/craft/status` and the startup availability check. |
| `electron/filmcraft/` | Loam Video dist + overlay (existing, shared helper only). |

## Fetch / build

```sh
# All five apps (sources: LOAM_CRAFT_<APP>_ZIP, then ~/Desktop/loam-vendor/<zip>)
npm run vendor:craft

# One app, force a re-install, or build from source (needs bash, cargo, trunk)
node scripts/vendor/fetch-craft.mjs wordcraft --force
node scripts/vendor/fetch-craft.mjs --from-source
```

- Sources are tried in order: `LOAM_CRAFT_<APP>_ZIP` (upper-case app id, e.g.
  `LOAM_CRAFT_WORDCRAFT_ZIP`) local zip path, then the cached
  `~/Desktop/loam-vendor/<zip>` from `scripts/vendor/craft/manifest.json`
  (sha256 verified; a mismatch aborts that app). `--from-source` clones the
  pinned upstream repo, applies the bridge patch + rebrand, and builds with
  Trunk. Extraction and installation reuse the shared, dependency-free helpers
  in `scripts/vendor/lib/` (the same zip/vendor code the Loam Video fetchers
  use), so no external `tar`/`unzip` tool is required.
- The zip's single top folder is installed as `electron/craft/<app>/dist`
  (nested folders such as Photo's `app/` parts are preserved) and
  `dist/.vendor.json` is written with `{app, rev, sha256, source, fetchedAt}`.
  Vendored licence/README/attribution files are pruned. An existing dist is
  skipped unless `--force`.
- When nothing is available the app is skipped and Loam falls back to its own
  editor for that file type. Nothing is downloaded on `npm install`.

## Electron: the `loamcraft://` scheme

Registered in `electron/main.cjs` (before `app.ready`) alongside `loamfilm`:

```js
protocol.registerSchemesAsPrivileged([
  { scheme: "loamfilm", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "loamcraft", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
```

`protocol.handle("loamcraft", ...)` serves `loamcraft://<app>/<path>` from
`electron/craft/<app>/dist` for the five allowed app ids only (404 otherwise),
with path-traversal protection and correct MIME types (`.wasm`
`application/wasm`, `.js` `text/javascript`, `.html`, `.png`, `.ico`, `.ttf`,
`.woff2`, unknown `application/octet-stream`). File resolution and MIME mapping
are shared with `loamfilm://` through `electron/vendorProtocol.cjs`; Loam Video
behaviour is unchanged.

## Availability to the app

`GET /api/craft/status` returns `{ apps: [{ app, name, installed, rev, source }] }`
for the five apps, read from each dist's `.vendor.json`. The web panel uses this
to choose the Craft app or the Loam fallback editor. On startup the server logs
how to fetch any missing dist (never auto-downloads).

## End-user flow

### English

1. **Attach the file.** Drop or attach a `.docx`, `.xlsx`, `.pptx`, image or
   layout file in the chat, then write the instruction ("add a paragraph about
   the budget", "colour the chart by region", "crop the logo").
2. **The panel opens by itself.** The matching editor (Loam Docs, Loam Sheets,
   Loam Slides, Loam Photo or Loam Design) opens in the right-side Workspace
   panel with the attached file loaded. The agent picked the app from the file
   type and the intent.
3. **Edits land live.** The agent reads the document's current state, applies the
   edits through the app's own control channel, and re-reads the state to confirm
   each change. The user sees the changes as they happen and can keep editing the
   same file by hand at any time.
4. **More prompts, more edits.** Each follow-up instruction is applied on top of
   the current state, so the agent re-reads before every batch of edits and never
   assumes the file on disk is the truth.
5. **Export.** Export from the panel button, or say "export"/"save" in chat. The
   saved bytes come back into the task's files, ready to download or to hand off.

### العربية

1. **أرفق الملف.** أضف ملف `.docx` أو `.xlsx` أو `.pptx` أو صورة أو ملف تصميم في
   المحادثة، ثم اكتب التعليمة («أضف فقرة عن الميزانية»، «لوّن الرسم حسب المنطقة»،
   «اقتطع الشعار»).
2. **اللوحة تفتح تلقائيًا.** يفتح المحرر المناسب (لوام دوكس أو لوام شيتس أو لوام
   سلايدس أو لوام فوتو أو لوام ديزاين) في لوحة «مساحة العمل» على اليمين والملف
   محمّل فيه. يختار المساعد التطبيق من نوع الملف ونية الطلب.
3. **التعديلات تظهر مباشرة.** يقرأ المساعد حالة المستند الحالية، ثم يطبّق
   التعديلات عبر قناة التحكم الخاصة بالتطبيق نفسه، ثم يعيد قراءة الحالة
   للتأكد من كل تعديل. يرى المستخدم التغييرات فورًا، ويستطيع متابعة التحرير
   بنفسه في أي لحظة.
4. **أوامر إضافية وتعديلات إضافية.** كل تعليمة لاحقة تُطبَّق فوق الحالة الحالية،
   لذلك يعيد المساعد القراءة قبل كل مجموعة تعديلات، ولا يفترض أبدًا أن الملف
   على القرص هو الحالة الصحيحة.
5. **التصدير.** صدّر من زر اللوحة، أو قل في المحادثة «صدّر» أو «احفظ». تعود
   البايتات المحفوظة إلى ملفات المهمة، وتصبح جاهزة للتنزيل أو للتسليم.

## Agent loop and fallback

The agent drives the panel over the `craft:*` postMessage bridge. The loop it must
follow is:

1. **Open** with the attached file (`{type:'craft:open', name, bytes}`).
2. **Read the live state** (`document.inspect` / `sheet.read` / `cell.get` /
   `ui.inspect`) before every batch of edits; the user may have edited the file by
   hand between calls.
3. **Discover commands** with `engine.commands` and read the returned ids,
   labels, params docs and `enabled` / `disabledReason` / `needsDocument` flags.
   Loam Sheets narrows the same call with `{search}`; the other control channels
   always return the full command list.
4. **Batch the edits**, then re-read the state and confirm the change is present.
5. **Export** through the app so the bytes return to the host (`craft:save`).

If no app is installed, the panel never reports ready, a command is refused, or
the app reports `no document open`, the agent says so plainly in the user's
language and falls back to Loam's own editors (`loam_studio` with
`office_import` / `office_export` / `office_edit`, or `loam_document` for
Markdown/HTML). It never retries the same unavailable command and never writes
the office file itself through shell or Python.

### Per-app command cheat-sheet

Conservative command ids, each verified against the app's own control protocol and
re-checked at runtime with `engine.commands`:

| App | Read state | Common edits | Export / save |
| --- | --- | --- | --- |
| Loam Docs | `document.inspect`, `ui.inspect`, `ui.render {page?}` | `text.insert {text}`, `format.set`, `para.set`, `styles.modify`, `table.modifyStyle` | `engine.execute {command:'file.save'}` |
| Loam Sheets | `sheet.read {range?, sheet?, formulas?, formatted?}`, `cell.get {cell?}`, `document.inspect` | `cell.set {cell, input}`, `range.setValues {range, values}` | `engine.execute {command:'file.save'}` |
| Loam Slides | `document.inspect`, `ui.inspect`, `ui.render {slide?, scale?}` | `shape.insert {preset, rect, text}` | `file.save` (native) or `{command:'app.saveAsDialog', params:{format:'pptx'}}` |
| Loam Photo | `document.inspect`, `layer.list`, `document.pixel {x, y}`, `ui.inspect` | `layer.new.layer {name}`, `layer.setProps`, `paint.stroke {points, size, color}`, `select.rect`, `type.editText` | read the full `engine.commands` list (this control channel takes no filter), pick the UI-level export command, then `app.save` |
| Loam Design | `document.inspect`, `ui.inspect`, `ui.render {page?, scale?, bleed?}` | `frame.create {rect, content}` | read the full `engine.commands` list (this control channel takes no filter), pick the UI-level export command, then `app.save` / `app.export` |

Every app answers the same core control methods `engine.execute`, `engine.commands`,
`document.inspect`, `ui.inspect`, `ui.screenshot`, `ui.key` and `ui.click`, and reports
errors as `ok:false` with the app's own message. Everything beyond that core is
app-specific: `ui.render` and `ui.set` are not universal (Loam Sheets lists neither; its
UI state goes through `ui.ribbon` / `ui.backstage` / `ui.dialog`), the pointer surface
differs (Docs, Sheets, Slides and Design take `ui.move` / `ui.drag`; Slides, Photo and
Design also take the richer `ui.pointer`; Photo takes `ui.click` / `ui.move` but no
`ui.drag`), and the file-level methods differ (`file.save` on Docs and Sheets,
`app.save` / `app.export` on Photo and Design).
