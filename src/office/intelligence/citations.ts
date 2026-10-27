import { createHash } from "node:crypto";
import type { ArtifactRef, SourceAnchor, SourceAnchorKind } from "./contracts.js";

export function hashSourceText(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").replace(/\r\n?/g, "\n")).digest("hex");
}

export function createSourceAnchor(input: {
  artifact: ArtifactRef;
  kind: SourceAnchorKind;
  anchor: string;
  text: string;
}): SourceAnchor {
  const excerpt = input.text.trim().replace(/\s+/g, " ").slice(0, 500);
  const id = createHash("sha256")
    .update(`${input.artifact.taskId}|${input.artifact.path}|${input.artifact.revision}|${input.kind}|${input.anchor}`)
    .digest("hex")
    .slice(0, 24);
  return {
    id: `src_${id}`,
    artifact: input.artifact,
    kind: input.kind,
    anchor: input.anchor,
    excerpt,
    contentHash: hashSourceText(excerpt),
  };
}

export type CitationVerification = "valid" | "stale" | "missing" | "changed";

export function verifySourceAnchor(
  anchor: SourceAnchor,
  current: { artifact: ArtifactRef; text: string } | undefined,
): CitationVerification {
  if (!current) return "missing";
  if (
    current.artifact.taskId !== anchor.artifact.taskId ||
    current.artifact.path !== anchor.artifact.path ||
    current.artifact.tenantId !== anchor.artifact.tenantId
  ) return "missing";
  if (current.artifact.revision !== anchor.artifact.revision || current.artifact.contentHash !== anchor.artifact.contentHash) return "stale";
  return hashSourceText(current.text) === anchor.contentHash ? "valid" : "changed";
}

export function verifyCitations(
  citations: SourceAnchor[],
  resolve: (anchor: SourceAnchor) => { artifact: ArtifactRef; text: string } | undefined,
): { valid: SourceAnchor[]; rejected: Array<{ anchor: SourceAnchor; reason: CitationVerification }> } {
  const valid: SourceAnchor[] = [];
  const rejected: Array<{ anchor: SourceAnchor; reason: CitationVerification }> = [];
  for (const citation of citations) {
    const reason = verifySourceAnchor(citation, resolve(citation));
    if (reason === "valid") valid.push(citation);
    else rejected.push({ anchor: citation, reason });
  }
  return { valid, rejected };
}
