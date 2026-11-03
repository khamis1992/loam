import type { JSX, ReactNode } from "react";
export interface SlideBoxLike {
  id?: string;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  bold?: unknown;
  italic?: unknown;
  alignment?: unknown;
  background?: unknown;
}

export interface SlideLike {
  id: string;
  title: string;
  body: string;
  notes?: string;
  background?: string;
  accent?: string;
  textBoxes?: SlideBoxLike[];
  [key: string]: unknown;
}

const isRtl = (text: string) => /[\u0590-\u08ff]/u.test(text);

/** Wraps case-insensitive occurrences of `query` inside `text` with <mark>.
 * Returns the plain text when the query is empty or absent. */
export function highlightText(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const haystack = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let last = 0;
  let at = haystack.indexOf(needle);
  let seq = 0;
  while (at !== -1) {
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <mark key={`hl-${seq++}`} className="bg-func-warning px-0.5 text-inherit">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    last = at + q.length;
    at = haystack.indexOf(needle, last);
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Whitespace-delimited word count used by the deck footer. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

const systemBoxes = (slide: SlideLike): SlideBoxLike[] => [
  { id: "sys-title", text: slide.title, x: 7.1, y: 6.5, w: 85.8, h: 11.5, fontSize: 30, color: slide.accent ?? "#386bca", bold: true },
  { id: "sys-body", text: slide.body, x: 7.1, y: 15.5, w: 85.8, h: 44.5, fontSize: 22, color: "#18202B" },
];

function displayBoxes(slide: SlideLike): SlideBoxLike[] {
  if ((slide.textBoxes ?? []).length === 0) return systemBoxes(slide);
  const boxes = (slide.textBoxes ?? []).map((box) => ({ ...box }));
  if (boxes[0]) boxes[0] = { ...boxes[0], text: slide.title };
  if (boxes[1]) boxes[1] = { ...boxes[1], text: slide.body };
  return boxes;
}

/** Structured-JSON slide renderer: absolute boxes inside a 16:9 canvas.
 * Works without Microsoft PowerPoint; the PNG preview endpoint upgrades it when available.
 * `highlight` (a find-in-deck query) wraps matches in <mark>. */
export function renderSlide(slide: SlideLike, width: number, highlight?: string): JSX.Element {
  const scale = width / 960;
  return (
    <div
      className="relative overflow-hidden"
      style={{ aspectRatio: "16 / 9", width: "100%", background: slide.background || "#FFFFFF" }}
    >
      {displayBoxes(slide).map((box, i) => {
        const text = box.text ?? "";
        const rtl = isRtl(text);
        const align = String(box.alignment ?? "left");
        return (
          <div
            key={box.id ?? `box-${i}`}
            className="absolute overflow-hidden"
            style={{
              left: `${box.x ?? 8}%`,
              top: `${box.y ?? 8}%`,
              width: `${box.w ?? 84}%`,
              height: `${box.h ?? 10}%`,
              fontSize: Math.max(5, (box.fontSize ?? 22) * scale),
              fontFamily: box.fontFamily ?? "Arial",
              color: box.color ?? "#18202B",
              fontWeight: box.bold === true ? 700 : 400,
              fontStyle: box.italic === true ? "italic" : "normal",
              textAlign: rtl ? "right" : align.includes("center") ? "center" : align.includes("right") ? "right" : "left",
              whiteSpace: "pre-wrap",
              background: box.background ? "#" + String(box.background).replace("#", "") : "transparent",
            }}
          >
            {highlightText(text, highlight ?? "")}
          </div>
        );
      })}
    </div>
  );
}

export function SlideThumb({ slide, width, selected, onSelect, actions }: {
  slide: SlideLike;
  width: number;
  selected: boolean;
  onSelect: () => void;
  actions?: ReactNode;
}) {
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full overflow-hidden rounded border transition-colors ${
          selected ? "border-primary ring-1 ring-primary" : "border-border hover:border-text-secondary"
        }`}
      >
        {renderSlide(slide, width)}
      </button>
      {actions ? <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex">{actions}</div> : null}
    </div>
  );
}
