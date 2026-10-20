# Loam Bots Marketplace — Build Spec

Status: data and design spec only. No changes were made to the Loam repo.
Inputs:
- `catalog.json`: 819 entries. 90 come from x.ai, 745 from botdirectory, and 17 are in both and were merged.
- `icons/xai/*`: 90 avatars.
- `evidence/`: raw HTML/RSC, `xai_raw.json`, `botdirectory.css`, `global.css`, `tool-icons.json`, `LICENSE`.

## 1. Sources and coverage

| Source | How obtained | Bots | Fields available |
|---|---|---|---|
| x.ai/bot/marketplace | SSR HTML. The Next.js RSC payload (`self.__next_f`) carries the bot objects. All 90 detail pages `/bot/marketplace/bots/<id>` were also fetched. No browser needed. | 90 | `id`, `name`, `creatorName`, `handle`, `description`/`summary`, `categories[]`, `installCount`, `color`, `shape`, `imageUrl`, `addHref` (`/bot/<shareId>`), `updatedAt`, `skills[]` (name, description, full content; 443 total across 75 bots), `routines[]` (name, summary; 67 bots), `memories[]`, `integrations[]` |
| github.com/elie222/botdirectory.ai `bots/*.md` | git clone. YAML frontmatter plus markdown body. | 746 files, 745 unique after name normalisation | `name`, `category`, `added_at`, `updated_at?`, `contributor`, `contributor_url`, `scouted_by`, `integrations[]`, `integration_urls{}`, `url?`, `grok_share_url?` (245), `description?` (172), `added_via?`, `sources[]?`. The body is the setup prompt and is used as `instructions`. |

Gaps:
- **x.ai `instructions`:** empty ("") for every bot. The public pages do not expose system prompts. Skills, routines and memories are public. On Add, Loam composes instructions from description + skills + memories (see §4).
- **x.ai routine schedules:** only name and summary are public. There is no cron.
- **Unresolved text references:** 6 skill/memory texts are RSC `$NN` references that did not resolve, so they show as a literal `$NN` string. Fix by rendering the detail page in a browser, or ignore.
- **botdirectory avatars:** bots have no avatars. Render a monogram tile in the category colour. Integration icons come from `evidence/tool-icons.json` (svgl.app URLs). They were not downloaded.
- **Categories:** x.ai categories are Operations, Sales, Marketing, Design, Engineering, Product, Personal, Recruiting & People, and "From Grok Bot Team". botdirectory categories are Productivity, Sales, Marketing, Ops→Operations, Success→Customer Success, and Personal. They were merged as-is.

## 2. Data schema (TS)

```ts
type Source = 'xai' | 'botdirectory';
interface CatalogEntry {
  id: string;                 // 'xai-<slug>' | 'bd-<file-slug>'
  source: Source[];           // both when merged by normalized name
  name: string;
  description: string;        // bd: frontmatter description or first sentence of prompt
  category: string;
  tags: string[];
  icon: string;               // local path 'icons/xai/<id>.jpg' or '' (render monogram)
  iconStyle: { color?: string; shape?: string; monogram?: string; categoryColor?: string };
  instructions: string;       // bd: full prompt body; xai: '' (not public)
  tools: string[];            // integration display names (Notion, Gmail, ...)
  toolUrls?: Record<string,string>;
  skills: { name: string; description: string; content: string }[];
  memories: string[];
  routines: { name: string; summary: string }[];
  author: { name?: string; handle?: string; url?: string; scoutedBy?: string };
  installCount?: number; addedAt?: string; updatedAt?: string;
  addHref?: string; grokShareUrl?: string; homepage?: string;
  sourceUrl: string; alsoAt?: string[];
  license: string;
}
// Loam-side persisted state
interface MarketplaceInstall { catalogId: string; agentId: string; addedAt: string; catalogVersion: string }
```

Ship `catalog.json` plus `icons/` inside the app as a static asset, e.g. `packages/web/public/marketplace/`. Install state lives in the backend, not in the catalog.

## 3. UI spec (mirrors botdirectory.ai)

Entry point:
- Sidebar: Agent Loam → "Marketplace" tab or button.
- Route: `/agents/marketplace`.
- Page max-width is 1150px with 24px side padding.

