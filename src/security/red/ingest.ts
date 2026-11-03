/**
 * Multi-tool findings ingestion (Supremacy M4.1): parse Nmap XML, Burp JSON,
 * Nessus CSV, and generic SARIF into the unified findings shape.
 */
import type { PentestFinding } from "../../tools/pentest.js";

export interface IngestedFinding extends PentestFinding {
  source: "nmap" | "burp" | "nessus" | "sarif";
  rawTool: string;
}

/** Parse Nmap XML output into findings (service version → CVE lead). */
export function parseNmapXml(xml: string): IngestedFinding[] {
  const out: IngestedFinding[] = [];
  for (const host of xml.matchAll(/<host[^>]*>[\s\S]*?<\/host>/g)) {
    const addrMatch = /<address\s+addr="([^"]+)"/.exec(host[0]!);
    const addr = addrMatch?.[1] ?? "unknown";
    for (const port of host[0]!.matchAll(/<port\s+portid="(\d+)"[^>]*>[\s\S]*?<\/port>/g)) {
      const portNum = port[1]!;
      const service = /<service\s+([^>]*)\/?>/.exec(port[0]!);
      if (!service) continue;
      const attrs = service[1]!;
      const name = /name="([^"]*)"/.exec(attrs)?.[1];
      const product = /product="([^"]*)"/.exec(attrs)?.[1];
      const version = /version="([^"]*)"/.exec(attrs)?.[1];
      out.push({
        id: `nmap-${addr}-${portNum}`,
        check: "red_ingest_nmap",
        verdict: "info",
        severity: "info",
        title: `${name ?? "unknown"} on ${addr}:${portNum}`,
        target: `${addr}:${portNum}`,
        detail: `Service: ${name ?? "?"}${product ? `, product: ${product}` : ""}${version ? `, version: ${version}` : ""}`,
        source: "nmap",
        rawTool: "nmap",
      });
    }
  }
  return out;
}

/** Parse Burp Suite exported JSON issues. */
export function parseBurpJson(raw: string): IngestedFinding[] {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return []; }
  const issues = (doc as { issues?: unknown[] }).issues ?? (Array.isArray(doc) ? doc : []);
  const out: IngestedFinding[] = [];
  for (const issue of issues) {
    const o = issue as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    const severity = typeof o.severity === "string" ? o.severity.toLowerCase() : "info";
    out.push({
      id: `burp-${o.name}-${String(o.url ?? "")}`,
      check: "red_ingest_burp",
      verdict: "finding",
      severity: (["critical", "high", "medium", "low", "info"].includes(severity) ? severity : "info") as PentestFinding["severity"],
      title: o.name,
      target: String(o.url ?? ""),
      detail: String(o.detail ?? o.description ?? ""),
      source: "burp",
      rawTool: "burp",
    });
  }
  return out;
}

/** Parse Nessus CSV export. */
export function parseNessusCsv(csv: string): IngestedFinding[] {
  const out: IngestedFinding[] = [];
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return out;
  const header = lines[0]!.split(",").map((h) => h.trim().replace(/"/g, ""));
  const idx = (name: string) => header.indexOf(name);
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const name = cells[idx("Name")] ?? cells[idx("Plugin Name")] ?? "";
    if (!name) continue;
    const severityStr = (cells[idx("Risk")] ?? cells[idx("Severity")] ?? "info").toLowerCase();
    out.push({
      id: `nessus-${name}-${cells[idx("Host")] ?? ""}`,
      check: "red_ingest_nessus",
      verdict: "finding",
      severity: (["critical", "high", "medium", "low", "info"].includes(severityStr) ? severityStr : "info") as PentestFinding["severity"],
      title: name,
      target: String(cells[idx("Host")] ?? ""),
      detail: String(cells[idx("Description")] ?? cells[idx("Synopsis")] ?? ""),
      source: "nessus",
      rawTool: "nessus",
    });
  }
  return out;
}

/** Parse generic SARIF 2.1.0. */
export function parseSarif(raw: string): IngestedFinding[] {
  let doc: { runs?: Array<{ results?: Array<{ ruleId?: string; level?: string; message?: { text?: string }; locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string } } }> }> }> };
  try { doc = JSON.parse(raw); } catch { return []; }
  const out: IngestedFinding[] = [];
  for (const run of doc.runs ?? []) {
    for (const result of run.results ?? []) {
      const ruleId = result.ruleId ?? "unknown";
      const level = result.level === "error" ? "high" : result.level === "warning" ? "medium" : "info";
      const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "";
      out.push({
        id: `sarif-${ruleId}-${uri}`,
        check: `red_ingest_sarif_${ruleId.replace(/[^\w]/g, "_")}`,
        verdict: "finding",
        severity: level as PentestFinding["severity"],
        title: result.message?.text?.split("\n")[0] ?? ruleId,
        target: uri,
        detail: result.message?.text ?? "",
        source: "sarif",
        rawTool: "sarif",
      });
    }
  }
  return out;
}

/** Dispatch by format name. */
export function ingestFindings(raw: string, format: "nmap" | "burp" | "nessus" | "sarif"): IngestedFinding[] {
  switch (format) {
    case "nmap": return parseNmapXml(raw);
    case "burp": return parseBurpJson(raw);
    case "nessus": return parseNessusCsv(raw);
    case "sarif": return parseSarif(raw);
  }
}
