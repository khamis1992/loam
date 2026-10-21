/**
 * Approval cards (option 14).
 *
 * `ApprovalCard` renders a Loam tool approval (computer_* gate) arriving as a
 * `localExecutionApprovalRequested` chat event: tool name, human summary and an
 * args preview, with Approve once / Always allow for this agent / Deny wired to
 * the existing approval resolution path. It enriches itself from the Loam
 * approval record (GET /api/approvals/:id) which carries the args preview.
 *
 * `FolderAccessApprovalCard` keeps the workspace folder-access flow.
 */
import { useEffect, useState } from "react";
import { Folder, Lock, ShieldCheck, X } from "lucide-react";
import { t } from "@/i18n/t";
import { getApiBase, getApiHeaders } from "@/services/rpc";
import type { FolderAccessRequestEvent, LocalExecutionApprovalRequested } from "./types";

export type ApprovalRespond = "deny" | "once" | "always";

interface ApprovalRecordShape {
  id: string;
  tool?: string;
  summary?: string;
  argsPreview?: string;
  status?: string;
}

export interface ApprovalCardProps {
  request: LocalExecutionApprovalRequested;
  onRespond: (decision: ApprovalRespond) => void;
}

function prettyPreview(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function ApprovalCard({ request, onRespond }: ApprovalCardProps) {
  const [record, setRecord] = useState<ApprovalRecordShape | undefined>(undefined);
  const [decided, setDecided] = useState<"approved" | "denied" | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/approvals/${encodeURIComponent(request.requestId)}`, {
          headers: await getApiHeaders(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { approval?: ApprovalRecordShape };
        if (mounted) setRecord(data.approval);
      } catch {
        // Offline: the event's own fields stay the fallback.
      }
    })();
    return () => { mounted = false; };
  }, [request.requestId]);

  const toolName =
    record?.tool ??
    (request.detail.kind === "terminal" ? request.detail.command : `${request.detail.kind}`);
  const summary = request.summary || record?.summary || "";
  const argsPreview = prettyPreview(record?.argsPreview);

  const respond = (decision: ApprovalRespond) => {
    if (decided) return;
    setDecided(decision === "deny" ? "denied" : "approved");
    onRespond(decision);
  };

  if (decided) {
    return (
      <div role="group" aria-label={t("Approval request")} className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-4 shadow-card">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <ShieldCheck className={`size-4 ${decided === "approved" ? "text-func-success" : ""}`} aria-hidden />
          {t("Decided")}
        </div>
      </div>
    );
  }

  const btnBase = "h-row-sm rounded-control px-3 text-sm font-medium transition-colors";
  return (
    <div role="group" aria-label={t("Approval request")} className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu shadow-card">
      <div className="flex items-center gap-2 border-b border-border-main px-4 py-3 text-sm font-medium text-text-primary">
        <ShieldCheck className="size-5" aria-hidden />
        {t("Approval request")}
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-tertiary">{t("Tool")}</span>
          <code className="break-all text-xs text-text-primary">{toolName}</code>
        </div>
        {summary && <p className="text-sm text-text-secondary">{summary}</p>}
        {argsPreview && (
          <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-control border border-border-main bg-fill-tsp-white-light p-3 font-mono text-xs text-text-primary">
            {argsPreview}
          </pre>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border-main px-4 py-3">
        <button type="button" onClick={() => respond("deny")} className={`${btnBase} border border-border-main bg-transparent text-text-primary hover:bg-fill-hover`}>
          {t("Deny")}
        </button>
        <button type="button" onClick={() => respond("once")} className={`${btnBase} border border-border-main bg-transparent text-text-primary hover:bg-fill-hover`}>
          {t("Approve once")}
        </button>
        <button
          type="button"
          onClick={() => respond("always")}
          className={`${btnBase} bg-text-primary text-text-onblack hover:opacity-90`}
          title={t("Always allow for this agent")}
        >
          {t("Always allow for this agent")}
        </button>
      </div>
    </div>
  );
}

export interface FolderAccessApprovalCardProps {
  request: FolderAccessRequestEvent;
  onRespond: (decision: "deny" | "once" | "always") => void;
}

export function FolderAccessApprovalCard({ request, onRespond }: FolderAccessApprovalCardProps) {
  return (
    <div
      role="group"
      aria-label={t("Folder access request")}
      className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-4 shadow-card"
    >
      <div className="flex items-center gap-2 text-title-base text-text-primary">
        <Lock className="size-4" aria-hidden />
        {t("Folder access request")}
      </div>
      <div className="mt-1 flex items-center gap-2 text-sm text-text-secondary">
        <Folder className="size-4" aria-hidden />
        <code className="break-all text-xs">{request.path}</code>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => onRespond("deny")}
          className="h-row-sm rounded-control border border-border-main bg-transparent px-3 text-sm font-medium text-text-primary hover:bg-fill-hover"
        >
          {t("Deny")}
        </button>
        <button
          type="button"
          onClick={() => onRespond("once")}
          className="h-row-sm rounded-control bg-bg-menu px-3 text-sm font-medium text-text-primary shadow-card hover:bg-fill-hover"
        >
          {t("Allow once")}
        </button>
        <button
          type="button"
          onClick={() => onRespond("always")}
          className="h-row-sm rounded-control bg-text-primary px-3 text-sm font-medium text-text-onblack hover:opacity-90"
        >
          {t("Always allow in {product}")}
        </button>
      </div>
    </div>
  );
}
