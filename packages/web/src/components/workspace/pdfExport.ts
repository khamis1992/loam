/** Shared "تصدير PDF" helper for the workspace office editors (Wave C).
 * Fetches the Office-native PDF endpoint for the edited file and downloads it
 * as <name>.pdf. The server renders through Word/Excel/PowerPoint on Windows;
 * on failure it surfaces the server's Arabic message. */

const ENDPOINTS: Record<string, string> = {
  doc: "/api/workspace/doc/pdf",
  sheet: "/api/workspace/sheet/pdf",
  slides: "/api/workspace/slides/pdf",
};

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("loam-local-token") ?? "" : "";
  const headers: Record<string, string> = {};
  if (token) headers["x-loam-local-token"] = token;
  return headers;
}

export async function exportWorkspacePdf(
  kind: "doc" | "sheet" | "slides",
  taskId: string,
  path: string,
): Promise<{ ok: true; filename: string; bytes: number } | { ok: false; error: string }> {
  const endpoint = ENDPOINTS[kind];
  if (!endpoint) return { ok: false, error: "نوع غير مدعوم لتصدير PDF." };
  try {
    const res = await fetch(`${endpoint}?taskId=${encodeURIComponent(taskId)}&path=${encodeURIComponent(path)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      let message = `تعذّر التصدير (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch { /* non-JSON error */ }
      return { ok: false, error: message };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const base = path.split("/").pop() ?? "export";
    a.href = url;
    a.download = `${base.replace(/\.(docx|xlsx|pptx)$/i, "")}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { ok: true, filename: a.download, bytes: blob.size };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
