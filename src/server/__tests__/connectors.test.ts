/**
 * Connectors (OPB) unit tests — ALL fetch is mocked; no real provider network
 * calls or sign-ins happen here.
 *
 * Covered:
 *  - auth URL carries PKCE (S256 challenge) + state
 *  - callback validates state, exchanges the code, seals tokens ENCRYPTED via secretsVault
 *  - expired tokens refresh through the token endpoint and are re-sealed
 *  - connector tools send the bearer token; write tools require approval first
 *  - connector tools enter the effective run tool list only while connected
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { describe, it, before, after, beforeEach } from "node:test";

import type { Tool, ToolRegistry } from "../../tools/registry.js";

let tmpDir = "";
let closeDb: () => void;
let oauth: typeof import("../connectors/oauth.js");
let githubProvider: typeof import("../connectors/providers/github.js");
let googleProvider: typeof import("../connectors/providers/google.js");
let connectorsIndex: typeof import("../connectors/index.js");
let connectorToolsMod: typeof import("../../tools/connectorTools.js");
let routesMod: typeof import("../routes/connectors.js");
let vaultMod: typeof import("../secretsVault.js");
let approvalsMod: typeof import("../approvals.js");
let registry: ToolRegistry;
let resolveCompanionCapabilities: typeof import("../companionGateway.js").resolveCompanionCapabilities;
let COMPANION_DYNAMIC_TOOL_NAMES: string[];
let mergeAlwaysOnTools: typeof import("../runTools.js").mergeAlwaysOnTools;

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
let fetchCalls: FetchCall[] = [];
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  } as unknown as Response;
}

const realFetch = globalThis.fetch;
function installFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    fetchCalls.push({ url, method: String(init?.method ?? "GET"), headers, body: typeof init?.body === "string" ? init.body : "" });
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

function mockRes(): { statusCode: number; body: string; writeHead: (s: number, h?: unknown) => void; end: (b?: unknown) => void } {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number): void { res.statusCode = status; },
    end(chunk?: unknown): void { res.body = typeof chunk === "string" ? chunk : JSON.stringify(chunk ?? ""); },
  };
  return res;
}

function mockReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, url, headers, socket: {} } as unknown as http.IncomingMessage;
}

function dummy(name: string): Tool {
  return { name, description: "test tool", parameters: { type: "object", properties: {} }, async run() { return { ok: true, content: "" }; } };
}

function toolCtx(): { ctx: import("../../tools/registry.js").ToolContext; emitted: Array<{ type: string; tool?: string; approvalId?: string }> } {
  const emitted: Array<{ type: string; tool?: string; approvalId?: string }> = [];
  return {
    ctx: { cfg: {} as never, workspace: tmpDir, emit: (e) => { emitted.push(e as never); }, taskId: "task_test" },
    emitted,
  };
}

async function connectGithub(): Promise<void> {
  const { authUrl, state } = oauth.buildAuthUrl(githubProvider.githubConnector, "http://127.0.0.1:8787/api/connectors/github/callback");
  assert.ok(authUrl.includes("state=" + state));
  const params = new URLSearchParams({ code: "gh-code", state });
  await oauth.completeCallback("github", params);
}

async function connectGmail(): Promise<void> {
  const { state } = oauth.buildAuthUrl(googleProvider.gmailConnector, "http://127.0.0.1:8787/api/connectors/gmail/callback");
  const params = new URLSearchParams({ code: "google-code", state });
  await oauth.completeCallback("gmail", params);
}

/** Compose the run tool list exactly like index.ts executeTask does now. */
function buildRunToolSet(agent: { disabledTools?: string[] } = {}): { gatewayAllow: string[]; tools: ToolRegistry } {
  const capabilities = resolveCompanionCapabilities({
    mode: "build",
    workMode: "loam",
    disabledTools: agent.disabledTools,
    registeredTools: [...registry.names(), ...COMPANION_DYNAMIC_TOOL_NAMES],
  });
  const runAllow = mergeAlwaysOnTools({
    resolvedAllow: [...capabilities.allow, ...connectorsIndex.connectedConnectorToolNames(agent.disabledTools)],
    registeredTools: registry.names(),
    disabledTools: agent.disabledTools,
  });
  return { gatewayAllow: capabilities.allow, tools: registry.forAllowlist(runAllow) };
}

