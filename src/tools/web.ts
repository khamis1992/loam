import { headOutput } from "../policy/commands.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";
export function parseSearchPage(html: string, limit: number) {
  const results: Array<{title:string;url:string}> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1]!;
    if (!/class=["'][^"']*\bresult__a\b[^"']*["']/i.test(attrs)) continue;
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    try {
      const link = new URL(href.replace(/&amp;/g, '&'), 'https://duckduckgo.com');
      const target = link.hostname === 'duckduckgo.com' ? link.searchParams.get('uddg') || link.href : link.href;
      if (!/^https?:\/\//i.test(target)) continue;
      results.push({ title: htmlToText(match[2]!), url: target });
      if (results.length >= limit) break;
    } catch { /* Skip invalid result links. */ }
  }
  if (!results.length && !/no-results|No results found/i.test(html)) throw Error('Search provider returned a challenge or unexpected page');
  return results;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webTools: Tool[] = [
  {
    name: 'web_search',
    description:
      "Search the web for sources and get back titles, URLs and snippets as JSON. Requires network access (policy.networkEnabled). Use it to find authoritative references, documentation or current facts, then open the promising links with web_fetch. Queries are limited to 1-2000 characters and results to 1-10. When NOT to use: use web_fetch to read a URL you already have, the browser tools when you need interaction or an authenticated page, and local file_search/code_symbols for anything already in the workspace; never call it when the network is disabled.",
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 10 } }, required: ['query'] },
    async run(args, ctx) {
      if (!ctx.cfg.policy.networkEnabled) return { ok: false, content: 'Network access is disabled' };
      const query = str(args, 'query').trim();
      if (!query || query.length > 2000) return { ok: false, content: 'Provide a search query of 1–2000 characters' };
      try {
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
        const response = await fetch('https://html.duckduckgo.com/html/?' + new URLSearchParams({ q: query }), { signal, headers: { 'user-agent': 'Loam/0.5' } });
        if (!response.ok) throw Error(`Search provider HTTP ${response.status}`);
        const ab = await response.arrayBuffer();
        if (ab.byteLength > 2_000_000) throw Error('Search response too large');
        const results = parseSearchPage(Buffer.from(ab).toString('utf8'), Math.max(1, Math.min(10, Math.floor(num(args, 'limit', 5)))));
        return { ok: true, content: JSON.stringify({ query, provider: 'DuckDuckGo', results, ...(results.length ? {} : { message: 'No search results returned. Try another query.' }) }) };
      } catch (error) { return { ok: false, content: `Search unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return its readable content; HTML is converted to plain text so it is easy to scan. Requires network access (policy.networkEnabled). Use maxBytes to cap the response (default 400000) and raw=true to get the unmodified body. Use it to read a page or document that web_search surfaced, or any URL you already know. When NOT to use: use web_search to discover URLs, the browser tools for interactive or authenticated content, and file_read for local files; never fetch non-http(s) URLs or rely on it when the network is disabled.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        maxBytes: { type: "number", description: "Response cap in bytes (default 400000)." },
        raw: { type: "boolean", description: "Return raw body instead of text conversion." },
      },
      required: ["url"],
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.cfg.policy.networkEnabled) return { ok: false, content: "network access is disabled in config (policy.networkEnabled=false)" };
      const url = str(args, "url").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, content: "url must start with http:// or https://" };
      const maxBytes = Math.min(Math.max(num(args, "maxBytes", 400_000), 1000), 4_000_000);
      try {
        const res = await fetch(url, {
          headers: { "user-agent": "manus-local/0.1 (+local agent)" },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });
        const type = res.headers.get("content-type") ?? "";
        const buf = Buffer.from(await res.arrayBuffer());
        const body = buf.subarray(0, maxBytes).toString("utf8");
        const isHtml = /text\/html|application\/xhtml/i.test(type);
        const text = isHtml ? htmlToText(body) : body;
        return {
          ok: res.ok,
          content: `HTTP ${res.status} ${type}\nurl=${url}\n\n${headOutput(text, 12_000)}`,
        };
      } catch (err) {
        return { ok: false, content: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
];
