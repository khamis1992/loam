/**
 * Craft-editor guidance injected into agent prompts.
 *
 * The prose mirrors the §6.11 section of the master prompt asset
 * (prompts/loam-master.md), which is the human-editable source of truth. This
 * module exists so the guidance can be sent to runs that do not carry the whole
 * master prompt (and so it can be unit-tested in isolation), and so the
 * per-app command cheat-sheet lives in one place.
 *
 * Branding contract (docs/craft-apps.md): the user-facing names are exactly
 * Loam Docs, Loam Sheets, Loam Slides, Loam Photo and Loam Design. The
 * upstream project names never appear here, in the UI, or in a tool
 * description. Internal ids (wordcraft, gridcraft, ...) stay internal.
 */

/** Tool names whose presence should trigger the Craft guidance. */
export const CRAFT_TOOL_NAMES = ["office_craft", "office_edit"] as const;

/** The five Craft editors, in the order the master prompt lists them. */
export const CRAFT_APP_NAMES = ["Loam Docs", "Loam Sheets", "Loam Slides", "Loam Photo", "Loam Design"] as const;

/** Formats each editor accepts, for the "which app" decision. */
export const CRAFT_APP_FORMATS: Readonly<Record<string, string>> = {
  "Loam Docs": ".docx / .doc / .odt / .rtf / .md / .html",
  "Loam Sheets": ".xlsx / .csv / .ods",
  "Loam Slides": ".pptx / .odp / .key",
  "Loam Photo": ".psd / .png / .jpg / .webp / .tiff / .raw / .heif",
  "Loam Design": ".idml / .pdf / .epub",
};

/** Pick the editor for an attached file's extension, or null when none matches. */
export function craftAppForExtension(ext: string): string | null {
  const normalized = `.${ext.trim().toLowerCase().replace(/^\./, "")}`;
  for (const name of CRAFT_APP_NAMES) {
    if (CRAFT_APP_FORMATS[name]!.split("/").some((part) => part.trim().toLowerCase() === normalized)) return name;
  }
  return null;
}

/**
 * Conservative per-app command cheat-sheet. Every id must exist in the app's
 * own control protocol (`.cr-ref/craft/protocols/<internalId>.md`); each is
 * re-verified at runtime with `engine.commands` before use.
 */
export const CRAFT_COMMAND_CHEAT_SHEET: Readonly<Record<string, { read: readonly string[]; edits: readonly string[]; save: string }>> = {
  "Loam Docs": {
    read: ["document.inspect", "ui.inspect", "ui.render {page?}"],
    edits: ["text.insert {text}", "format.set", "para.set", "styles.modify", "table.modifyStyle"],
    save: "engine.execute {command:'file.save'}",
  },
  "Loam Sheets": {
    read: ["sheet.read {range?, sheet?, formulas?, formatted?}", "cell.get {cell?}", "document.inspect"],
    edits: ["cell.set {cell, input}", "range.setValues {range, values}"],
    save: "engine.execute {command:'file.save'}",
  },
  "Loam Slides": {
    read: ["document.inspect", "ui.inspect", "ui.render {slide?, scale?}"],
    edits: ["shape.insert {preset, rect, text}"],
    save: "engine.execute {command:'file.save'} (native) or {command:'app.saveAsDialog', params:{format:'pptx'}}",
  },
  "Loam Photo": {
    read: ["document.inspect", "layer.list", "document.pixel {x, y}", "ui.inspect", "ui.screenshot"],
    edits: ["layer.new.layer {name}", "layer.setProps", "paint.stroke {points, size, color}", "select.rect", "type.editText"],
    save: "engine.commands {search:'export'} then the UI-level export command (app.save)",
  },
  "Loam Design": {
    read: ["document.inspect", "ui.inspect", "ui.render {page?, scale?, bleed?}"],
    edits: ["frame.create {rect, content}"],
    save: "engine.commands {search:'export'} then the UI-level export command",
  },
};

/** The generic control methods every Craft app answers. */
export const CRAFT_BRIDGE_METHODS: readonly string[] = [
  "engine.execute",
  "engine.commands",
  "document.inspect",
  "ui.inspect",
  "ui.screenshot",
  "ui.render",
  "ui.key",
  "ui.text",
  "ui.pointer",
  "ui.click",
  "ui.set",
  "app.open",
  "app.save",
];

/**
 * Guidance appended to the system prompt when a run can call office_craft (or
 * office_edit). Kept in sync with §6.11 of prompts/loam-master.md.
 */
export const CRAFT_EDITORS_PROMPT: string = [
  "Craft editors: the attached file opens live in the Workspace panel (Loam Docs for documents, Loam Sheets for spreadsheets, Loam Slides for decks, Loam Photo for images and Loam Design for layouts). The user edits the same file by hand, so the file on disk is not the current state.",
  "Loop: (1) open with the attached file, then read the live state (document.inspect / sheet.read / cell.get / ui.inspect); (2) discover the command ids with engine.commands and read the params docs and enabled/disabledReason/needsDocument flags (Sheets narrows it with {search: \"<term>\"}; the other control channels always return the full list); (3) batch the independent edits into one round trip; (4) re-read the state and confirm the change is present; (5) export through the app so the bytes come back into the task's files.",
  "Never invent a command id, never replay a failed command unchanged, and never write the office file yourself through shell or Python. A command that returned ok is not proof of the edit.",
  "Fail closed: if no app is installed, the panel never reports ready, a command is refused, or the app reports no document open, say so plainly in the user's language and fall back to loam_studio (with office_import / office_export / office_edit) or loam_document. Do not retry the same unavailable command.",
  "Reply in the user's language (Arabic for an Arabic request). Never mention the upstream project names in the UI, prompts or tool descriptions; the user sees only the Loam names.",
].join("\n");
