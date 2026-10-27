/** Swarm + Security + Data companion tools (service integration).
 * Bridges SwarmService runs, security assessments, and data charts to the
 * companion gateway so companions can use the app's real services. */
import type { Tool, ToolResult } from "./registry.js";
import { str, num } from "./registry.js";

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown> | { error: string }> {
  const port = Number(process.env.MANUS_LOCAL_PORT ?? 3939);
  const token = process.env.LOAM_LOCAL_TOKEN ?? "";
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { "x-loam-local-token": token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { error: String(data.error ?? data.message ?? `HTTP ${res.status}`) };
    return data;
  } catch (err) {
    return { error: `Service unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function createSwarmTools(): Tool[] {
  return [
    {
      name: "swarm_run",
      description: "أنشئ مشروع سرب (شركة برمجيات كاملة: تخطيط → تنفيذ → مراجعة → اختبار) لمهمة برمجية. تابع النتيجة بـ swarm_status.",
      parameters: {
        type: "object",
        properties: {
          brief: { type: "string", description: "وصف المشروع المطلوب (المستخدمون والوظائف)" },
          concurrency: { type: "integer", minimum: 1, maximum: 4, description: "عدد المسارات المتوازية" },
          effort: { type: "string", enum: ["auto", "solo", "lite", "full"], description: "حجم الفريق: auto يختار تلقائيًا (الطلب الصغير يذهب لوكيل واحد)" },
        },
        required: ["brief"],
      },
      async run(args): Promise<ToolResult> {
        // BUILD_SPEC §4: the agent tool sends the recommended lifecycle profile; approval stays
        // "auto" here because a tool call has no approval card (the swarm UI asks for approval).
        const effort = typeof args.effort === "string" && ["auto", "solo", "lite", "full"].includes(args.effort) ? args.effort : "auto";
        const res = await api("POST", "/api/swarm/runs", { brief: str(args, "brief"), concurrency: num(args, "concurrency", 2), effort, intake: "off", approval: "auto", review: "two-stage", taskGraph: true, spec: "ears", projectGuide: true, webResearch: true, visualGate: "advisory" });
        if ("error" in res) return { ok: false, content: String(res.error) };
        const run = (res as { run?: { id: string } }).run;
        return { ok: true, content: `بدأ السرب (${run?.id ?? "?"}) — شركة برمجيات كاملة تعمل. تابعه بـ swarm_status ثم اجلب النتائج.` };
      },
    },
    {
      name: "swarm_status",
      description: "تابع حالة مشروع السرب: المرحلة الحالية، التقدم، المخرجات.",
      parameters: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
      async run(args): Promise<ToolResult> {
        const res = await api("GET", `/api/swarm/runs/${encodeURIComponent(str(args, "runId"))}`);
        if ("error" in res) return { ok: false, content: String(res.error) };
        const runData = res as { run?: { status?: string; stage?: string; nodes?: Array<{ id: string; status: string }> } };
        const nodes = runData.run?.nodes ?? [];
        return { ok: true, content: `الحالة: ${runData.run?.status ?? "?"} • المرحلة: ${runData.run?.stage ?? "?"} • العقد: ${nodes.map((n) => `${n.id}=${n.status}`).join(", ") || "لا عقد بعد"}` };
      },
    },
  ];
}

export function createSecurityTools(): Tool[] {
  return [
    {
      name: "security_assess",
      description: "ابدأ تقييمًا أمنيًا لهدف مصرّح به (فحص رؤوس + كوكيز + ملفات مكشوفة + CORS…). يعيد معرف التقييم.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "URL الهدف المصرّح به (مثل http://127.0.0.1:3000)" },
          checks: { type: "array", items: { type: "string" }, description: "قائمة الفحوص (افتراضي: الكل)" },
        },
        required: ["target"],
      },
      async run(args): Promise<ToolResult> {
        const res = await api("POST", "/api/security/assessments", { target: str(args, "target"), checks: args.checks ?? "all" });
        if ("error" in res) return { ok: false, content: String(res.error) };
        const assessment = (res as { assessment?: { id: string } }).assessment;
        return { ok: true, content: `بدأ التقييم (${assessment?.id ?? "?"}) — تابعه بـ security_status ثم اجلب التقرير.` };
      },
    },
    {
      name: "security_status",
      description: "تابع حالة التقييم الأمني: الفحوص المكتملة والنتائج.",
      parameters: { type: "object", properties: { assessmentId: { type: "string" } }, required: ["assessmentId"] },
      async run(args): Promise<ToolResult> {
        const res = await api("GET", `/api/security/assessments/${encodeURIComponent(str(args, "assessmentId"))}`);
        if ("error" in res) return { ok: false, content: String(res.error) };
        const a = res as unknown as { assessment?: { status?: string; checks?: Array<{ check: string; verdict: string; severity?: string }> } };
        const checks = a.assessment?.checks ?? [];
        const summary = checks.slice(0, 8).map((c) => `${c.check}: ${c.verdict}${c.severity ? ` (${c.severity})` : ""}`).join(" • ");
        return { ok: true, content: `الحالة: ${a.assessment?.status ?? "?"} • ${summary || "لا فحوص بعد"}` };
      },
    },
  ];
}

export function createDataChartTools(): Tool[] {
  return [
    {
      name: "data_chart",
      description: "أنشئ رسمًا بيانيًا SVG من بيانات CSV في مساحة المهمة (أعمدة/خطوط/دائري) — قابل للعرض في الاستوديو والتصدير.",
      parameters: {
        type: "object",
        properties: {
          csvPath: { type: "string", description: "مسار ملف CSV" },
          chartType: { type: "string", enum: ["bar", "line", "pie"], description: "نوع الرسم (افتراضي bar)" },
          title: { type: "string", description: "عنوان الرسم" },
          outputPath: { type: "string", description: "مسار الإخراج (افتراضي chart.svg)" },
        },
        required: ["csvPath"],
      },
      async run(args, ctx): Promise<ToolResult> {
        const csvPath = str(args, "csvPath");
        const chartType = str(args, "chartType", "bar");
        const title = str(args, "title", "Chart");
        const outputPath = str(args, "outputPath", "chart.svg");
        // Read the CSV using the existing file tool
        const fileRead = ctx.cfg ? undefined : undefined; // We'll use direct file reading
        const fs = await import("node:fs");
        const path = await import("node:path");
        const fullPath = path.join(ctx.workspace, csvPath);
        if (!fs.existsSync(fullPath)) return { ok: false, content: `CSV غير موجود: ${csvPath}` };
        const csv = fs.readFileSync(fullPath, "utf8");
        const rows = csv.trim().split(/\r?\n/).map((l) => l.split(","));
        if (rows.length < 2) return { ok: false, content: "CSV يحتاج رؤوسًا وصفًا واحدًا على الأقل" };
        const headers = rows[0]!;
        const data: Array<Array<string | number>> = rows.slice(1).map((r) => r.map((cell) => (Number.isFinite(Number(cell)) ? Number(cell) : cell)));

        // Generate SVG based on chart type
        const W = 600, H = 400, M = 50;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f8f9fa"/><text x="${W / 2}" y="30" text-anchor="middle" font-size="18" font-weight="bold" fill="#333">${title}</text>`;
        if (chartType === "bar") {
          const bw = (W - 2 * M) / data.length;
          const maxVal = Math.max(...data.map((d) => Number(d[1]) || 0), 1);
          data.forEach((d, i) => {
            const h = ((Number(d[1]) || 0) / maxVal) * (H - 2 * M - 40);
            svg += `<rect x="${M + i * bw + 5}" y="${H - M - h}" width="${bw - 10}" height="${h}" fill="#4f7d5c" rx="4"/><text x="${M + i * bw + bw / 2}" y="${H - M + 15}" text-anchor="middle" font-size="11" fill="#666">${d[0]}</text><text x="${M + i * bw + bw / 2}" y="${H - M - h - 5}" text-anchor="middle" font-size="11" fill="#333">${d[1]}</text>`;
          });
        } else if (chartType === "line") {
          const step = (W - 2 * M) / Math.max(data.length - 1, 1);
          const maxVal = Math.max(...data.map((d) => Number(d[1]) || 0), 1);
          let points = data.map((d, i) => `${M + i * step},${H - M - ((Number(d[1]) || 0) / maxVal) * (H - 2 * M - 40)}`).join(" ");
          svg += `<polyline points="${points}" fill="none" stroke="#4f7d5c" stroke-width="2" stroke-linejoin="round"/>`;
          data.forEach((d, i) => { svg += `<circle cx="${M + i * step}" cy="${H - M - ((Number(d[1]) || 0) / maxVal) * (H - 2 * M - 40)}" r="4" fill="#4f7d5c"/><text x="${M + i * step}" y="${H - M + 15}" text-anchor="middle" font-size="11" fill="#666">${d[0]}</text>`; });
        } else if (chartType === "pie") {
          const total = data.reduce((a, d) => a + (Number(d[1]) || 0), 0) || 1;
          let angle = 0;
          const cx = W / 2, cy = (H + 30) / 2, r = 120;
          const colors = ["#4f7d5c", "#d4a853", "#8b6c9e", "#e07a5f", "#6a9fb5"];
          data.forEach((d, i) => {
            const frac = (Number(d[1]) || 0) / total;
            const endAngle = angle + frac * 2 * Math.PI;
            const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
            const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
            const large = frac > 0.5 ? 1 : 0;
            svg += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z" fill="${colors[i % colors.length]}" opacity="0.85"/>`;
            svg += `<text x="${cx + 1.3 * r * Math.cos((angle + endAngle) / 2)}" y="${cy + 1.3 * r * Math.sin((angle + endAngle) / 2)}" text-anchor="middle" font-size="11" fill="#333">${d[0]}: ${Math.round(frac * 100)}%</text>`;
            angle = endAngle;
          });
        }
        svg += `<line x1="${M}" y1="${H - M}" x2="${W - M}" y2="${H - M}" stroke="#ccc"/><line x1="${M}" y1="40" x2="${M}" y2="${H - M}" stroke="#ccc"/></svg>`;

        const outPath = path.join(ctx.workspace, outputPath);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, svg, "utf8");
        return { ok: true, content: `رُسم ${chartType} chart إلى ${outputPath} (${svg.length} بايت SVG) — افتحه من مساحة المهمة أو أدرجه في الاستوديو.` };
      },
    },
  ];
}

export const SWARM_TOOL_NAMES = ["swarm_run", "swarm_status"];
export const SECURITY_TOOL_NAMES = ["security_assess", "security_status"];
export const DATA_CHART_TOOL_NAMES = ["data_chart"];
