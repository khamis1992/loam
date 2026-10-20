/**
 * Local execution approval card (BUILD_SPEC §7.2.2 / §5.9 S19).
 *
 * Handles terminal, file and workspace approval requests. All user-visible
 * strings match the spec; the component does not perform side effects.
 */
import { Terminal, FileText, Folder, Laptop, Cloud, Smartphone, ShieldAlert } from "lucide-react";
import { t } from "@/i18n/t";
import type { LocalExecutionApprovalRequested } from "./types";

export interface ExecutionApprovalCardProps {
  request: LocalExecutionApprovalRequested;
  onResolve: (resolution: "approve" | "deny") => void;
}

export function ExecutionApprovalCard({ request, onResolve }: ExecutionApprovalCardProps) {
  const { detail } = request;

  const headerTitle =
    detail.kind === "terminal"
      ? t("Run a local command")
      : detail.kind === "file"
        ? t("Modify a local file")
        : t("Folder access request");

  return (
    <div className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-0 shadow-card">
      <div className="flex items-center gap-2 border-b border-border-main px-4 py-3 text-sm font-medium text-text-primary">
        {detail.kind === "terminal" && <Terminal className="size-5" aria-hidden />}
        {detail.kind === "file" && <FileText className="size-5" aria-hidden />}
        {detail.kind === "workspace" && <Folder className="size-5" aria-hidden />}
        {headerTitle}
      </div>

      <div className="space-y-3 p-4">
        {request.summary && (
          <p className="text-sm text-text-secondary">{request.summary}</p>
        )}

        {detail.kind === "terminal" && (
          <div className="rounded-control border border-border-main bg-fill-tsp-white-light p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">Bash</span>
              <span className="rounded-full bg-fill-tsp-white-dark px-2 py-0.5 text-[11px] text-text-secondary">
                {t("write access")}
              </span>
            </div>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-sm text-text-primary">
              {detail.command}
            </pre>
            {detail.cwd && (
              <div className="mt-2 font-mono text-xs text-text-tertiary">{detail.cwd}</div>
            )}
          </div>
        )}

        {detail.kind === "file" && (
          <div className="rounded-control border border-border-main bg-fill-tsp-white-light p-3">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-text-secondary" aria-hidden />
              <span className="font-mono text-sm text-text-primary">{detail.path}</span>
            </div>
            <div className="mt-1 text-xs text-text-tertiary">{detail.operation}</div>
          </div>
        )}

        {detail.kind === "workspace" && (
          <div className="rounded-control border border-border-main bg-fill-tsp-white-light p-3">
            <div className="flex items-center gap-2">
              <DeviceIcon deviceType={detail.deviceId.startsWith("sandbox:") ? "cloud" : "desktop"} />
              <span className="text-sm text-text-primary">
                {detail.deviceId.startsWith("sandbox:") ? t("Temporary cloud computer") : detail.deviceId}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Folder className="size-4 text-text-secondary" aria-hidden />
              <span className="font-mono text-sm text-text-primary">{detail.requestedPath}</span>
            </div>
          </div>
        )}

        {detail.kind === "terminal" && detail.flaggedReason && (
          <div className="flex items-start gap-2 text-sm text-function-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t("Flagged by the local safety rule: {reason}", { reason: detail.flaggedReason })}</span>
          </div>
        )}

        {detail.kind === "terminal" && (
          <p className="text-xs text-text-tertiary">
            {t("Allowing lets this command keep running; {product} can view it, interact with it, and stop it while it runs.")}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border-main px-4 py-3">
        <button
          type="button"
          onClick={() => onResolve("deny")}
          className="h-row-sm rounded-control border border-border-main bg-transparent px-3 text-sm font-medium text-text-primary hover:bg-fill-hover"
        >
          {t("Deny")}
        </button>
        <button
          type="button"
          onClick={() => onResolve("approve")}
          className="h-row-sm rounded-control bg-text-primary px-3 text-sm font-medium text-text-onblack hover:opacity-90"
        >
          {t("Allow once")}
        </button>
      </div>
    </div>
  );
}

function DeviceIcon({ deviceType }: { deviceType: "cloud" | "desktop" }) {
  if (deviceType === "cloud") return <Cloud className="size-4 text-text-secondary" aria-hidden />;
  if (deviceType === "desktop") return <Laptop className="size-4 text-text-secondary" aria-hidden />;
  return <Smartphone className="size-4 text-text-secondary" aria-hidden />;
}
