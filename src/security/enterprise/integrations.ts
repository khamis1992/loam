import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface RemediationTicket {
  findingId: string;
  owner: string;
  slaDueAt: string;
  acceptanceExpiresAt?: string;
  retestStatus?: "fixed" | "persistent" | "inconclusive";
}

export function validateRemediation(ticket: RemediationTicket): void {
  if (!ticket.owner.trim() || !Number.isFinite(Date.parse(ticket.slaDueAt))) throw new Error("remediation owner and valid SLA are required");
  if (ticket.acceptanceExpiresAt && Date.parse(ticket.acceptanceExpiresAt) <= Date.now() && ticket.retestStatus !== "fixed") throw new Error("risk acceptance expired; fixed retest required");
}

export function canCloseRemediation(ticket: RemediationTicket): boolean {
  validateRemediation(ticket);
  return ticket.retestStatus === "fixed";
}

interface IntegrationOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function endpoint(value: string, allowedHosts: string[]): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || !["https:", "http:"].includes(url.protocol)) throw new Error("integration endpoints require HTTPS outside loopback");
  if (!loopback && !allowedHosts.includes(url.hostname)) throw new Error("integration host is not allowlisted");
  if (url.username || url.password) throw new Error("integration URL must not contain credentials");
  return url.href;
}

async function request(url: string, init: RequestInit, options: IntegrationOptions): Promise<unknown> {
  const response = await (options.fetchFn ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  const text = (await response.text()).slice(0, 1_000_000);
  if (!response.ok) throw new Error(`integration returned HTTP ${response.status}`);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

export class IntegrationDedupeStore {
  constructor(private readonly root: string) {}

  claim(tenantId: string, findingId: string, integration: string): boolean {
    const dir = path.join(this.root, tenantId);
    fs.mkdirSync(dir, { recursive: true });
    const id = createHash("sha256").update(`${findingId}\n${integration}`).digest("hex");
    try {
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ findingId, integration, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
}

export class JiraIntegration {
  constructor(private readonly options: IntegrationOptions & { baseUrl: string; project: string; token: string; allowedHosts: string[] }) {}

  async createFinding(input: { findingId: string; title: string; description: string }): Promise<{ id: string; reference: string }> {
    const base = new URL(this.options.baseUrl);
    const url = endpoint(new URL(`${base.pathname.replace(/\/$/, "")}/rest/api/2/issue`, base.origin).href, this.options.allowedHosts);
    const result = await request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: { project: { key: this.options.project }, summary: input.title.slice(0, 250), description: input.description.slice(0, 30_000), issuetype: { name: "Bug" }, labels: [`loam-${input.findingId.slice(0, 40)}`] } }),
    }, this.options) as { id?: string; key?: string };
    return { id: result.id ?? "", reference: result.key ?? "" };
  }
}

export class GitHubIntegration {
  constructor(private readonly options: IntegrationOptions & { owner: string; repo: string; token: string; baseUrl?: string }) {}

  async createFinding(input: { findingId: string; title: string; description: string }): Promise<{ id: string; reference: string }> {
    const base = this.options.baseUrl ?? "https://api.github.com";
    const url = endpoint(new URL(`/repos/${this.options.owner}/${this.options.repo}/issues`, base).href, ["api.github.com"]);
    const result = await request(url, {
      method: "POST",
      headers: { authorization: `token ${this.options.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ title: input.title.slice(0, 250), body: `${input.description.slice(0, 60_000)}\n\nLoam finding: ${input.findingId}`, labels: ["security", "loam"] }),
    }, this.options) as { id?: number; number?: number };
    return { id: String(result.id ?? ""), reference: String(result.number ?? "") };
  }
}

export class SlackIntegration {
  constructor(private readonly options: IntegrationOptions & { webhookUrl: string }) {}

  async notify(text: string): Promise<void> {
    const url = endpoint(this.options.webhookUrl, ["hooks.slack.com"]);
    await request(url, { method: "POST", headers: { "content-type": "application/json", "x-loam-event": randomBytes(12).toString("hex") }, body: JSON.stringify({ text: text.slice(0, 30_000) }) }, this.options);
  }
}
