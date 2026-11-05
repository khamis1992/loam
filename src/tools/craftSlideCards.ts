import fs from "node:fs";
import type { CraftOfficeRelayLike } from "./craftOffice.js";

export interface CraftCardImage {
  data: string;
  name: string;
  alt?: string;
  attribution: string;
  source: string;
}

export type CraftCardIcons = Partial<Record<"facts" | "landmarks" | "language" | "location", CraftCardImage>>;

export interface CraftCardPalette {
  background: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  secondary: string;
  line: string;
}

export interface CraftCardSlide {
  title: string;
  sections: string[];
  background: string;
  arabic: boolean;
  subtitle?: string;
  eyebrow?: string;
  localeTag?: string;
  headings?: string[];
  facts?: Array<{ label: string; value: string }>;
  palette?: Partial<CraftCardPalette>;
  density?: "standard" | "compact";
  designSource?: string;
  designSummary?: string;
  image?: CraftCardImage;
  icons?: CraftCardIcons;
}

const DEFAULT_PALETTE: CraftCardPalette = {
  background: "#F7F7F2",
  surface: "#FFFFFF",
  ink: "#17231C",
  muted: "#66736B",
  accent: "#007A33",
  secondary: "#00843D",
  line: "#DCE3DC",
};

export function readCraftCardImage(value: unknown): CraftCardImage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || typeof record.name !== "string" || typeof record.attribution !== "string" || typeof record.source !== "string") return undefined;
  return {
    data: fs.readFileSync(record.path).toString("base64"),
    name: record.name,
    ...(typeof record.alt === "string" ? { alt: record.alt } : {}),
    attribution: record.attribution,
    source: record.source,
  };
}

export function craftCardOptions(args: Record<string, unknown>): Omit<CraftCardSlide, "title" | "sections" | "background" | "arabic" | "image"> {
  const text = (key: string, max: number): string | undefined => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  };
  const rawPalette = args.palette && typeof args.palette === "object" && !Array.isArray(args.palette) ? args.palette as Record<string, unknown> : {};
  const palette: Partial<CraftCardPalette> = {};
  for (const key of Object.keys(DEFAULT_PALETTE) as Array<keyof CraftCardPalette>) {
    const value = rawPalette[key];
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) palette[key] = value;
  }
  const facts = Array.isArray(args.facts) ? args.facts.slice(0, 4).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.label === "string" && typeof record.value === "string"
      ? [{ label: record.label.trim().slice(0, 80), value: record.value.trim().slice(0, 120) }]
      : [];
  }) : [];
  const headings = Array.isArray(args.headings) ? args.headings.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4).map((item) => item.trim().slice(0, 100)) : undefined;
  const rawIcons = args.icons && typeof args.icons === "object" && !Array.isArray(args.icons) ? args.icons as Record<string, unknown> : {};
  const icons: CraftCardIcons = {};
  for (const id of ["facts", "landmarks", "language", "location"] as const) {
    const icon = readCraftCardImage(rawIcons[id]);
    if (icon) icons[id] = icon;
  }
  return {
    ...(text("subtitle", 240) ? { subtitle: text("subtitle", 240) } : {}),
    ...(text("eyebrow", 100) ? { eyebrow: text("eyebrow", 100) } : {}),
    ...(text("localeTag", 100) ? { localeTag: text("localeTag", 100) } : {}),
    ...(headings?.length ? { headings } : {}),
    ...(facts.length ? { facts } : {}),
    palette,
    density: args.density === "compact" ? "compact" : "standard",
    ...(text("designSource", 40) ? { designSource: text("designSource", 40) } : {}),
    ...(text("designSummary", 600) ? { designSummary: text("designSummary", 600) } : {}),
    ...(Object.keys(icons).length ? { icons } : {}),
  };
}

function insertedId(value: unknown): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" || typeof record.id === "number") return record.id;
  for (const key of ["result", "shape", "object"]) {
    const id = insertedId(record[key]);
    if (id !== null) return id;
  }
  return null;
}