### 3.1 Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Works with Loam                                    (eyebrow, blue)   │
│ The Loam bot directory                     (46px display, ink)       │
│ Bots that get stuff done. Add one with a single click.  (18px muted) │
├──────────────────────────────────────────────────────────────────────┤
│        [Search____]  [Any category ▾] [Any integration ▾] [Most added ▾]  Table | Cards │
│ ───────────────────────────────────────────── (1px line, mb 24px) ── │
│ TABLE VIEW (default ≥901px)                                          │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Bot              │Category │Integrations      │Source  │   Add  │ │ ← head 12px/600 muted-2, bg surface
│ ├──────────────────┼─────────┼──────────────────┼────────┼────────┤ │
│ │ AccountingBot    │(Ops)    │ ▣ Notion         │@benln  │ [Add]  │ │ ← row 13px 18px pad, hover bg surface
│ │ Handle accounting work on a schedule… (1 line ellipsis)          │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

- Grid columns: `minmax(200px,1.4fr) 130px minmax(160px,1.4fr) 120px 72px`, gap 16px. Table radius is 20px, it has a 1px `--line` border, and the shadow is `--shadow`.
- The whole row is clickable through the name link's `::after` (inset 0). The Add cell sits above it at z-index 2.

Cards view (toggle; forced at ≤900px):
- `grid-template-columns: repeat(auto-fill, minmax(330px,1fr))` with an 18px gap. At ≤900px the minimum is 300px.
- In practice that gives 3 columns at 1150px, 2 on mid widths and 1 on phones.

```
┌───────────────────────────────────────┐  radius 20, pad 20, border line, shadow
│ [◼] AccountingBot (19px)       [Add]  │  hover: shadow-lg + translateY(-2px), 180ms
│ ┌───────────────────────────────────┐ │
│ │ Handle accounting work on a sched │ │  98px tall, mono 12.5px, bg surface,
│ │ ule when I ask, in your own ded…  │ │  border line, radius 10, pad 10/12
│ └───────────────────────────────────┘ │
│ [▣ Notion] [▣ Gmail]                  │  chips: 12px/500, border line-2, r7, pad 3/8
│ (Ops)                       @benln    │  cat-pill 11.5px/600 r8 pad 3/9; mono 12.5 handle
└───────────────────────────────────────┘
```

Loam addition: a 28px avatar ([◼]) left of the name. It is the x.ai image, or a monogram on the category `-50` background with `-600` ink, in the x.ai `shape`. Squircle uses radius 8 and circle uses 50%.

Empty state:
- Dashed 1px `line-2` border, radius 20, padding 72/24.
- Title: "No bot for that yet."
- Sub-line: "Try another search or category."

### 3.2 Detail panel

Opens from the card or row. Use a right side-sheet in Loam, matching the Manus side-panel workflow.

```
Marketplace › Ops                         (breadcrumb)
AccountingBot                             (42px display)
(Ops) · 1.2k adds · by @benln             (badge row, gap 8, mt 20)
── Instructions ──────────── [Add] [Copy prompt]
┌ mono 13.5/1.7, bg surface, border line, radius 14 ┐
│ full prompt / composed instructions               │
└────────────────────────────────────────────────────┘
── Connect first ──  [▣ Notion]  (chips 18px icon)
── Skills (n) ──  accordion: name / description / content
── Routines (n) ── name + summary (created paused)
── Source ── botdirectory.ai/bots/... · x.ai link · license line
── Related bots ── 3-col grid of same-category cards
```

### 3.3 Tokens (light / dark)

| Token | Light | Dark |
|---|---|---|
| page | #FDFDFD | #0B0B0B |
| white (card) | #FFFFFF | #141414 |
| surface | #F7F7F7 | #1B1B1B |
| ink | #242424 | #F2F2F2 |
| body | #3D3D3D | #D8D8D8 |
| muted | #848484 | #8C8C8C |
| muted-2 | #6D6E70 | #A8A8A8 |
| line | #EFEFEF | rgba(255,255,255,.08) |
| line-2 | #E6E6E6 | rgba(255,255,255,.14) |
| gray-600 | #525252 | #B4B4B4 |
| blue brand / 600 | #2563EB / #006EFF | — / #8AA9FF |
| shadow | 0 2px 16px rgba(0,0,0,.03) | none |
| shadow-lg | 0 10px 40px -10px rgba(0,0,0,.10) | 0 0 0 1px rgba(255,255,255,.10) |
| r-card / r-ctl | 20px / 13px | 14px / 10px |

Category colours (bg `-50`, fg ink, border `-150`):

| Category | Colour family | Light values (50 / ink / 150) |
|---|---|---|
| Productivity | blue | #EFF6FF / #006EFF / #D6E8FC |
| Sales | green | #F3FFEF / #17A34A / #DDF4D3 |
| Marketing | orange | #FFF5EF / #E65707 / #FCE2D5 |
| Ops / Operations | indigo | #EFF3FF / #124DFF / #D5DEFC |
| Success | pink | #FFEEF8 / #C942B2 / #FDD3EB |
| Personal | yellow | #FFFBEF / #D8A40C / #E7E0CB |

