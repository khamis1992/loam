/**
 * ui_examples_search — retrieve vetted Loam UI Kit blocks.
 *
 * Thin agent-tool wrapper over the design registry (src/design/registry.ts).
 * Given a natural-language query it returns the top-k vetted blocks with their
 * manifest (intent, tags, dependencies, tokens, source file) and, when present,
 * a screenshot attached as a vision image for the next model call.
 */

import fs from "node:fs";
import path from "node:path";
import { DESIGN_REGISTRY_DIR } from "../config.js";
import {
  loadDesignRegistry,
  rerankWithEmbeddings,
  searchDesignBlocks,
  type DesignBlockHit,
  type DesignEmbedder,
} from "../design/registry.js";
import { num, str, type Tool, type ToolContext, type ToolResult } from "./registry.js";

export const UI_EXAMPLES_TOOL_NAME = "ui_examples_search";

const DEFAULT_K = 5;
const MIN_K = 1;
const MAX_K = 10;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface UiExamplesOptions {
  /** Explicit registry directory; defaults to DESIGN_REGISTRY_DIR. */
  dir?: string;
  /** Optional embedder used to re-rank the BM25 shortlist. */
  embedder?: DesignEmbedder;
  /** Maximum screenshots to attach per call (default 3). */
  maxImages?: number;
}

function hitToJson(hit: DesignBlockHit): Record<string, unknown> {
  return {
    id: hit.id,
    name: hit.name,
    type: hit.type,
    description: hit.description,
    tags: hit.tags,
    intents: hit.intents,
    dependencies: hit.dependencies,
    tokens: hit.tokens,
    file: hit.file,
    ...(hit.screenshot ? { screenshot: hit.screenshot } : {}),
    rtl: hit.rtl,
    accessibility: hit.accessibility,
    ...(hit.code ? { code: hit.code } : {}),
    score: Number(hit.score.toFixed(4)),
  };
}

function loadScreenshot(dir: string, relative: string | undefined): string | null {
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
      "Search the Loam UI Kit registry for vetted, reusable UI blocks before writing interface code. Returns the top-k blocks (hero, bento, pricing, dashboard shell, auth, table, settings, empty states, navigation, CTA, testimonials, FAQ, stats, footer and RTL variants) with their manifest: intent, tags, dependencies, design tokens, source file and a short code snippet; when a block has a screenshot it is attached as an image. Compose these proven blocks instead of inventing layout from scratch, adapt them to the chosen design tokens, and prefer the Arabic/RTL variants for Arabic content.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need, in plain language (e.g. \"pricing\", \"empty state\", \"لوحة تحكم\")." },
        k: { type: "integer", description: "Number of blocks to return.", minimum: MIN_K, maximum: MAX_K, default: DEFAULT_K },
        type: { type: "string", description: "Optional block type filter (hero, bento, pricing, dashboard, auth, table, settings, empty-state, navigation, cta, testimonials, faq, stats, footer)." },
      },
      required: ["query"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const query = str(args, "query").trim();
      if (query.length === 0) return { ok: false, content: "query is required" };
      const k = Math.max(MIN_K, Math.min(MAX_K, num(args, "k", DEFAULT_K)));
      const type = str(args, "type").trim() || undefined;
      const dir = options.dir ?? DESIGN_REGISTRY_DIR;
      try {
        const registrySize = loadDesignRegistry(dir).length;
        if (registrySize === 0) {
          return { ok: false, content: `design registry not found at ${dir}` };
        }
        let hits = searchDesignBlocks(query, { k: k * 2, type, dir });
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
