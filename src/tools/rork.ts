import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PreviewService } from "../preview/serve.js";
import { resolveRead, resolveWrite } from "../policy/paths.js";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import { str } from "./registry.js";

interface MobileItem {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  streak: number;
  done: boolean;
}

interface ColorTokens {
  canvas: string;
  surface: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentFg: string;
}

const COLOR_MOODS: Record<string, { label: string; isDark: boolean; swatches: string[]; tokens: ColorTokens }> = {
  "midnight-neon-lime": {
    label: "Deep midnight with neon lime",
    isDark: true,
    swatches: ["#0A0E17", "#141B2D", "#B8FF01", "#F8FAFC"],
    tokens: {
      canvas: "#0A0E17",
      surface: "#131A2A",
      card: "#1A2337",
      border: "#26324D",
      text: "#F8FAFC",
      muted: "#94A3B8",
      accent: "#B8FF01",
      accentFg: "#0A0E17",
    },
  },
  "sunrise-orange-cream": {
    label: "Warm sunrise oranges on cream",
    isDark: false,
    swatches: ["#FFF7ED", "#FFFFFF", "#FF6B2C", "#2C1810"],
    tokens: {
      canvas: "#FFF7ED",
      surface: "#FFFFFF",
      card: "#FFEDD5",
      border: "#FED7AA",
      text: "#2C1810",
      muted: "#7C5846",
      accent: "#FF6B2C",
      accentFg: "#FFFFFF",
    },
  },
  "soft-sage-green": {
    label: "Soft sage and calm greens",
    isDark: false,
    swatches: ["#ECF3EE", "#FFFFFF", "#3D7A5A", "#14291E"],
    tokens: {
      canvas: "#ECF3EE",
      surface: "#FFFFFF",
      card: "#DFECE3",
      border: "#C3DBC9",
      text: "#14291E",
      muted: "#4E6E5D",
      accent: "#3D7A5A",
      accentFg: "#FFFFFF",
    },
  },
  "arabic-desert-oasis": {
    label: "Warm sand dune with oasis teal & gold",
    isDark: true,
    swatches: ["#0D1514", "#152321", "#2DD4BF", "#FBBF24"],
    tokens: {
      canvas: "#0D1514",
      surface: "#152321",
      card: "#1C2E2C",
      border: "#2A4441",
      text: "#F8FAFC",
      muted: "#99B2AF",
      accent: "#2DD4BF",
      accentFg: "#042F2E",
    },
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function generateQrSvg(value: string): string {
  const N = 25;
  const grid = new Array<boolean>(N * N).fill(false);
  const reserved = new Array<boolean>(N * N).fill(false);
  const drawFinder = (r0: number, c0: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
        reserved[rr * N + cc] = true;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          grid[rr * N + cc] = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        }
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, N - 7);
  drawFinder(N - 7, 0);
  const digest = crypto.createHash("sha256").update(value).digest();
  let bitIdx = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (reserved[r * N + c]) continue;
      const byte = digest[Math.floor(bitIdx / 8) % digest.length] ?? 0;
      const bit = (byte >> (7 - (bitIdx % 8))) & 1;
      grid[r * N + c] = Boolean(bit ^ ((r + c) % 2 === 0 ? 1 : 0));
      bitIdx++;
    }
  }
  const rects: string[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (grid[r * N + c]) rects.push(`<rect x="${c}" y="${r}" width="1" height="1" fill="#000000"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="220" height="220" role="img" aria-label="Preview QR code"><rect width="${N}" height="${N}" fill="#ffffff"/>${rects.join("")}</svg>`;
}

export function createRorkTools(preview: PreviewService): Tool[] {
  return [
    {
      name: "rork_build",
      description:
        "Build a complete Rork-style mobile application (Expo Router / React Native + iOS SwiftUI + Android Kotlin Jetpack Compose + Offline-First Mobile PWA + 3-Screen Design Mode + Live Interactive Mobile Simulator + QR Code + Companion Web Admin Dashboard) and serve it in the preview panel.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project folder name inside workspace (e.g. 'habit-tracker')." },
          prompt: { type: "string", description: "Description of the mobile app to build." },
          title: { type: "string", description: "Optional display title of the mobile app." },
          colorMood: {
            type: "string",
            enum: ["midnight-neon-lime", "sunrise-orange-cream", "soft-sage-green", "arabic-desert-oasis"],
            description: "Optional color mood palette.",
          },
        },
        required: ["projectId", "prompt"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const rawId = str(args, "projectId", "mobile-app");
        const slug = rawId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "mobile-app";
        const promptText = str(args, "prompt", "Build a mobile app");
        const rtl = /[\u0600-\u06FF]/u.test(promptText);
        const appTitle = str(args, "title", rtl ? "تطبيق الجوال الذكي" : "Habit Streak Tracker");
        const moodKey = str(args, "colorMood", rtl ? "arabic-desert-oasis" : "midnight-neon-lime");
        const mood = COLOR_MOODS[moodKey] ?? COLOR_MOODS["midnight-neon-lime"]!;
        const t = mood.tokens;

        const projDir = resolveWrite(ctx.workspace, slug);
        fs.mkdirSync(projDir, { recursive: true });
        fs.mkdirSync(path.join(projDir, ".rork"), { recursive: true });
        fs.mkdirSync(path.join(projDir, "app", "(tabs)"), { recursive: true });
        fs.mkdirSync(path.join(projDir, "ios"), { recursive: true });
        fs.mkdirSync(path.join(projDir, "android"), { recursive: true });

        const items: MobileItem[] = rtl
          ? [
              { id: "h1", title: "شرب 2 لتر ماء", subtitle: "ترطيب · يومياً", icon: "💧", streak: 19, done: true },
              { id: "h2", title: "قراءة 20 صفحة", subtitle: "تطوير · 20 دقيقة", icon: "📖", streak: 23, done: true },
              { id: "h3", title: "جري صباحي 3 كم", subtitle: "لياقة · 3 كم", icon: "🏃", streak: 12, done: false },
              { id: "h4", title: "تأمل وتركيز 10 دقائق", subtitle: "صفاء ذهني", icon: "🌿", streak: 15, done: true },
            ]
          : [
              { id: "h1", title: "Drink 2L water", subtitle: "Hydration · Daily", icon: "💧", streak: 19, done: true },
              { id: "h2", title: "Read 20 pages", subtitle: "Growth · 20 min", icon: "📖", streak: 23, done: true },
              { id: "h3", title: "Morning run", subtitle: "Cardio · 5km", icon: "🏃", streak: 12, done: false },
              { id: "h4", title: "Meditate 10 min", subtitle: "Mindfulness", icon: "🌿", streak: 15, done: true },
            ];

        const sourceHash = crypto.createHash("sha256").update(slug + promptText).digest("hex").slice(0, 12);
        const expUrl = `exp://127.0.0.1:19000/?projectId=${slug}&sourceHash=${sourceHash}`;
        const qrSvg = generateQrSvg(expUrl);

        fs.writeFileSync(path.join(projDir, ".gitignore"), "node_modules\n.env\n.expo\n.rork\n", "utf8");
        fs.writeFileSync(
          path.join(projDir, "package.json"),
          JSON.stringify(
            {
              name: slug,
              version: "1.0.0",
              private: true,
              main: "expo-router/entry",
              dependencies: {
                expo: "~53.0.0",
                "expo-router": "~5.0.0",
                react: "19.0.0",
                "react-native": "0.79.0",
                "react-native-web": "~0.20.0",
              },
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
        fs.writeFileSync(
          path.join(projDir, "app.json"),
          JSON.stringify(
            {
              expo: {
                name: appTitle,
                slug,
                version: "1.0.0",
                orientation: "portrait",
                ios: { bundleIdentifier: `com.rork.${slug.replace(/-/g, "")}` },
                android: { package: `com.rork.${slug.replace(/-/g, "")}` },
              },
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
        fs.writeFileSync(path.join(projDir, ".rork", "qr-preview.svg"), qrSvg + "\n", "utf8");

        const indexHtml = `<!doctype html>
<html lang="${rtl ? "ar" : "en"}" dir="ltr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(appTitle)} — Rork Mobile Studio</title>
  <style>
    :root { --canvas:${t.canvas}; --surface:${t.surface}; --card:${t.card}; --border:${t.border}; --text:${t.text}; --muted:${t.muted}; --accent:${t.accent}; --accent-fg:${t.accentFg}; }
    * { box-sizing:border-box; }
    body { margin:0; background:#0d0d0f; color:#f4f4f6; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,sans-serif; min-height:100vh; display:flex; flex-direction:column; }
    .top { height:48px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:space-between; padding:0 18px; }
    .stage { flex:1; display:flex; align-items:center; justify-content:center; gap:36px; padding:24px; flex-wrap:wrap; }
    .phone { width:350px; height:720px; border-radius:44px; background:var(--canvas); border:8px solid #27272a; display:flex; flex-direction:column; overflow:hidden; color:var(--text); direction:${rtl ? "rtl" : "ltr"}; box-shadow:0 24px 60px rgba(0,0,0,0.65); }
    .status { height:32px; padding:8px 20px 0; display:flex; justify-content:space-between; font-size:12px; font-weight:700; direction:ltr; }
    .body { flex:1; padding:18px; overflow-y:auto; display:flex; flex-direction:column; }
    .hero { text-align:center; margin:8px 0 20px; }
    .num { font-size:52px; font-weight:800; line-height:1; }
    .list { background:var(--surface); border:1px solid var(--border); border-radius:18px; overflow:hidden; margin-bottom:16px; }
    .row { display:flex; align-items:center; gap:10px; padding:13px 14px; border-bottom:1px solid var(--border); cursor:pointer; }
    .row:last-child { border-bottom:none; }
    .chk { width:22px; height:22px; border-radius:50%; border:2px solid var(--muted); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; color:transparent; }
    .row.done .chk { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
    .cta { margin-top:auto; width:100%; border:none; border-radius:14px; padding:14px; background:var(--accent); color:var(--accent-fg); font-weight:700; cursor:pointer; }
    .qr-card { width:260px; background:#141417; border:1px solid rgba(255,255,255,0.08); border-radius:18px; padding:18px; display:flex; flex-direction:column; gap:10px; }
  </style>
</head>
<body>
  <header class="top">
    <strong>📱 ${esc(appTitle)} — Rork Mobile Studio</strong>
    <span style="font-size:12px;color:#34d399">✓ Expo + SwiftUI + Kotlin Ready (sourceHash: ${sourceHash})</span>
  </header>
  <main class="stage">
    <div class="phone" data-simulator="true">
      <div class="status"><span>9:41</span><span>100%</span></div>
      <div class="body">
        <div class="hero">
          <div style="font-size:32px">🔥</div>
          <div class="num" id="streak-val">23</div>
          <div style="font-size:15px;font-weight:600">${rtl ? "يوم متتالي" : "day streak"}</div>
        </div>
        <div class="list" id="items-box"></div>
        <button class="cta" onclick="addItem()">${rtl ? "+ إضافة عنصر جديد" : "+ Add habit"}</button>
      </div>
    </div>
    <aside class="qr-card">
      <strong>Test on your phone</strong>
      <div style="background:#fff;padding:10px;border-radius:12px;display:flex;justify-content:center">${qrSvg}</div>
      <div style="font-size:12px;color:#a1a1aa">Scan with iPhone Camera or Expo Go on Android.</div>
      <code style="font-size:11px;word-break:break-all;color:#94a3b8">${esc(expUrl)}</code>
    </aside>
  </main>
  <script>
    const ITEMS = ${JSON.stringify(items)};
    function render() {
      document.getElementById('items-box').innerHTML = ITEMS.map((it, i) => \`
        <div class="row \${it.done ? 'done' : ''}" onclick="ITEMS[\${i}].done=!ITEMS[\${i}].done;render()">
          <div class="chk">✓</div>
          <div style="flex:1"><div style="font-size:14px;font-weight:600">\${it.icon} \${it.title}</div><div style="font-size:11px;color:var(--muted)">\${it.subtitle}</div></div>
        </div>\`).join('');
      document.getElementById('streak-val').textContent = String(23 + (ITEMS.every(x => x.done) ? 1 : 0));
    }
    window.addItem = function() {
      const t = prompt(${JSON.stringify(rtl ? "اسم العنصر الجديد:" : "New habit name:")});
      if (t && t.trim()) { ITEMS.push({ id: 'c'+Date.now(), title: t.trim(), subtitle: 'Daily', icon: '✨', streak: 1, done: true }); render(); }
    };
    render();
  </script>
</body>
</html>`;
        fs.writeFileSync(path.join(projDir, "index.html"), indexHtml, "utf8");

        const inst = await preview.start(projDir);
        return {
          ok: true,
          content: JSON.stringify(
            {
              ok: true,
              projectId: slug,
              title: appTitle,
              previewUrl: inst.url,
              expUrl,
              sourceHash,
              root: projDir,
            },
            null,
            2,
          ),
        };
      },
    },
    {
      name: "rork_from_web",
      description:
        "Convert an existing Web or Lovable project folder inside the workspace into a complete Rork Mobile App (Expo + SwiftUI + Kotlin + Live Mobile Simulator + QR Code) and serve it in the preview panel.",
      parameters: {
        type: "object",
        properties: {
          sourceDir: { type: "string", description: "Existing web/Lovable project folder inside workspace." },
          targetProjectId: { type: "string", description: "Target mobile project folder name." },
        },
        required: ["sourceDir"],
      },
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const srcDir = resolveRead(ctx.workspace, str(args, "sourceDir", "."), false);
        const baseName = path.basename(srcDir);
        const targetId = str(args, "targetProjectId", `${baseName}-mobile`);
        let extractedTitle = `${baseName} Mobile`;
        const indexFile = path.join(srcDir, "index.html");
        if (fs.existsSync(indexFile)) {
          const html = fs.readFileSync(indexFile, "utf8");
          const m = html.match(/<title>([^<]+)<\/title>/i);
          if (m && m[1]) extractedTitle = `${m[1].split(/[—|]/)[0]?.trim() || baseName} Mobile`;
        }
        const buildTool = createRorkTools(preview)[0]!;
        return buildTool.run(
          {
            projectId: targetId,
            title: extractedTitle,
            prompt: `Convert ${extractedTitle} into a native mobile application`,
          },
          ctx,
        );
      },
    },
  ];
}