describe("connectors (OAuth + agent tools)", () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loam-connectors-"));
    process.env.MANUS_LOCAL_DATA_DIR = tmpDir;
    process.env.LOAM_GITHUB_CLIENT_ID = "gh-client-id";
    process.env.LOAM_GITHUB_CLIENT_SECRET = "gh-client-secret";
    process.env.LOAM_GOOGLE_CLIENT_ID = "goog-client-id";
    process.env.LOAM_GOOGLE_CLIENT_SECRET = "goog-client-secret";

    const sqlite = await import("../sqliteStore.js");
    closeDb = sqlite.closeDb;
    oauth = await import("../connectors/oauth.js");
    githubProvider = await import("../connectors/providers/github.js");
    googleProvider = await import("../connectors/providers/google.js");
    connectorsIndex = await import("../connectors/index.js");
    connectorToolsMod = await import("../../tools/connectorTools.js");
    routesMod = await import("../routes/connectors.js");
    vaultMod = await import("../secretsVault.js");
    approvalsMod = await import("../approvals.js");
    const gatewayMod = await import("../companionGateway.js");
    resolveCompanionCapabilities = gatewayMod.resolveCompanionCapabilities;
    COMPANION_DYNAMIC_TOOL_NAMES = gatewayMod.COMPANION_DYNAMIC_TOOL_NAMES;
    mergeAlwaysOnTools = (await import("../runTools.js")).mergeAlwaysOnTools;

    const { ToolRegistry: Registry } = await import("../../tools/registry.js");
    registry = new Registry();
    for (const name of ["file_read", "file_write", "shell_run", "web_fetch", "loam_mobile"]) registry.register(dummy(name));
    registry.registerAll(connectorToolsMod.createConnectorTools());
  });

  after(() => {
    globalThis.fetch = realFetch;
    closeDb();
    for (const k of ["LOAM_GITHUB_CLIENT_ID", "LOAM_GITHUB_CLIENT_SECRET", "LOAM_GOOGLE_CLIENT_ID", "LOAM_GOOGLE_CLIENT_SECRET"]) delete process.env[k];
    delete process.env.MANUS_LOCAL_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    fetchCalls = [];
  });

  it("lists env-var names when unconfigured; connect 400s with them", async () => {
    const res = mockRes();
    const handled = await routesMod.handleConnectorsRoutes(mockReq("GET", "/api/connectors"), res as unknown as http.ServerResponse, "/api/connectors");
    assert.ok(handled);
    const list = JSON.parse(res.body) as { connectors: Array<{ id: string; configured: boolean; envVars: string[] }> };
    assert.equal(list.connectors.length, 3);
    const cal = list.connectors.find((c) => c.id === "calendar")!;
    assert.deepEqual(cal.envVars, ["LOAM_GOOGLE_CLIENT_ID", "LOAM_GOOGLE_CLIENT_SECRET"]);

    // calendar stays unconfigured in this test
    delete process.env.LOAM_GOOGLE_CLIENT_ID;
    const res2 = mockRes();
    await routesMod.handleConnectorsRoutes(mockReq("POST", "/api/connectors/calendar/connect"), res2 as unknown as http.ServerResponse, "/api/connectors/calendar/connect");
    const body2 = JSON.parse(res2.body) as { error: string; envVars?: string[] };
    assert.equal(res2.statusCode, 400);
    assert.equal(body2.error, "Not configured");
    assert.deepEqual(body2.envVars, ["LOAM_GOOGLE_CLIENT_ID", "LOAM_GOOGLE_CLIENT_SECRET"]);
    process.env.LOAM_GOOGLE_CLIENT_ID = "goog-client-id";
  });

  it("auth URL contains PKCE S256 challenge and state; routes connect returns authUrl", async () => {
    const res = mockRes();
    installFetch(async () => jsonResponse(200, {}));
    const req = mockReq("POST", "/api/connectors/github/connect", { host: "127.0.0.1:8787" });
    const handled = await routesMod.handleConnectorsRoutes(req, res as unknown as http.ServerResponse, "/api/connectors/github/connect");
    assert.ok(handled);
    assert.equal(res.statusCode, 200);
    const { authUrl } = JSON.parse(res.body) as { authUrl: string };
    const u = new URL(authUrl);
    assert.equal(u.origin + u.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.ok((u.searchParams.get("code_challenge") ?? "").length >= 43, "PKCE challenge present");
    assert.ok((u.searchParams.get("state") ?? "").length >= 16, "state present");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("client_id"), "gh-client-id");
    assert.equal(u.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/api/connectors/github/callback");
  });

  it("callback exchanges the code and stores the token ENCRYPTED via secretsVault", async () => {
    installFetch(async (url) => {
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return jsonResponse(200, { access_token: "gh-secret-token", token_type: "bearer", expires_in: 3600 });
      }
      if (url.startsWith("https://api.github.com/user")) {
        return jsonResponse(200, { login: "octocat" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { state } = oauth.buildAuthUrl(githubProvider.githubConnector, "http://127.0.0.1:8787/api/connectors/github/callback");
    const res = mockRes();
    const req = mockReq("GET", `/api/connectors/github/callback?code=the-code&state=${state}`, { host: "127.0.0.1:8787" });
    const handled = await routesMod.handleConnectorsRoutes(req, res as unknown as http.ServerResponse, "/api/connectors/github/callback");
    assert.ok(handled);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /connected as octocat/i);

    // The code exchange sent PKCE verifier + client secret to the token endpoint.
    const tokenCall = fetchCalls.find((c) => c.url.startsWith("https://github.com/login/oauth/access_token"))!;
    assert.equal(tokenCall.method, "POST");
    const form = new URLSearchParams(tokenCall.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "the-code");
    assert.ok((form.get("code_verifier") ?? "").length >= 43, "PKCE verifier sent on exchange");
    assert.equal(form.get("client_secret"), "gh-client-secret");

    // Token stored encrypted: vault file exists and NEVER contains plaintext.
    const vaultFile = path.join(tmpDir, "secrets-vault", "connector-github.json");
    assert.ok(fs.existsSync(vaultFile), "sealed vault file written");
    const raw = fs.readFileSync(vaultFile, "utf8");
    assert.ok(!raw.includes("gh-secret-token"), "token is not stored in plaintext");
    assert.ok(!raw.includes("gh-client-secret"), "client secret never stored");
    const unsealed = vaultMod.resolveSecret("connector-github", "tokens");
    assert.ok(unsealed);
    assert.equal((JSON.parse(unsealed) as { access_token: string }).access_token, "gh-secret-token");

    assert.ok(oauth.isConnected("github"));
    assert.equal(oauth.getAccount("github"), "octocat");
  });

  it("rejects a callback whose state was never issued", async () => {
    installFetch(async () => jsonResponse(200, {}));
    await assert.rejects(
      oauth.completeCallback("github", new URLSearchParams({ code: "x", state: "bogus-state" })),
      /invalid or expired OAuth state/,
    );
  });

  it("expired access tokens are refreshed and re-sealed", async () => {
    installFetch(async (url, init) => {
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (form.get("grant_type") === "refresh_token") {
          assert.equal(form.get("refresh_token"), "gh-refresh");
          return jsonResponse(200, { access_token: "gh-new", token_type: "bearer", expires_in: 3600 });
        }
        return jsonResponse(200, { access_token: "gh-old", refresh_token: "gh-refresh", token_type: "bearer", expires_in: 1 });
      }
      if (url.startsWith("https://api.github.com/user")) return jsonResponse(200, { login: "octocat" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    oauth.disconnect("github");
    await connectGithub(); // ends with expires_in=1 → practically expired
    const expired = JSON.parse(vaultMod.resolveSecret("connector-github", "tokens")!) as { access_token: string };
    assert.equal(expired.access_token, "gh-old");
    const token = await oauth.getAccessToken(githubProvider.githubConnector);
    assert.equal(token, "gh-new", "refreshed token returned");
    const refreshed = JSON.parse(vaultMod.resolveSecret("connector-github", "tokens")!) as { access_token: string; refresh_token?: string };
    assert.equal(refreshed.access_token, "gh-new");
    assert.equal(refreshed.refresh_token, "gh-refresh", "refresh token kept when provider omits a new one");
    const refreshCall = fetchCalls.find((c) => new URLSearchParams(c.body).get("grant_type") === "refresh_token")!;
    assert.ok(refreshCall, "token endpoint called with grant_type=refresh_token");
  });

  it("read tools send the bearer token", async () => {
    installFetch(async (url) => {
      if (url.startsWith("https://api.github.com/user/repos")) {
        return jsonResponse(200, [{ full_name: "octocat/hello", private: false, description: "demo", updated_at: "2026-10-01T00:00:00Z" }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { ctx } = toolCtx();
    const tool = registry.get("github_list_repos")!;
    const result = await tool.run({}, ctx);
    assert.ok(result.ok, result.content);
    assert.match(result.content, /octocat\/hello/);
    const call = fetchCalls[0]!;
    assert.equal(call.headers.authorization, "Bearer gh-new");
  });

  it("gmail read tool works while gmail is connected; calendar stays disconnected", async () => {
    installFetch(async (url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse(200, { access_token: "goog-token", refresh_token: "goog-refresh", expires_in: 3600, token_type: "Bearer" });
      }
      if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return jsonResponse(200, { email: "me@example.com" });
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1")) {
        return jsonResponse(200, {
          id: "msg-1",
          payload: {
            headers: [{ name: "From", value: "a@b.c" }, { name: "Subject", value: "Hi" }],
            body: { data: Buffer.from("plain body text", "utf8").toString("base64url") },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await connectGmail();
    assert.equal(oauth.getAccount("gmail"), "me@example.com");
    const { ctx } = toolCtx();
    const read = registry.get("gmail_read")!;
    const res = await read.run({ id: "msg-1" }, ctx);
    assert.ok(res.ok, res.content);
    assert.match(res.content, /plain body text/);
    const msgCall = fetchCalls.find((c) => c.url.includes("/messages/msg-1"))!;
    assert.equal(msgCall.headers.authorization, "Bearer goog-token");
    assert.ok(!oauth.isConnected("calendar"));
  });

  it("write tools require approval: denied does nothing, approved calls the API with bearer", async () => {
    installFetch(async (url) => {
      if (url.startsWith("https://api.github.com/repos/octocat/hello/issues")) {
        return jsonResponse(201, { number: 7, html_url: "https://github.com/octocat/hello/issues/7" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { ctx, emitted } = toolCtx();
    const create = registry.get("github_create_issue")!;

    // Deny path — no API call happens.
    const denied = create.run({ repo: "octocat/hello", title: "Bug" }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    const pend = approvalsMod.listApprovals(true).find((a) => a.tool === "github_create_issue")!;
    assert.ok(pend, "approval registered");
    assert.deepEqual(emitted.map((e) => e.type), ["approval_required"]);
    approvalsMod.decideApproval(pend.id, "deny");
    const deniedResult = await denied;
    assert.equal(deniedResult.ok, false);
    assert.ok(!fetchCalls.some((c) => c.method === "POST"), "denied write sends nothing");

    // Approve path — the issue POST carries the bearer token.
    const approved = create.run({ repo: "octocat/hello", title: "Bug", body: "details" }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    const pend2 = approvalsMod.listApprovals(true).find((a) => a.tool === "github_create_issue")!;
    approvalsMod.decideApproval(pend2.id, "approve");
    const okResult = await approved;
    assert.ok(okResult.ok, okResult.content);
    assert.match(okResult.content, /#7/);
    const post = fetchCalls.find((c) => c.method === "POST")!;
    assert.equal(post.headers.authorization, "Bearer gh-new");
    const sent = JSON.parse(post.body) as { title: string };
    assert.equal(sent.title, "Bug");
  });

  it("connector tools reach the effective run tool list only while connected", () => {
    oauth.disconnect("github");
    const disconnected = buildRunToolSet();
    assert.ok(!disconnected.gatewayAllow.includes("github_list_repos"), "not a mode-catalog tool; gateway alone must not include it");
    assert.ok(!disconnected.tools.names().includes("github_list_repos"), "disconnected connector tools stay hidden from the model");
    assert.ok(!disconnected.tools.names().includes("calendar_create_event"));

    // gmail is connected from an earlier case → its tools are visible, others are not.
    assert.ok(disconnected.tools.names().includes("gmail_read"), "connected connector tools are exposed");
    const modelNames = disconnected.tools.toOllama().map((t) => t.function.name);
    assert.ok(modelNames.includes("gmail_search"));

    const { state } = oauth.buildAuthUrl(githubProvider.githubConnector, "http://127.0.0.1:8787/api/connectors/github/callback");
    // synchronous exposure check needs the connection recorded; connect via the stored token path instead:
    void state;
    const connectedNames = connectorsIndex.connectedConnectorToolNames();
    assert.ok(connectedNames.includes("gmail_read"));
    assert.ok(!connectedNames.includes("github_create_issue"));

    // per-agent denial still removes a connected connector tool
    const denied = buildRunToolSet({ disabledTools: ["gmail_read"] });
    assert.ok(!denied.tools.names().includes("gmail_read"), "agent denial wins over connector grant");
    assert.ok(denied.tools.names().includes("file_read"), "gateway tools survive");
  });

  it("disconnect clears sealed tokens and connection state", () => {
    assert.ok(oauth.isConnected("gmail"));
    oauth.disconnect("gmail");
    assert.ok(!oauth.isConnected("gmail"));
    assert.equal(vaultMod.resolveSecret("connector-gmail", "tokens"), null);
    assert.ok(!buildRunToolSet().tools.names().includes("gmail_read"));
  });
});
