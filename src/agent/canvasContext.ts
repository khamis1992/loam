/**
 * Neo N11: how a canvas edit reaches the next model step.
 *
 * The canvas and the agent are two views of one run. An edit made on the canvas
 * (corrected output, cut edge, branch, merged group, quote/follow-up) is a fact
 * about the run that the agent has not seen, so the next step must be told. This
 * module is that hand-off, and it deliberately uses *both* of the run's existing
 * context channels:
 *
 *   1. A hidden user-role reminder block, appended at the step boundary. This is
 *      what guarantees the edit is in the prompt for the very next model call,
 *      including a short run that never activates the N5 selector.
 *   2. An entry in the selector's artefact store, so the same edit is part of the
 *      bounded, relevance-ranked context afterwards: a long run can re-attach a
 *      corrected node without the correction having to stay pinned in the prompt.
 *
 * A directive is consumed once (`takeCanvasDirectives`), so an edit is announced
 * exactly once and then behaves like any other run context.
 */
import type { CanvasDirective } from "../graph/directives.js";
import { injectReminder } from "./reminders.js";

/** Artefact-store kind for a canvas edit (see `contextSelector.ArtefactKind`). */
export const CANVAS_EDIT_ARTEFACT_KIND = "canvas_edit" as const;

/** One line naming what the user did, in the run's own vocabulary. */
function actionLine(directive: CanvasDirective): string {
  switch (directive.reason) {
    case "edited":
      return `The user edited the output of node \`${directive.nodeId}\` on the canvas.`;
    case "cut":
      return `The user cut an edge into node \`${directive.nodeId}\` on the canvas.`;
    case "reconnect":
      return `The user re-connected node \`${directive.nodeId}\` on the canvas.`;
    case "duplicate":
      return `The user duplicated node \`${directive.nodeId}\` as a new branch.`;
    case "group":
      return `The user grouped several nodes into one merged context (node \`${directive.nodeId}\`).`;
    case "mode":
      return directive.mode === "quote"
        ? `The user asked you to quote node \`${directive.nodeId}\` verbatim.`
        : `The user asked you to continue from node \`${directive.nodeId}\`.`;
  }
}

/** The instruction half: what the model must now do differently. */
function instructionLine(directive: CanvasDirective): string {
  switch (directive.reason) {
    case "edited":
      return "Treat the content below as the node's current, authoritative output: it supersedes whatever you produced for that node earlier.";
    case "cut":
      return "The detached node is no longer part of this node's context. Do not keep building on it; work from the content below and from the remaining parents.";
    case "reconnect":
      return "Work from the content below: the node's inputs changed, so its earlier output may no longer follow from them.";
    case "duplicate":
      return "This copy is an independent line of work. Do not modify the original node, and do not treat the two as the same step.";
    case "group":
      return "Use every grouped node below together as one context block. They belong to a single decision, so do not act on them separately.";
    case "mode":
      return directive.mode === "quote"
        ? "Reproduce the content below exactly in your answer. Do not paraphrase, summarise or silently correct it."
        : "Continue the work from the content below, treating it as the current state.";
  }
}

/**
 * The prompt block for one directive.
 *
 * The node id is always named, because the master prompt tells the model that a
 * canvas node is identified by its run-graph node id: an edit the model cannot
 * locate is an edit it cannot act on.
 */
export function directiveText(directive: CanvasDirective): string {
  const lines = [actionLine(directive), instructionLine(directive)];
  if (directive.detail) lines.push(directive.detail);
  const title = directive.title ? `Title: ${directive.title}` : "";
  if (title) lines.push(title);
  lines.push(`Content:\n${directive.text}`);
  return lines.join("\n");
}

/**
 * The hidden reminder message carrying every pending canvas edit.
 *
 * One block for the whole batch: the selector folds stacked reminders down to the
 * newest, so N separate blocks would collapse to one and silently drop the rest.
 */
export function canvasEditsMessage(directives: readonly CanvasDirective[]): { role: "user"; content: string } | undefined {
  if (directives.length === 0) return undefined;
  const head =
    directives.length === 1
      ? "The user edited this run on the canvas."
      : `The user made ${directives.length} canvas edits to this run.`;
  const body = directives.map((directive, index) => `${index + 1}. ${directiveText(directive)}`).join("\n\n");
  return { role: "user", content: injectReminder(`${head}\n\n${body}`) };
}

/** The artefact title for one directive, so the shelf entry is recognisable. */
export function directiveTitle(directive: CanvasDirective): string {
  const label = directive.title || directive.nodeId;
  return `Canvas edit: ${label}`;
}

/** The artefact body for one directive (identical to the prompt block). */
export function directiveBody(directive: CanvasDirective): string {
  return directiveText(directive);
}
