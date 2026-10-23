# Loam UI Kit block registry

A vetted library of UI blocks an agent can copy into a generated web app
instead of inventing markup from scratch. Blocks are content, not runtime code:
each is a self-contained React component plus a manifest that describes what it
is and where it came from.

The registry is validated and built by `npm run check:design-registry`
(`src/scripts/check-design-registry.ts`), backed by `src/design/registry.ts`.

## Layout

```
design-registry/
  README.md                 # this file
  blocks/
    <block-id>/
      manifest.json         # required contract (see below)
      <Component>.tsx       # the entry component (self-contained)
      README.md             # short usage note
```

## Manifest contract (`manifest.json`)

Schema `loam-design-block/1`. Required fields:

| Field | Type | Rule |
|---|---|---|
| `schema` | string | must be `loam-design-block/1` |
| `id` | string | kebab-case, must equal the directory name |
| `name` | string | human-readable block name |
| `description` | string | at least 20 characters |
| `category` | string | one of the categories below |
| `license` | string | `MIT` (shadcn/ui blocks) or `original` (Loam) |
| `source` | string | origin, e.g. `shadcn/ui blocks` |
| `tags` | string[] | kebab-case tags, at least one |
| `intent` | string | the design intent the block serves |
| `deps` | string[] | packages the block needs, at least one |
| `rtl` | boolean | `true` for an Arabic/RTL variant |
| `dir` | string | `ltr` or `rtl`, must agree with `rtl` |
| `lang` | string | `en` or `ar` |
| `screenshot` | string | path relative to the block dir, or `pending` |
| `entry` | string | the `.tsx` entry file |
| `files` | string[] | every file shipped with the block, including `entry` |
| `base` | string | required for RTL variants: the LTR block it mirrors |

### Categories

`hero`, `bento`, `pricing`, `dashboard`, `auth`, `table`, `settings`,
`empty-state`, `features`, `cta`, `social-proof`, `stats`, `gallery`, `blog`,
`faq`, `contact`, `navigation`, `footer`, `logos`, `comparison`, `newsletter`,
`team`, `timeline`, `onboarding`, `chart`.

## RTL variants

Every RTL block must:

- declare `rtl: true`, `dir: "rtl"`, `lang: "ar"` and a `base` block;
- render `dir="rtl"` on its root element;
- contain real Arabic copy (the validator requires at least 10 Arabic
  characters — placeholder transliteration is rejected).

## Validation and build

`check-design-registry` fails when:

- a manifest is missing, malformed, or references a file that does not exist;
- a block id is duplicated or does not match its directory;
- an RTL block lacks a base, Arabic copy, or the `rtl` direction;
- a block does not compile (esbuild bundles each entry, with `react` external).

## Retrieval

`searchBlocks(query, k)` in `src/design/registry.ts` ranks blocks by an
IDF-weighted term match over name, tags, category, intent and description. It is
the primitive behind the `ui_examples_search` tool.