Unmapped x.ai categories (Design, Engineering, Product, Recruiting & People, "From Grok Bot Team") get purple: #F3EAFE / #6410FF / #E1D5FC.

Fonts:
- Display: Aeonik 500–700 (fallback Inter Tight). Aeonik is a commercial font, so use Inter Tight in Loam.
- Body: Geist 400–700 (OFL).
- Mono: Geist Mono.

Controls:
- Search: underline input, 13.5px, 150px wide, bottom border `line`.
- View toggle: text buttons 13.5px/500. Muted, and ink when active.
- Selects: popover listbox. The category options show a 9×9 r3 swatch.

### 3.4 Add button and states

| State | Look | Label |
|---|---|---|
| default | bg ink, text #fff, border ink, r9 (r7 in row), pad 6/12 (row: 4/10, 12px/600) | Add |
| hover | bg/border body #3D3D3D | Add |
| pending | same plus spinner, disabled | Adding… |
| added | bg surface, text muted, border line-2, check icon, disabled. A secondary link "Open" goes to the agent's thread. | ✓ Added |
| error | toast "Couldn't add <name>". The button returns to default. | Add |

## 4. Add flow → Loam agent model

One click with no form. The flow is:
1. `POST /api/agents/from-catalog { catalogId }`.
2. The backend loads the entry from the bundled catalog.
3. It creates the agent and records `MarketplaceInstall`.
4. It returns the agent.
5. The UI flips the button to Added and shows the toast "<name> added to Agent Loam", with an Open action.

The operation is idempotent: if the `catalogId` is already installed, it returns the existing agent. Removing (archiving) the agent clears the Added state.

| Loam field | Value |
|---|---|
| name | `entry.name` (append " 2" on name collision) |
| avatar | copy `entry.icon` into agent assets. Otherwise generate a monogram with the category colour. |
| description | `entry.description` |
| instructions | bd: `entry.instructions` (prompt body). xai: compose `description` + "\n\n## Skills\n" + each skill (name, description, content) + "\n\n## Memory\n" + memories. |
| mode | Map from category/tools: Engineering → code; Design → design; anything with sheets/docs/slides tools → office; else → general (resolve with `src/modes/detect.ts`). |
| tools / skills | Default Loam tool set for the mode. x.ai skills become agent skills 1:1. |
| connectors | `entry.tools` mapped to Loam connectors by name. Unknown or unconnected ones are listed as "Connect first" on the agent overview, and the agent is not blocked. |
| routines | Created **paused**. Name and summary come from the entry, and schedule = null. The user enables them. The marketplace never auto-runs anything. |
| model | App default model ("Loam 2.0") |
| memory | Enabled. Seeded with `entry.memories`. |
| metadata | `{ catalogId, source, sourceUrl, license, author }` shown under Overview › Source |

Safety: imported text is untrusted content. Keep Loam's approval gates for any outbound or financial action. Do not execute imported setup steps automatically.

## 5. Licensing

- **botdirectory.ai repo:** MIT, "Copyright (c) 2026 Inbox Zero Inc." Bundling the prompt texts is allowed if the MIT notice is included. Ship `THIRD_PARTY_NOTICES` with the LICENSE text and show per-entry attribution (contributor and source URL). The repo's own policy says configs behind x.ai share links are linked, never rehosted.
- **x.ai marketplace:** there is no license on the content and it is creator-authored (`creatorName`/`handle`). Avatars are hosted on x.ai's S3. Treat descriptions, skills and avatars as **all rights reserved**. Bundling them in a distributed app is a legal risk.

  Options:
  - (a) Personal/internal build only.
  - (b) Ship metadata (name, short description, category, link) only, and fetch details at runtime.
  - (c) Get permission.

  Recommended: (b) for any public distribution. Data for (a) is already collected.
- Aeonik font: commercial, so do not bundle it. Geist is OFL, so it is OK.

## 6. Files

```
catalog.json            819 normalized entries
icons/xai/<id>.jpg      90 avatars
evidence/xai.html, xai_rsc.txt, xai_pages/*.html, xai_raw.json
evidence/bd.html, botdirectory.css, global.css (site source), tool-icons.json, LICENSE
repo/                   botdirectory.ai clone (src/components, src/pages/bots/[slug].astro for reference)
build.py, xai.py, xai2.py  reproducible extractors
```
