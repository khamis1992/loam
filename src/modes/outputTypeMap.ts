/**
 * Neo N10: the composer's output type and the pipeline it targets.
 *
 * An output type is a *deliverable* choice (Auto / Text / Image / Video /
 * Slides / Website) and a Loam mode is the tool scope that produces one. This
 * module is the single place that maps one to the other, so the detector
 * (`src/modes/detect.ts`) and the tool narrowing (`src/llm/router.ts`) cannot
 * drift apart again: both read this table.
 *
 * It is deliberately free of imports. It must stay that way: `src/modes/` is
 * imported by `src/tools/registry.ts`, which `src/llm/router.ts` sits above, and
 * `src/config.ts` reads `DATA_DIR` at module load time. A cycle that reaches
 * `config.ts` surfaces as "Cannot access 'DATA_DIR' before initialization" in
 * unrelated tests (see the note in `src/config.ts`).
 */

export const OUTPUT_TYPES = ["auto", "text", "image", "video", "slides", "website"] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];

export function isOutputType(value: unknown): value is OutputType {
  return typeof value === "string" && (OUTPUT_TYPES as readonly string[]).includes(value);
}

/**
 * Loam mode each output type targets. `auto` defers to the prompt detector, so
 * it maps to no mode of its own.
 *
 * Note that `text` and `slides` share `write`: the Loam mode carries the tool
 * scope (`loam_studio`, `office_export`, `loam_document`), while the narrower
 * deliverable instruction lives in the system-prompt suffix.
 */
export const OUTPUT_TYPE_MODE: Record<OutputType, string> = {
  auto: "",
  text: "write",
  image: "media",
  video: "media",
  slides: "write",
  website: "build",
};
