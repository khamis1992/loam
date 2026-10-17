import { headOutput } from "../policy/commands.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { num, str } from "./registry.js";

function htmlToText(html: string): string {
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
    name: "web_fetch",
    description: "Fetch a URL and return readable text (HTML is converted to text). Requires networkEnabled in config.",
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
