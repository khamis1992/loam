import fs from "node:fs";
import { createHash } from "node:crypto";
import type { RawFinding } from "../normalize/types.js";
import type { MobileArtifact } from "./artifacts.js";

export interface MobsfIssue {
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  file?: string;
  description?: string;
  ruleId?: string;
}

export function mobsfToFindings(issues: MobsfIssue[], apk = "app.apk"): RawFinding[] {
  return issues.map((issue) => ({
    engine: "mobile" as const,
    ruleId: issue.ruleId ?? "mobsf.issue",
    severity: issue.severity,
    target: issue.file ? `${apk}:${issue.file}` : apk,
    title: issue.title,
    detail: issue.description ?? "",
    remediation: "Review the affected mobile control and verify the repair with a MASVS retest.",
  }));
}

export interface MobileScanOptions {
  enabled: boolean;
  issues?: MobsfIssue[];
}

export function mobileScan(opt: MobileScanOptions): RawFinding[] {
  if (!opt.enabled) return [];
  return mobsfToFindings(opt.issues ?? []);
}

export type MobileEngineStatus = "covered" | "partial" | "error" | "unavailable";

export interface MobileArtifactScanResult {
  artifact: MobileArtifact;
  status: MobileEngineStatus;
  findings: RawFinding[];
  detail?: string;
  engineVersion?: string;
  reportSha256?: string;
}

interface MobSfClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchFn?: typeof fetch;
}

const normalizeSeverity = (value: unknown): MobsfIssue["severity"] => {
  const severity = String(value ?? "info").toLowerCase();
  return severity === "critical" || severity === "high" || severity === "medium" || severity === "low" ? severity : "info";
};

export function mobsfReportToIssues(report: unknown): MobsfIssue[] {
  const issues: MobsfIssue[] = [];
  const visited = new Set<object>();
  const visit = (value: unknown, depth: number, inheritedFile?: string): void => {
    if (depth > 10 || issues.length >= 5000 || !value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, inheritedFile);
      return;
    }
    const record = value as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : typeof record.rule === "string" ? record.rule : "";
    const severity = record.severity ?? record.level ?? record.risk;
    const description = typeof record.description === "string" ? record.description : typeof record.detail === "string" ? record.detail : typeof record.message === "string" ? record.message : "";
    const file = typeof record.file === "string" ? record.file : inheritedFile;
    if (title && severity !== undefined) {
      issues.push({
        title: title.slice(0, 300),
        severity: normalizeSeverity(severity),
        description: description.slice(0, 4000),
        ...(file ? { file: file.slice(0, 500) } : {}),
        ...(typeof record.ruleId === "string" ? { ruleId: record.ruleId.slice(0, 200) } : typeof record.id === "string" ? { ruleId: record.id.slice(0, 200) } : {}),
      });
    }
    for (const [key, nested] of Object.entries(record)) {
      if (["title", "name", "rule", "severity", "level", "risk", "description", "detail", "message"].includes(key)) continue;
      visit(nested, depth + 1, key === "files" && Array.isArray(nested) ? undefined : file);
    }
  };
  visit(report, 0);
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.ruleId ?? ""}\n${issue.title}\n${issue.file ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class MobSfClient {
  private readonly base: URL;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: MobSfClientOptions) {
    this.base = new URL(options.baseUrl);
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(this.base.hostname);
    if ((this.base.protocol !== "https:" && !loopback) || (this.base.protocol !== "https:" && this.base.protocol !== "http:")) throw new Error("MobSF requires HTTPS, except for a loopback lab");
    if (this.base.username || this.base.password) throw new Error("MobSF URL must not contain credentials");
    if (this.base.search || this.base.hash) throw new Error("MobSF base URL must not contain query or fragment");
    if (!options.apiKey.trim()) throw new Error("MobSF API key is required");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 30_000_000;
  }

  private endpoint(suffix: string): string {
    return new URL(`${this.base.pathname.replace(/\/$/, "")}${suffix}`, this.base.origin).href;
  }

  private async request(suffix: string, init: RequestInit): Promise<{ json: unknown; raw: string }> {
    const response = await this.fetchFn(this.endpoint(suffix), {
      ...init,
      redirect: "error",
      headers: { "x-mobsf-api-key": this.options.apiKey, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > this.maxResponseBytes) throw new Error("MobSF response exceeds the configured limit");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > this.maxResponseBytes) {
          await reader.cancel();
          throw new Error("MobSF response exceeds the configured limit");
        }
        chunks.push(value);
      }
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!response.ok) throw new Error(`MobSF returned HTTP ${response.status}`);
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new Error("MobSF returned malformed JSON"); }
    return { json, raw };
  }

  async scan(artifact: MobileArtifact): Promise<MobileArtifactScanResult> {
    if (artifact.kind === "aab") return { artifact, status: "error", findings: [], detail: "AAB requires a dedicated adapter or an APK derived by the authorized build pipeline" };
    try {
      const bytes = await fs.promises.readFile(artifact.path);
      const form = new FormData();
      form.append("file", new Blob([bytes]), artifact.relativePath.split("/").at(-1));
      const upload = await this.request("/api/v1/upload", { method: "POST", body: form });
      const hash = (upload.json as { hash?: unknown }).hash;
      if (typeof hash !== "string" || !hash) throw new Error("MobSF upload did not return a scan hash");
      const body = (value: Record<string, string>): string => new URLSearchParams(value).toString();
      await this.request("/api/v1/scan", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body({ hash }) });
      const report = await this.request("/api/v1/report_json", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body({ hash }) });
      if (!report.json || typeof report.json !== "object" || Array.isArray(report.json)) throw new Error("MobSF report is not an object");
      const issues = mobsfReportToIssues(report.json);
      const version = (report.json as { mobsf_version?: unknown; version?: unknown }).mobsf_version ?? (report.json as { version?: unknown }).version;
      return {
        artifact,
        status: "covered",
        findings: mobsfToFindings(issues, artifact.relativePath),
        engineVersion: typeof version === "string" ? version.slice(0, 100) : "unknown",
        reportSha256: createHash("sha256").update(report.raw).digest("hex"),
      };
    } catch (error) {
      return { artifact, status: "unavailable", findings: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }
}

export async function runMobileScan(artifacts: MobileArtifact[], client: MobSfClient): Promise<MobileArtifactScanResult[]> {
  const results: MobileArtifactScanResult[] = [];
  for (const artifact of artifacts) results.push(await client.scan(artifact));
  return results;
}
