# Agent Avatars (Grok Bot-style)

Every agent renders a Grok Bot-style avatar: a colored geometric shape with a
centered monogram, or a custom image. This document describes the tokens, the
states, the component, and the HTTP endpoint.

## Shapes (8)

One of: `squircle`, `teardrop`, `pebble`, `hex`, `blob`, `cloud`, `wedge`,
`tablet`. All geometry is original SVG (64x64 viewBox) drawn in
`packages/web/src/components/agents/AgentAvatar.tsx`.

## Colors (10)

Named tokens with concrete hex values (defined once in the `PALETTE` map of
`AgentAvatar.tsx`):

| Token     | Hex        | Monogram ink |
| --------- | ---------- | ------------ |
| `red`     | `#e5484d`  | white        |
| `orange`  | `#f76b15`  | white        |
| `yellow`  | `#ffc53d`  | `#4a3200`    |
| `green`   | `#30a46c`  | white        |
| `cyan`    | `#12a594`  | white        |
| `blue`    | `#0090ff`  | white        |
| `violet`  | `#6e56cf`  | white        |
| `magenta` | `#d6409f`  | white        |
| `brown`   | `#ad7f58`  | white        |
| `gray`    | `#6e6f77`  | white        |

## Monogram

The first grapheme of the agent name, uppercased (Intl.Segmenter grapheme
clusters when available, code-point fallback). The monogram is centered over
the shape and skipped entirely when a custom image is set.

## Defaults

When `avatarShape`/`avatarColor` are unset, the component derives a stable
shape + color from an FNV-1a hash of the agent name (shape = hash % 8,
color = second-seed hash % 10). The same name always yields the same avatar.

## States

- **Selected**: a ring around the avatar (double box-shadow in the shape color).
- **Working/thinking**: an animated pulsing status dot at the bottom-right
  corner (CSS keyframes, infinite).
- **Typing**: a subtle breathing/brightness pulse on the avatar itself
  (CSS keyframes, infinite).
- All animations are disabled under `prefers-reduced-motion: reduce`.

## Accessibility

The avatar renders `role="img"` with `aria-label` set to the agent name;
decorative parts are `aria-hidden`.

## Component

`packages/web/src/components/agents/AgentAvatar.tsx`

```tsx
<AgentAvatar
  name={agent.name}
  avatarShape={agent.avatarShape}
  avatarColor={agent.avatarColor}
  avatarImage={agent.avatarImage}
  size={32}        // px edge length, default 32
  selected={bool}  // ring
  working={bool}   // pulsing dot
  typing={bool}    // breathing pulse
/>
```

Used in `AgentSidebarList.tsx`, `AgentCard.tsx`, and `AgentThreadView.tsx`
(thread header + message stream header). The Grok Bot badge is untouched.

## API

### `POST /api/agents/:id/avatar`

Sets avatar fields on an existing agent (same local-token auth as the rest of
`/api/agents/*`).

Request body (all fields optional, `null` clears the field):

```json
{ "avatarShape": "hex", "avatarColor": "violet", "avatarImage": null }
```

- `avatarShape` — sanitized to the 8 known shapes; anything else is dropped.
- `avatarColor` — sanitized to the 10 known tokens; anything else is dropped.
- `avatarImage` — data URL (`data:image/...`) or an `/api/...` asset path,
  capped at ~256KB; anything else is dropped.

Response: `200 { "agent": AgentRecord }` (the full updated agent), `404` if
the agent does not exist.

The same fields are accepted on `POST /api/agents` (create), the generic
`POST /api/agents/:id` update, `/duplicate`, `/import`,
`/import-grokbot` (bundle `agent` entries carry the tokens), and they persist
with the agent record.
