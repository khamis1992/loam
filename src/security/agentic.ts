export interface AgenticEvent {
  kind: "prompt" | "tool" | "memory" | "rag" | "approval" | "cost" | "audit";
  source?: "user" | "document" | "tool-output" | "memory";
  content?: string;
  actorTenantId?: string;
  dataTenantId?: string;
  tool?: string;
  allowedTools?: string[];
  requesterId?: string;
  approverId?: string;
  cost?: number;
  budget?: number;
  privileged?: boolean;
  logged?: boolean;
}

export interface AgenticFinding {
  category: "prompt-injection" | "tool-abuse" | "tenant-isolation" | "self-approval" | "data-exfiltration" | "resource-exhaustion" | "audit-gap";
  status: "finding" | "review";
  detail: string;
}

const injection = /ignore (?:all|previous)|system prompt|override instructions|تجاهل التعليمات|كشف الأسرار/i;
const secrets = /api[-_]?key|bearer\s+[a-z0-9_-]{8,}|password\s*[:=]|private key/i;

export function evaluateAgenticEvent(event: AgenticEvent): AgenticFinding[] {
  const findings: AgenticFinding[] = [];
  if (event.content && injection.test(event.content)) findings.push({ category: "prompt-injection", status: "finding", detail: `Potential ${event.source === "user" ? "direct" : "indirect"} instruction override` });
  if (event.content && secrets.test(event.content)) findings.push({ category: "data-exfiltration", status: "finding", detail: "Secret-shaped content requires an exfiltration review" });
  if (event.kind === "tool" && event.tool && (!event.allowedTools || !event.allowedTools.includes(event.tool))) findings.push({ category: "tool-abuse", status: "finding", detail: "Tool invocation is outside the declared allowlist" });
  if (["memory", "rag"].includes(event.kind) && event.actorTenantId && event.dataTenantId && event.actorTenantId !== event.dataTenantId) findings.push({ category: "tenant-isolation", status: "finding", detail: "Memory or retrieval crosses tenant boundaries" });
  if (event.kind === "approval" && event.requesterId && event.requesterId === event.approverId) findings.push({ category: "self-approval", status: "finding", detail: "Agent approved its own privileged action" });
  if (event.kind === "cost" && event.cost !== undefined && event.budget !== undefined && event.cost > event.budget) findings.push({ category: "resource-exhaustion", status: "finding", detail: "Agent action exceeds its cost budget" });
  if (event.kind === "audit" && event.privileged && event.logged === false) findings.push({ category: "audit-gap", status: "finding", detail: "Privileged action has no audit record" });
  if (event.kind === "tool" && event.tool && event.allowedTools?.includes(event.tool) && findings.length === 0) findings.push({ category: "tool-abuse", status: "review", detail: "Tool is allowed; validate its arguments and side effects separately" });
  return findings;
}
