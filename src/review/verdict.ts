export type ParsedVerdict =
  | { status: "lgtm" }
  | { status: "findings"; findings: string[] }
  | { status: "error"; error: string };

export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function parseVerdict(raw: string, maxFindings: number, maxChars: number): ParsedVerdict {
  const text = stripThink(raw);
  const match = text.match(/VERDICT:\s*(LGTM|FINDINGS)/i);
  if (!match) return { status: "error", error: "missing verdict" };
  if (match[1]!.toUpperCase() === "LGTM") return { status: "lgtm" };
  const findings: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s*(?:\d+[\).\]]|[-*])\s+(.+)$/);
    if (!item) continue;
    const body = item[1]!.trim();
    if (body.length === 0) continue;
    findings.push(body);
    if (findings.length >= maxFindings) break;
  }
  let joined = findings.join("\n");
  if (joined.length > maxChars) {
    joined = joined.slice(0, maxChars);
    return { status: "findings", findings: joined.split("\n").filter(Boolean).slice(0, maxFindings) };
  }
  return { status: "findings", findings };
}
