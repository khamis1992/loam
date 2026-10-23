/**
 * Ask-User-More card (Neo N9).
 *
 * Renders an `askUserRequested` chat event: the clarification the agent needs
 * (a headline, why it is asking, and one or more questions). Each question may
 * offer preset options and may accept a file upload. The user answers, attaches
 * files and submits; the run resumes with the answer attached as context.
 *
 * Files are uploaded first through `/api/upload?taskId=…&askUser=…` (which
 * places them under `<workspace>/uploads/<requestId>/`) and the recorded
 * workspace-relative path travels back on the `resolve_ask_user` socket action.
 */
import { useRef, useState } from "react";
import { CircleHelp, Loader2, MessageCircleQuestion, Paperclip, Upload, X, Check } from "lucide-react";
import { t } from "@/i18n/t";
import { getApiBase, getApiHeaders } from "@/services/rpc";
import type { AskUserRequested } from "./types";

/** One file the user attached to the card, before it is sent back. */
export interface AskUserAttachment {
  path: string;
  name: string;
  bytes: number;
  contentType: string;
}

export interface AskUserAnswerPayload {
  text: string;
  answers: Record<string, string>;
  files: AskUserAttachment[];
}

export interface AskUserCardProps {
  request: AskUserRequested;
  onRespond: (decision: "answer" | "dismiss", answer?: AskUserAnswerPayload) => void;
  /** Upload override for tests; defaults to the real `/api/upload` endpoint. */
  uploadFile?: (file: File) => Promise<AskUserAttachment>;
}

