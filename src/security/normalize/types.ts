/**
 * The single normalizer contract (ALL_SERVICES §Shared-data-model): every scanner —
 * external engine or first-party — funnels through here into one RawFinding shape,
 * then enrichFinding() → SecurityFinding[] → sarif() into the one report viewer.
 * Output from any scanned target or engine is untrusted data, never instructions.
 */

export type Engine =
  | "secrets" | "sca" | "sast" | "config" | "supplychain"
  | "recon" | "llm" | "mcp" | "mobile" | "re" | "fuzz" | "aixcc";

export type RawSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface RawFinding {
  engine: Engine;
  ruleId: string;
  severity: RawSeverity;
  /** file:line | url | pkg@ver | binary#addr */
  target: string;
  title: string;
  detail: string;
  remediation?: string;
  /** Evidence artifacts referenced from protocol/blobStore. */
  evidenceBlobIds?: string[];
  /** e.g. trufflehog-style live verification verdict. */
  verified?: boolean;
  properties?: Record<string, unknown>;
}

export interface Normalizer {
  /** One adapter per engine; input is the engine's raw output, coerced and bounded. */
  adapt(raw: unknown): RawFinding[];
}

/** Tool name → unified engine, for adapters that receive tool-tagged records. */
export const ENGINE_BY_TOOL: Record<string, Engine> = {
  "loam-secrets": "secrets", gitleaks: "secrets",
  "loam-sca": "sca", osv: "sca", trivy: "sca",
  "loam-pkg": "supplychain", guarddog: "supplychain",
  opengrep: "sast",
  checkov: "config", kics: "config", dockle: "config",
  httpx: "recon", subfinder: "recon",
  garak: "llm", promptfoo: "llm",
  "mcp-scanner": "mcp", "agent-scan": "mcp",
  mobsf: "mobile",
};

export const engineForTool = (tool: string | undefined | null): Engine =>
  (tool && ENGINE_BY_TOOL[tool]) || "sast";