export async function designCraftCardSlide(relay: CraftOfficeRelayLike, taskId: string, input: CraftCardSlide): Promise<void> {
  const execute = (command: string, params: Record<string, unknown> = {}) => relay.enqueue(taskId, "slides", "engine.execute", { command, params });
  const insert = async (command: string, params: Record<string, unknown>) => {
    const id = insertedId(await execute(command, params));
    if (id === null) throw new Error(`${command} did not return a shape id`);
    return id;
  };
  const palette = { ...DEFAULT_PALETTE, ...input.palette };
  const compact = input.density === "compact";
  const align = input.arabic ? "right" : "left";
  const text = async (rect: number[], value: string, size: number, color: string, bold = false, textAlign = align) => {
    const id = await insert("insert.textBox", { rect, text: value });
    await execute("edit.select", { ids: [id] });
    await execute("format.fontDialog", { family: "Segoe UI", size, bold, color });
    await execute("format.rtl", { on: input.arabic });
    await execute("format.align", { align: textAlign });
    await execute("format.autofit", { mode: "shrink" });
    return id;
  };
  const shape = async (rect: number[], color: string, line = color, preset = "rect") => {
    const id = await insert("shape.insert", { preset, rect });
    await execute("edit.select", { ids: [id] });
    await execute("shape.fill", { color });
    await execute("shape.line", { color: line, width: 0.75 });
    return id;
  };
  const card = async (x: number, width: number, y = 125, height = 338) => {
    await shape([x, y, width, height], palette.surface, palette.line);
  };
  const heading = async (x: number, width: number, value: string, index: number) => {
    const markerX = input.arabic ? x + width - 18 : x + 14;
    await shape([markerX, 143, 3, 24], index === 1 ? palette.accent : palette.secondary);
    await text([x + 14, 139, width - 40, 42], value, compact ? 13 : 14, palette.ink, true);
    const id = (["facts", "landmarks", "language", "location"] as const)[index]!;
    const icon = input.icons?.[id];
    if (icon) {
      await execute("insert.picture", { data: icon.data, name: icon.name, rect: [x + 14, 145, 16, 16] });
    } else {
      await text([input.arabic ? x + 14 : x + width - 39, 145, 24, 16], String(index + 1).padStart(2, "0"), 8, palette.muted, false, input.arabic ? "left" : "right");
    }
  };

  await execute("slide.layout", { layout: "blank", index: 0 });
  await execute("design.background", { color: input.background });
  await shape([922, 27, 4, 34], palette.accent);
  await shape([916, 27, 3, 34], "#CE1126");
  await text([450, 20, 456, 48], input.title, compact ? 28 : 30, palette.ink, true);
  await text([430, 70, 490, 31], input.subtitle ?? "", 11, palette.muted);
  await text([24, 24, 280, 22], input.eyebrow ?? "", 10, palette.ink, true, "left");
  await text([24, 49, 280, 16], input.localeTag ?? "", 8, palette.muted, false, "left");
  await shape([20, 108, 920, 1], palette.line);

  const columns = [
    { x: 20, width: 208 },
    { x: 240, width: 232 },
    { x: 484, width: 216 },
    { x: 712, width: 228 },
  ];
  for (const column of columns) await card(column.x, column.width);

  const headings = input.headings ?? (input.arabic
    ? ["بطاقة البيانات الأساسية", "أبرز المعالم الوطنية", "اللغة الرسمية والعملة", "الموقع الجغرافي والعاصمة"]
    : ["Key facts", "National landmarks", "Official language & currency", "Location & capital"]);
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]!;
    if (index !== 1) await heading(column.x, column.width, headings[index] ?? "", index);
  }

  const facts = input.facts ?? [];
  for (let index = 0; index < Math.min(4, facts.length); index += 1) {
    const fact = facts[index]!;
    const y = 197 + index * 62;
    await text([34, y, 180, 18], fact.label, 9, palette.muted);
    await text([34, y + 21, 180, 29], fact.value, compact ? 11 : 12, palette.ink, true);
    if (index < facts.length - 1) await shape([34, y + 54, 180, 1], palette.line);
  }

  if (input.image) {
    await execute("insert.picture", { data: input.image.data, name: input.image.name, rect: [240, 125, 232, 153] });
  }
  await shape([input.arabic ? 454 : 254, 291, 3, 22], palette.secondary);
  await text([254, 284, 192, 32], headings[1] ?? "", compact ? 13 : 14, palette.ink, true);
  if (input.icons?.landmarks) {
    await execute("insert.picture", { data: input.icons.landmarks.data, name: input.icons.landmarks.name, rect: [254, 290, 16, 16] });
  } else {
    await text([input.arabic ? 254 : 433, 291, 24, 16], "02", 8, palette.muted, false, input.arabic ? "left" : "right");
  }
  await text([254, 326, 204, 119], input.sections[2] ?? "", compact ? 11 : 12, palette.ink);

  await text([498, 191, 188, 42], "KWD", 32, "#B42318", true, "left");
  await text([498, 236, 188, 23], input.arabic ? "الدينار الكويتي" : "Kuwaiti dinar", 11, palette.ink, true);
  await shape([498, 268, 188, 1], palette.line);
  await text([498, 282, 188, 160], input.sections[1] ?? "", compact ? 11 : 12, palette.ink);

  await text([726, 197, 200, 242], input.sections[0] ?? "", compact ? 12 : 13, palette.ink);

  await shape([20, 486, 920, 1], palette.line);
  if (input.image) {
    await text([20, 501, 700, 16], input.image.attribution, 7, palette.muted, false, "left");
    const design = input.designSummary ? `\nDesign direction: ${input.designSummary}\nDesign source: ${input.designSource ?? "presentation pipeline"}` : "";
    await execute("slide.notes", { text: `${input.image.alt ?? input.image.name}\n${input.image.attribution}\n${input.image.source}\nThe image is cropped to its frame in the slide layout.${design}`, index: 0 });
  }
  await text([865, 500, 75, 16], "01 / 01", 8, palette.muted, false, "right");

  const inspected = await execute("slide.inspect", { index: 0 });
  const state = JSON.stringify(inspected);
  if (!state.includes(input.title) || input.sections.some((section) => section && !state.includes(section))) {
    throw new Error("Loam Slides did not confirm the editorial layout text");
  }
}