/** Upload one file for this request and return the recorded workspace path. */
async function defaultUpload(taskId: string, requestId: string, file: File): Promise<AskUserAttachment> {
  const params = new URLSearchParams({ taskId, name: file.name, askUser: requestId });
  const res = await fetch(`${getApiBase()}/api/upload?${params.toString()}`, {
    method: "POST",
    headers: await getApiHeaders(),
    body: file,
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? t("Upload failed"));
  }
  const body = (await res.json()) as { path?: string; name?: string; bytes?: number };
  return {
    path: body.path ?? "",
    name: body.name ?? file.name,
    bytes: typeof body.bytes === "number" ? body.bytes : file.size,
    contentType: file.type || "application/octet-stream",
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The auto-trigger's headline and reason are localized on the client from
 * `reasonCode` (the server only stores an English fallback), so an Arabic user
 * reads Arabic and an English user reads English. A model-raised request is
 * shown verbatim: the model already wrote it in the user's language.
 */
function cardText(request: AskUserRequested): { title: string; reason: string } {
  if (request.source !== "auto") return { title: request.title, reason: request.reason };
  const title = t("Before I start, I need one clarification");
  switch (request.reasonCode) {
    case "missing_context":
      return { title, reason: t("This request refers to something no earlier task or file in this conversation identifies.") };
    case "ambiguous_target":
      return { title, reason: t("The action is clear but the target is not, so the run could change the wrong thing.") };
    case "vague":
      return { title, reason: t("This request is short and open-ended, so the goal and the target are not pinned down.") };
    default:
      return { title, reason: request.reason };
  }
}

export function AskUserCard({ request, onRespond, uploadFile }: AskUserCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<AskUserAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [decided, setDecided] = useState<"answered" | "dismissed" | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setAnswer = (id: string, value: string) => setAnswers((prev) => ({ ...prev, [id]: value }));

  const pickFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    setError(undefined);
    try {
      const uploaded: AskUserAttachment[] = [];
      for (const file of Array.from(list).slice(0, 8)) {
        uploaded.push(
          uploadFile
            ? await uploadFile(file)
            : await defaultUpload(request.taskId, request.requestId, file),
        );
      }
      setFiles((prev) => [...prev, ...uploaded].slice(0, 8));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Upload failed"));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const submit = () => {
    if (decided || uploading) return;
    const answered = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    if (Object.keys(answered).length === 0 && !note.trim() && files.length === 0) {
      setError(t("Answer at least one question or add a file."));
      return;
    }
    setDecided("answered");
    onRespond("answer", { text: note.trim(), answers: answered, files });
  };

  const dismiss = () => {
    if (decided) return;
    setDecided("dismissed");
    onRespond("dismiss");
  };

  if (decided) {
    return (
      <div role="group" aria-label={t("Clarification")} className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu p-4 shadow-card">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          {decided === "answered" ? (
            <Check className="size-4 text-func-success" aria-hidden />
          ) : (
            <X className="size-4" aria-hidden />
          )}
          {decided === "answered" ? t("Answer sent") : t("Clarification dismissed")}
        </div>
      </div>
    );
  }

  const btnBase = "h-row-sm rounded-control px-3 text-sm font-medium transition-colors";
  const fileAllowed = request.questions.some((q) => q.allowFile);
  const text = cardText(request);

  return (
    <div role="group" aria-label={t("Clarification")} className="max-w-[560px] rounded-card border border-[0.5px] border-border-dark bg-bg-menu shadow-card">
      <div className="flex items-center gap-2 border-b border-border-main px-4 py-3 text-sm font-medium text-text-primary">
        <MessageCircleQuestion className="size-5" aria-hidden />
        {text.title || t("Clarification")}
      </div>
      <div className="space-y-4 p-4">
        {text.reason && <p className="text-sm text-text-secondary">{text.reason}</p>}
        {request.questions.map((q) => (
          <div key={q.id} className="space-y-2">
            <div className="flex items-start gap-1.5 text-sm text-text-primary">
              <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden />
              <span>{q.prompt}</span>
            </div>
            {q.options && q.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((option) => {
                  const active = (answers[q.id] ?? "") === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setAnswer(q.id, active ? "" : option)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        active
                          ? "border-border-dark bg-text-primary text-text-onblack"
                          : "border-border-main bg-transparent text-text-secondary hover:bg-fill-hover"
                      }`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            )}
            <input
              type="text"
              aria-label={q.prompt}
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswer(q.id, e.target.value)}
              className="w-full rounded-control border border-border-main bg-fill-tsp-white-light px-3 py-2 text-sm text-text-primary outline-none focus:border-border-dark"
            />
          </div>
        ))}

        <div className="space-y-2">
          <label className="text-xs text-text-tertiary" htmlFor="ask-user-note">
            {t("Anything else I should know?")}
          </label>
          <textarea
            id="ask-user-note"
            aria-label={t("Anything else I should know?")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="w-full rounded-control border border-border-main bg-fill-tsp-white-light p-3 text-sm text-text-primary outline-none focus:border-border-dark"
          />
        </div>

        {fileAllowed && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className={`${btnBase} inline-flex items-center border border-border-main bg-transparent text-text-primary hover:bg-fill-hover disabled:opacity-60`}
            >
              {uploading ? <Loader2 className="me-1 inline size-3.5 animate-spin" aria-hidden /> : <Paperclip className="me-1 inline size-3.5" aria-hidden />}
              {uploading ? t("Uploading") : t("Add a file")}
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              aria-label={t("Add a file")}
              onChange={(e) => void pickFiles(e.target.files)}
            />
            {files.length > 0 && (
              <ul className="space-y-1">
                {files.map((file) => (
                  <li key={file.path} className="flex items-center gap-2 text-xs text-text-secondary">
                    <Upload className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{file.name}</span>
                    <span className="text-text-tertiary">{formatBytes(file.bytes)}</span>
                    <button
                      type="button"
                      aria-label={t("Remove {name}", { name: file.name })}
                      onClick={() => setFiles((prev) => prev.filter((f) => f.path !== file.path))}
                      className="ms-auto text-text-tertiary hover:text-text-primary"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <p className="text-xs text-func-danger">{error}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border-main px-4 py-3">
        <button
          type="button"
          onClick={dismiss}
          className={`${btnBase} border border-border-main bg-transparent text-text-primary hover:bg-fill-hover`}
        >
          <X className="me-1 inline size-3.5" aria-hidden />
          {t("Dismiss")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={uploading}
          className={`${btnBase} bg-text-primary text-text-onblack hover:opacity-90 disabled:opacity-60`}
        >
          <Check className="me-1 inline size-3.5" aria-hidden />
          {t("Send answer")}
        </button>
      </div>
    </div>
  );
}
