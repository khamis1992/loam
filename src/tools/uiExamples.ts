/**
 * ui_examples_search — retrieve vetted Loam UI Kit blocks.
 *
 * Thin agent-tool wrapper over the design registry retrieval surface
 * (`src/design/retrieval.ts`, backed by the manifest contract and scoring
 * primitive in `src/design/registry.ts`). Given a natural-language query —
 * English or Arabic — it returns the top-k vetted blocks with their manifest
 * (name, category, intent, tags, dependencies, entry file, license) and a short
 * code snippet, and attaches each block's screenshot as a vision image when one
 * exists. The point is to make the model compose proven blocks instead of
 * inventing layout from scratch.
 */

import fs from "node:fs";
import path from "node:path";
import { DESIGN_REGISTRY_DIR } from "../config.js";
import {
  loadDesignRegistry,
  rerankWithEmbeddings,
  searchDesignBlocks,
  type BlockHit,
  type DesignEmbedder,
} from "../design/retrieval.js";
import { num, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";

export const UI_EXAMPLES_TOOL_NAME = "ui_examples_search";

const DEFAULT_K = 5;
const MIN_K = 1;
const MAX_K = 10;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface UiExamplesOptions {
  /** Explicit registry directory; defaults to DESIGN_REGISTRY_DIR. */
  dir?: string;
  /** Optional embedder used to re-rank the lexical shortlist. */
  embedder?: DesignEmbedder;
  /** Maximum screenshots to attach per call (default 3). */
  maxImages?: number;
}

function hitToJson(hit: BlockHit): Record<string, unknown> {
  return {
    id: hit.id,
    name: hit.name,
    category: hit.category,
    description: hit.description,
    tags: hit.tags,
    intent: hit.intent,
    deps: hit.deps,
    rtl: hit.rtl,
    lang: hit.lang,
    entry: hit.entry,
    license: hit.license,
    source: hit.source,
    ...(hit.screenshot ? { screenshot: hit.screenshot } : {}),
    ...(hit.code ? { code: hit.code } : {}),
    score: hit.score,
  };
}

/** Read a block screenshot (base64) when it exists and is an image. */
function loadScreenshot(dir: string, relative: string | null): string | null {
  if (!relative) return null;
  const file = path.resolve(dir, relative);
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file).toString("base64");
  } catch {
    return null;
  }
}

export function createUiExamplesTools(options: UiExamplesOptions = {}): Tool[] {
  return [{
    name: UI_EXAMPLES_TOOL_NAME,
    description:
      "Search the Loam UI Kit registry for vetted, reusable UI blocks before writing interface code. Returns the top-k blocks (hero, bento, pricing, dashboard, auth, table, settings, empty states, navigation, CTA, social proof, FAQ, stats, gallery, footer and Arabic/RTL variants) with their manifest — category, intent, tags, dependencies, entry file, license — plus a short code snippet; when a block ships a screenshot it is attached as an image. Compose these proven blocks instead of inventing layout from scratch, adapt them to the chosen design tokens, and prefer the Arabic/RTL variants for Arabic content.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What you need, in plain language, in any language (e.g. \"pricing\", \"empty state\", \"لوحة تحكم\", \"تسعير\").",
        },
        k: {
          type: "integer",
          description: "Number of blocks to return.",
          minimum: MIN_K,
          maximum: MAX_K,
          default: DEFAULT_K,
        },
        category: {
          type: "string",
          description:
            "Optional category filter (hero, bento, pricing, dashboard, auth, table, settings, empty-state, features, cta, social-proof, stats, gallery, blog, faq, contact, navigation, footer, logos).",
        },
        rtl: {
          type: "boolean",
          description: "Restrict to Arabic/RTL blocks when true, or LTR blocks when false.",
        },
      },
      required: ["query"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const query = str(args, "query").trim();
      if (query.length === 0) return { ok: false, content: "query is required" };
      const k = Math.max(MIN_K, Math.min(MAX_K, num(args, "k", DEFAULT_K)));
      const category = str(args, "category").trim() || undefined;
      const rtlArg = args["rtl"];
      const rtl = typeof rtlArg === "boolean" ? rtlArg : undefined;
      const dir = options.dir ?? DESIGN_REGISTRY_DIR;
      try {
        const registrySize = loadDesignRegistry(dir).length;
        if (registrySize === 0) {
          return { ok: false, content: `design registry not found at ${dir}` };
        }
        let hits = searchDesignBlocks(query, { k: k * 2, category, rtl, dir });
        if (options.embedder) hits = await rerankWithEmbeddings(hits, query, options.embedder);
        hits = hits.slice(0, k);
        const maxImages = Math.max(0, options.maxImages ?? 3);
        const images: string[] = [];
        for (const hit of hits) {
          if (images.length >= maxImages) break;
          const image = loadScreenshot(dir, hit.screenshot);
          if (image) images.push(image);
        }
        return {
          ok: true,
          content: JSON.stringify({ query, count: hits.length, registrySize, results: hits.map(hitToJson) }),
          ...(images.length > 0 ? { images } : {}),
        };
      } catch (error) {
        return { ok: false, content: `ui_examples_search failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  }];
}
