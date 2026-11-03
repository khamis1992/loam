/** Summary-first response budget for REA tools — REA_INTO_LOAM_INTEGRATION §9
 *  (appendix A2). Replaces the registry's generic 16,000-char cut for
 *  `mcp__rea__*` results: small results pass through; paging tools keep up to the
 *  hard cap; everything else collapses to a structured preview that points the
 *  agent at `inspect_analysis_view` / `get_evidence_bundle` instead of flooding
 *  the conversation with JSON. Pure functions — mcp.ts applies them. */
import { REA_PAGING_TOOLS, REA_RESULT_BUDGET_BYTES, REA_RESULT_HARD_CAP_BYTES } from "./reaAllowlist.js";

export interface ReaBudgetOutcome {
  content: string;
  truncated: boolean;
  originalBytes: number;
}

const PREVIEW_CHARS = 8_192;
const unqualified = (tool: string): string => tool.replace(/^mcp__rea__/, "");

/** Apply the §9 budget to a successful tool result's content. */
export function applyReaBudget(tool: string, content: string): ReaBudgetOutcome {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= REA_RESULT_BUDGET_BYTES) {
    return { content, truncated: false, originalBytes: bytes };
  }
  // Paging tools are designed for large payloads: keep them up to the hard cap.
  if (REA_PAGING_TOOLS.has(unqualified(tool)) && bytes <= REA_RESULT_HARD_CAP_BYTES) {
    return { content, truncated: false, originalBytes: bytes };
  }
  if (REA_PAGING_TOOLS.has(unqualified(tool))) {
    const capped = `${content.slice(0, REA_RESULT_HARD_CAP_BYTES)}\n[rea budget: truncated at ${REA_RESULT_HARD_CAP_BYTES} bytes of ${bytes} — request a narrower page via offset/limit]`;
    return { content: capped, truncated: true, originalBytes: bytes };
  }
  // Summary-first: swap the flood for a preview + next pointer.
  const preview = content.slice(0, PREVIEW_CHARS);
  return {
    content: JSON.stringify({
      truncated: true,
      original_bytes: bytes,
      preview,
      next: "Result kept server-side. Call mcp__rea__inspect_analysis_view (or mcp__rea__get_evidence_bundle) with the evidence id from the preview to page the retained record.",
    }),
    truncated: true,
    originalBytes: bytes,
  };
}
