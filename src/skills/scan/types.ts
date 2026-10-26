// src/skills/scan/types.ts — Cap C contract (MISSING §6.5 reference, tested on the box)
export type ScanSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ScanCategory = "prompt_injection" | "tool_abuse" | "exfiltration" | "command_execution" | "persistence" | "obfuscation" | "unicode" | "secret" | "manifest";
export type ScanScope = "prose" | "code" | "any";

export interface ScanRule {
  id: string;                 // LS-XX00
  category: ScanCategory;
  severity: ScanSeverity;
  scope: ScanScope;           // prose = markdown outside code fences; code = code files + fenced blocks
  patterns: RegExp[];         // no /g flag; evaluated per line unless `multiline`
  htmlComments?: boolean;     // evaluate only against the inner text of <!-- … --> comments (found by a linear scan)
  title: string;
  titleAr: string;
  remediation: string;
}

export interface ScanFinding {
  ruleId: string; category: ScanCategory; severity: ScanSeverity;
  file: string; line: number | null; excerpt: string; title: string; titleAr: string; remediation: string;
}

export interface ScanOptions {
  failOn?: ScanSeverity;      // default "high"
  maxFiles?: number;          // default 200
  maxFileBytes?: number;      // default 512 KiB
  maxTotalBytes?: number;     // default 5 MiB
  skipRules?: string[];
}

export interface ScanReport {
  rulesetVersion: string;
  verdict: "pass" | "warn" | "fail";
  complete: boolean;
  files: number;
  bytes: number;
  stats: Record<ScanSeverity, number>;
  findings: ScanFinding[];
  contentHash: string;        // sha256 over sorted (relpath \0 sha256(file)) lines
}
