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

export type CraftCardLayout = "editorial" | "comparison" | "stats" | "quote";

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
  layout?: CraftCardLayout;
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

const HEADING_FALLBACK_AR = ["البيانات الأساسية", "المعالم والثقافة", "الهوية واللغة", "السياق والموقع"];
const HEADING_FALLBACK_EN = ["Key facts", "Landmarks & culture", "Identity & language", "Context & location"];

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
  const layout = text("layout", 20);
  return {
    ...(text("subtitle", 240) ? { subtitle: text("subtitle", 240) } : {}),
    ...(text("eyebrow", 100) ? { eyebrow: text("eyebrow", 100) } : {}),
    ...(text("localeTag", 100) ? { localeTag: text("localeTag", 100) } : {}),
    ...(headings?.length ? { headings } : {}),
    ...(facts.length ? { facts } : {}),
    palette,
    density: args.density === "compact" ? "compact" : "standard",
    ...(layout === "comparison" || layout === "stats" || layout === "quote" ? { layout } : {}),
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

function splitLines(text: string): string[] {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
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
  const layout = input.layout ?? "editorial";
  const sections = input.sections.map((s) => s.trim()).filter(Boolean);
  const headings = input.headings ?? (input.arabic ? HEADING_FALLBACK_AR : HEADING_FALLBACK_EN);
  const facts = input.facts ?? [];

  const text = async (rect: number[], value: string, size: number, color: string, bold = false, textAlign = align) => {
    if (!value) return;
    const id = await insert("insert.textBox", { rect, text: value });
    await execute("edit.select", { ids: [id] });
    await execute("format.fontDialog", { family: "Segoe UI", size, bold, color });
    await execute("format.rtl", { on: input.arabic });
    await execute("format.align", { align: textAlign });
    await execute("format.autofit", { mode: "shrink" });
  };

  const shape = async (rect: number[], color: string, line = color) => {
    const id = await insert("shape.insert", { preset: "rect", rect });
    await execute("edit.select", { ids: [id] });
    await execute("shape.fill", { color });
    await execute("shape.line", { color: line, width: 0.75 });
  };

  await execute("slide.layout", { layout: "blank", index: 0 });
  await execute("design.background", { color: input.background });

  if (layout === "comparison") {
    await buildComparisonLayout();
  } else if (layout === "stats") {
    await buildStatsLayout();
  } else if (layout === "quote") {
    await buildQuoteLayout();
  } else {
    await buildEditorialLayout();
  }

  async function buildEditorialLayout(): Promise<void> {
    const columnCount = sections.length <= 4 ? 4 : Math.ceil(sections.length / 2);
    const columns = columnCount === 4
      ? [{ x: 20, width: 208 }, { x: 240, width: 232 }, { x: 484, width: 216 }, { x: 712, width: 228 }]
      : columnCount === 3
        ? [{ x: 20, width: 292 }, { x: 328, width: 292 }, { x: 636, width: 292 }]
        : [{ x: 20, width: 448 }, { x: 484, width: 448 }];

    await shape([20, 27, 4, 34], palette.accent);
    await text([450, 20, 456, 48], input.title, compact ? 28 : 30, palette.ink, true);
    await text([430, 70, 490, 31], input.subtitle ?? "", 11, palette.muted);
    await text([24, 24, 280, 22], input.eyebrow ?? "", 10, palette.ink, true, "left");
    await text([24, 49, 280, 16], input.localeTag ?? "", 8, palette.muted, false, "left");
    await shape([20, 108, 920, 1], palette.line);

    for (const column of columns) {
      await shape([column.x, 125, column.width, 338], palette.surface, palette.line);
    }

    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index]!;
      const markerX = input.arabic ? column.x + column.width - 18 : column.x + 14;
      await shape([markerX, 143, 3, 24], index % 2 === 0 ? palette.accent : palette.secondary);
      await text([column.x + 14, 139, column.width - 40, 42], headings[index] ?? "", compact ? 13 : 14, palette.ink, true);

      const iconIds = ["facts", "landmarks", "language", "location"] as const;
      const iconId = iconIds[index];
      const icon = iconId ? input.icons?.[iconId] : undefined;
      if (icon) {
        await execute("insert.picture", { data: icon.data, name: icon.name, rect: [column.x + 14, 145, 16, 16] });
      } else {
        const numberX = input.arabic ? column.x + 14 : column.x + column.width - 39;
        await text([numberX, 145, 24, 16], String(index + 1).padStart(2, "0"), 8, palette.muted, false, input.arabic ? "left" : "right");
      }
    }

    if (facts.length > 0) {
      for (let index = 0; index < Math.min(4, facts.length); index += 1) {
        const fact = facts[index]!;
        const y = 197 + index * 62;
        await text([34, y, 180, 18], fact.label, 9, palette.muted);
        await text([34, y + 21, 180, 29], fact.value, compact ? 11 : 12, palette.ink, true);
        if (index < facts.length - 1) await shape([34, y + 54, 180, 1], palette.line);
      }
    } else if (sections.length > 0) {
      await text([34, 197, 180, 242], sections[0] ?? "", compact ? 12 : 13, palette.ink);
    }

    if (input.image && columns.length >= 2) {
      const imgColumn = columns[1]!;
      await execute("insert.picture", { data: input.image.data, name: input.image.name, rect: [imgColumn.x, 125, imgColumn.width, 153] });
      if (sections.length > 1) {
        await shape([input.arabic ? imgColumn.x + 14 : imgColumn.x + imgColumn.width - 18, 291, 3, 22], palette.secondary);
        await text([imgColumn.x + 14, 284, imgColumn.width - 40, 32], headings[1] ?? "", compact ? 13 : 14, palette.ink, true);
        await text([imgColumn.x + 14, 326, imgColumn.width - 40, 119], sections[1] ?? "", compact ? 11 : 12, palette.ink);
      }
    } else if (sections.length > 1) {
      const textColumn = columns[1]!;
      await text([textColumn.x + 14, 197, textColumn.width - 40, 242], sections[1] ?? "", compact ? 12 : 13, palette.ink);
    }

    if (columns.length >= 3 && sections.length > 2) {
      const textColumn = columns[2]!;
      await text([textColumn.x + 14, 197, textColumn.width - 40, 242], sections[2] ?? "", compact ? 12 : 13, palette.ink);
    }

    if (columns.length >= 4 && sections.length > 3) {
      const textColumn = columns[3]!;
      await text([textColumn.x + 14, 197, textColumn.width - 40, 242], sections[3] ?? "", compact ? 12 : 13, palette.ink);
    }

    for (let index = 4; index < sections.length; index += 1) {
      const column = columns[index % columns.length]!;
      const y = 480 + Math.floor(index / columns.length) * 40;
      await text([column.x + 14, y, column.width - 40, 36], sections[index] ?? "", 10, palette.muted);
    }

    await shape([20, 486, 920, 1], palette.line);
    if (input.image) {
      await text([20, 501, 700, 16], input.image.attribution, 7, palette.muted, false, "left");
      const design = input.designSummary ? `\nDesign direction: ${input.designSummary}\nDesign source: ${input.designSource ?? "presentation pipeline"}` : "";
      await execute("slide.notes", { text: `${input.image.alt ?? input.image.name}\n${input.image.attribution}\n${input.image.source}\nThe image is cropped to its frame in the slide layout.${design}`, index: 0 });
    }
    await text([865, 500, 75, 16], "01 / 01", 8, palette.muted, false, "right");
  }

  async function buildComparisonLayout(): Promise<void> {
    await shape([20, 27, 4, 34], palette.accent);
    await text([450, 20, 456, 48], input.title, compact ? 28 : 30, palette.ink, true);
    await text([430, 70, 490, 31], input.subtitle ?? "", 11, palette.muted);
    await shape([20, 108, 920, 1], palette.line);

    const leftX = 20, rightX = 480, colWidth = 440;
    await shape([leftX, 125, colWidth, 360], palette.surface, palette.line);
    await shape([rightX, 125, colWidth, 360], palette.surface, palette.line);

    await shape([input.arabic ? leftX + colWidth - 20 : leftX + 16, 143, 3, 24], palette.accent);
    await shape([input.arabic ? rightX + colWidth - 20 : rightX + 16, 143, 3, 24], palette.secondary);

    await text([leftX + 16, 139, colWidth - 50, 42], headings[0] ?? "", compact ? 14 : 16, palette.ink, true);
    await text([rightX + 16, 139, colWidth - 50, 42], headings[1] ?? "", compact ? 14 : 16, palette.ink, true);

    const leftLines = splitLines(sections[0] ?? "");
    const rightLines = splitLines(sections[1] ?? "");
    for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i += 1) {
      const y = 200 + i * 48;
      const leftLine = leftLines[i];
      const rightLine = rightLines[i];
      if (leftLine) await text([leftX + 16, y, colWidth - 50, 40], leftLine, compact ? 11 : 12, palette.ink);
      if (rightLine) await text([rightX + 16, y, colWidth - 50, 40], rightLine, compact ? 11 : 12, palette.ink);
    }

    if (input.image) {
      await execute("insert.picture", { data: input.image.data, name: input.image.name, rect: [leftX + 16, 380, 200, 90] });
      await text([leftX + 230, 390, 200, 70], input.image.alt ?? input.image.name, 9, palette.muted);
      await text([20, 501, 700, 16], input.image.attribution, 7, palette.muted, false, "left");
      await execute("slide.notes", { text: `${input.image.alt ?? input.image.name}\n${input.image.attribution}\n${input.image.source}`, index: 0 });
    }

    await shape([20, 486, 920, 1], palette.line);
    await text([865, 500, 75, 16], "01 / 01", 8, palette.muted, false, "right");
  }

  async function buildStatsLayout(): Promise<void> {
    await shape([20, 27, 4, 34], palette.accent);
    await text([450, 20, 456, 48], input.title, compact ? 28 : 30, palette.ink, true);
    await text([430, 70, 490, 31], input.subtitle ?? "", 11, palette.muted);
    await shape([20, 108, 920, 1], palette.line);

    const stats = facts.length > 0 ? facts : sections.slice(0, 4).map((s, i) => ({ label: `محور ${i + 1}`, value: s }));
    const statCount = Math.min(4, stats.length);
    const statWidth = 920 / statCount;

    for (let i = 0; i < statCount; i += 1) {
      const stat = stats[i]!;
      const x = 20 + i * statWidth;
      await shape([x + 10, 140, statWidth - 20, 200], palette.surface, palette.line);
      await text([x + 20, 170, statWidth - 40, 60], stat.value, compact ? 22 : 28, palette.accent, true, "center");
      await text([x + 20, 240, statWidth - 40, 30], stat.label, compact ? 10 : 12, palette.ink, false, "center");
      await shape([x + 20, 280, statWidth - 40, 1], palette.line);
    }

    if (input.image) {
      await execute("insert.picture", { data: input.image.data, name: input.image.name, rect: [20, 360, 920, 110] });
      await text([20, 501, 700, 16], input.image.attribution, 7, palette.muted, false, "left");
      await execute("slide.notes", { text: `${input.image.alt ?? input.image.name}\n${input.image.attribution}\n${input.image.source}`, index: 0 });
    }

    await shape([20, 486, 920, 1], palette.line);
    await text([865, 500, 75, 16], "01 / 01", 8, palette.muted, false, "right");
  }

  async function buildQuoteLayout(): Promise<void> {
    await shape([20, 27, 4, 34], palette.accent);
    await text([450, 20, 456, 48], input.title, compact ? 28 : 30, palette.ink, true);
    await text([430, 70, 490, 31], input.subtitle ?? "", 11, palette.muted);
    await shape([20, 108, 920, 1], palette.line);

    const quote = sections[0] ?? "";
    const attribution = sections[1] ?? facts[0]?.value ?? "";

    await shape([input.arabic ? 900 : 20, 140, 4, 200], palette.accent);
    await text([input.arabic ? 880 : 40, 140, 840, 200], quote, compact ? 20 : 24, palette.ink, false, input.arabic ? "right" : "left");

    if (attribution) {
      await text([input.arabic ? 880 : 40, 360, 840, 30], attribution, compact ? 11 : 13, palette.muted, true);
    }

    if (input.image) {
      await execute("insert.picture", { data: input.image.data, name: input.image.name, rect: [380, 420, 180, 50] });
      await text([20, 501, 700, 16], input.image.attribution, 7, palette.muted, false, "left");
      await execute("slide.notes", { text: `${input.image.alt ?? input.image.name}\n${input.image.attribution}\n${input.image.source}`, index: 0 });
    }

    await shape([20, 486, 920, 1], palette.line);
    await text([865, 500, 75, 16], "01 / 01", 8, palette.muted, false, "right");
  }

  const inspected = await execute("slide.inspect", { index: 0 });
  const state = JSON.stringify(inspected);
  if (!state.includes(input.title) || sections.some((section) => section && !state.includes(section))) {
    throw new Error("Loam Slides did not confirm the editorial layout text");
  }
}
