import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { CodeGraphAudit } from "./audit.js";
import { GRAPHIFY_MCP_ALLOWLIST, type CodeGraphConfig, type GraphifyAllowedTool } from "./config.js";
import { buildChildEnv } from "./env.js";
import { engineExecutables, mcpCwd } from "./paths.js";

export interface RawToolReply { text: string; isError: boolean; durationMs: number }

/**
 * One long-lived graphify MCP server (stdio) for ALL projects.
 *
 * Started with cwd = an empty directory, so graphify finds no default graph
 * and runs as a "pure multi-project server" (OBSERVED graphify/serve.py:2283-2288).
 * Every call carries project_path = the Loam store dir for the active project;
 * graphify resolves <project_path>/graphify-out/graph.json (OBSERVED :2267-2275)
 * and reloads it when (mtime_ns, size) changes (OBSERVED :170-197), so a
 * re-index never needs a server restart.
 *
 * Tools outside GRAPHIFY_MCP_ALLOWLIST are never callable, whatever the server lists.
 */
export class GraphifyMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private starting: Promise<void> | null = null;
  private available = new Set<GraphifyAllowedTool>();

  constructor(private readonly deps: { cfg: CodeGraphConfig; home: string; audit: CodeGraphAudit }) {}

  get connected(): boolean {
    return this.client !== null;
  }

  availableTools(): GraphifyAllowedTool[] {
    return [...this.available];
  }

  async ensureStarted(): Promise<void> {
    if (this.client) return;
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    const exe = engineExecutables(this.deps.home);
    if (!fs.existsSync(exe.graphifyMcp)) throw new Error("graphify-mcp is not installed");
    const cwd = mcpCwd(this.deps.home);
    fs.mkdirSync(cwd, { recursive: true });
    // Keep the cwd empty: a stray graphify-out/ here would become a default graph.
    for (const entry of fs.readdirSync(cwd)) fs.rmSync(path.join(cwd, entry), { recursive: true, force: true });
    const env = buildChildEnv({ pathPrepend: [path.dirname(exe.graphifyMcp)], maxWarmGraphs: this.deps.cfg.maxWarmGraphs });
    const transport = new StdioClientTransport({ command: exe.graphifyMcp, args: [], cwd, env, stderr: "pipe" });
    transport.stderr?.on("data", () => {}); // drain (same reason as loam src/tools/mcp.ts:83-84)
    const client = new Client({ name: "loam-codegraph", version: "1.0.0" }, { capabilities: {} });
    const t0 = Date.now();
    try {
      await client.connect(transport, { timeout: this.deps.cfg.mcpStartupTimeoutMs });
      const listed = await client.listTools({}, { timeout: this.deps.cfg.mcpStartupTimeoutMs });
      const names = new Set(listed.tools.map((t) => t.name));
      this.available = new Set(GRAPHIFY_MCP_ALLOWLIST.filter((n) => names.has(n)));
      const missing = GRAPHIFY_MCP_ALLOWLIST.filter((n) => !names.has(n));
      const extra = [...names].filter((n) => !(GRAPHIFY_MCP_ALLOWLIST as readonly string[]).includes(n) && !["list_prs", "get_pr_impact", "triage_prs"].includes(n));
      if (missing.length || extra.length) {
        this.deps.audit.write({ event: "codegraph.mcp.catalogue-drift", detail: `missing=${missing.join(",")} extra=${extra.join(",")}` });
        log.warn(`codegraph: graphify catalogue drift missing=[${missing}] extra=[${extra}]`);
      }
      this.client = client;
      this.transport = transport;
      transport.onclose = () => { this.client = null; this.transport = null; this.deps.audit.write({ event: "codegraph.mcp.disconnect" }); };
      this.deps.audit.write({ event: "codegraph.mcp.connect", durationMs: Date.now() - t0, detail: `${this.available.size} tools` });
    } catch (err) {
      try { await client.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
      throw err;
    }
  }

  /** Call an allowlisted tool against one project store. `project_path` from the caller is always overwritten. */
  async call(tool: GraphifyAllowedTool, args: Record<string, unknown>, storeDir: string): Promise<RawToolReply> {
    if (!(GRAPHIFY_MCP_ALLOWLIST as readonly string[]).includes(tool)) throw new Error(`tool not allowlisted: ${tool}`);
    await this.ensureStarted();
    if (!this.available.has(tool)) throw new Error(`graphify server does not offer ${tool}`);
    const client = this.client;
    if (!client) throw new Error("graphify server disconnected");
    const { project_path: _ignored, ...rest } = args;
    const t0 = Date.now();
    const res = (await client.callTool(
      { name: tool, arguments: { ...rest, project_path: storeDir } },
      undefined,
      { timeout: this.deps.cfg.queryTimeoutMs },
    )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    const text = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n").trim();
    return { text: text || "(no content)", isError: res.isError === true, durationMs: Date.now() - t0 };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    try { await c?.close(); } catch { /* ignore */ }
    try { await this.transport?.close(); } catch { /* ignore */ }
    this.transport = null;
  }
}
