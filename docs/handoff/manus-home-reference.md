# Manus home reference — text spec (from manus-home-reference.png, window 1024x670)
Background: whole window warm off-white #F8F8F7; sidebar same color, no border; main area slightly lighter cards #EFEFED rounded 12px.

## Top bar (height ~30px, spans full width, part of window drag region)
Left, x=12..110: [sidebar-toggle icon (lucide PanelLeft)] [ArrowLeft grey] [ArrowRight grey] [Search icon]. Icons 16px, grey #555, 20px gaps.
Right: native min / max / close (Electron frameless window controls).

## Sidebar (width ~192px, left)
Nav list (14px text, 16px lucide icons, 26px row height, left padding 10px):
1. SquarePen  "New task"
2. Monitor    "Computers"
3. (round blue gradient avatar icon) "Agents" + small grey pill badge "Cue!"   -> OURS: "Agent Loam", no badge
4. Search     "Search"   right-aligned grey hint "Ctrl+K"  (this row has a light grey hover/selected bg #ECECEA, radius 8)
5. Library (books icon) "Library"
6. Sparkles/scissors-like "Creations"
7. Workflow/route icon "Automations"
8. LayoutGrid (4 squares) "Plugins"
9. Ellipsis "More"
Gap 20px.
"Projects ›" (12px grey #888, chevron right).
Gap 14px.
"Tasks" (12px grey #888) section header, then task rows: each row 26px, 14px icon at left (file/doc/chat type icons, grey), title 13px black, truncated with ellipsis.
Bottom (sticky):
- Referral card: white bg, border #E5E5E3, radius 12, padding 10: icon (Share/plane) + "Share Manus with a f..." (14px, truncated) on line 1, "Get 500 credits each" (12px grey) line 2, chevron right at far right. OURS: "Share Agent Studio with a friend".
- User row: round avatar 20px with initial "K" (dark bg white letter), name "khamis" 13px bold, right side: devices icon (MonitorSmartphone) and Bell icon.

## Main / home (centered column ~615px wide, x 300..915)
Top-left (x=212,y=50): "Manus 2.0 ▾" model dropdown, 14px medium.  OURS "Agent Studio 2.0 ▾"
Top-right: pill "✦ 18K" (sparkle icon + credits, white bg, border, radius 8) then panel-right toggle icon.
Row 1 (y~70..115): left = logo mark (hand-drawn black glyph ~36px) + wordmark: "manus" in black serif 34px bold + " studio" in grey #888 serif 34px.  OURS: "agent studio" same styling (one 'studio' only!).
   right = dark promo card 200x44, bg #1A1A1A radius 10: small thumbnail 26px at left, title "Create your Video" white 14px semibold, subtitle "Make ideas come alive" grey 11px; tiny vertical scrollbar/carousel indicator at right edge.
Row 2 (y 135..355): left column 390px wide two stacked cards (height 104 each, gap 10):
   - "Build ›" card: blue hammer icon top-left, title "Build ›" 15px, subtitle "Websites, apps, and games" 12px grey; right half has light grey line-art (circle in grid, wireframe).
   - "Create ›" card: orange two-dot icon, "Create ›", "Slides, images, and videos"; right half light line-art of stacked tilted rectangles.
   right column 215px tall card (height 218): centered grey folder illustration, "Start from a local file" 14px medium, "Click or drag local files here" 12px grey.
Row 3 (y 376..512): three template cards 200x112 thumbnails radius 10, with a tag chip top-left on the image (dark translucent, white 11px with icon): "Video", "App", "Website". Captions below centered 13px medium: "Create an anime short", "Build a personal budget app", "Turn a résumé into a personal website". Thumbnails are full-bleed images (anime street scene; dark finance dashboard; dark website hero "Making the intangible feel real.").
Row 4 composer block (white, border #E5E5E3, radius 16, width 615):
   context row inside top (13px grey, icons 14px): "This PC" (laptop) · "Choose project" (folder-plus) · "Downloads" (folder) · git-branch icon + "agi/build-a-complete-pro..." (truncated branch name) · checkbox + "Worktree" (greyed).
   divider, then placeholder "Assign a task or type / for more" 14px grey.
   bottom row: left: round "+" button 24px; connector pill (GitHub, Gmail, Google Calendar icons overlapping + "+4"); "Approve for me" with shield-check icon. right: voice-mode icon (audio waveform in circle), mic icon, round grey send button with ArrowUp.
