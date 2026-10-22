import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";

type SlideRow = { id: string; title: string; body: string; notes: string; background: string; accent: string; sourceIndex?: number };
type Deck = { kind: string; title: string; revision: number; sourceId?: string; warnings?: string[]; content: { slides: SlideRow[] } };
const deck = (value: unknown): Deck => (value as Deck).kind === "presentation" ? value as Deck : assert.fail("expected presentation");

describe("workspace slides IO", () => {
  it("imports, edits, saves, duplicates, reorders and deletes slides of a pptx task file", async () => {
    const mod = await import("../workspace/slidesIO.js");
    const studio = await import("../../studio/store.js");
    const exporter = await import("../../studio/export.js");

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-slides-io-"));
    try {
      const decks = path.join(workspace, "uploads");
      fs.mkdirSync(decks, { recursive: true });
      const rel = "uploads/deck.pptx";
      const slide = (id: string, title: string, body: string) =>
        ({ id, title, body, notes: "", background: "#FFFFFF", accent: "#386bca" });
      const seed = {
        kind: "presentation" as const,
        title: "Deck",
        revision: 0,
        content: { slides: [slide("s1", "First", "alpha"), slide("s2", "Second", "beta")] },
      };
      const output = await exporter.exportStudio(studio.validateStudio(seed) as never, undefined);
      fs.writeFileSync(path.join(decks, "deck.pptx"), output.buffer, { flag: "wx" });

      const initial = await mod.readWorkspaceSlides(workspace, rel);
      assert.equal(deck(initial.artifact).kind, "presentation");
      assert.equal(deck(initial.artifact).content.slides.length, 2);

      // Edit slide 1 title/body and write back.
      const saved = deck(initial.artifact);
      const editedSlides = saved.content.slides.map((s, i) => (i === 0 ? { ...s, title: "Renamed", body: "renamed body" } : s));
      const result = await mod.saveWorkspaceSlides(
        workspace,
        rel,
        { ...saved, content: { slides: editedSlides } },
        saved.revision,
      );
      assert.equal(result.artifact.revision, saved.revision + 1);
      assert.ok(result.bytes > 1000);

      // The saved file itself carries the edit.
      const rawCheck = await mod.readWorkspaceSlidesRaw(workspace, rel);
      assert.ok(rawCheck.length > 0);
      const afterSave = await mod.readWorkspaceSlides(workspace, rel);
      assert.equal(deck(afterSave.artifact).kind, "presentation");
      assert.equal(deck(afterSave.artifact).content.slides[0]!.title, "Renamed");
      assert.equal(deck(afterSave.artifact).content.slides[0]!.body, "renamed body");

      // Duplicate the first slide: three slides, unique source anchors.
      const duplicated = await mod.duplicateWorkspaceSlide(workspace, rel, 0);
      assert.ok(duplicated.artifact.kind === "presentation");
      const dup = deck(duplicated.artifact);
      assert.equal(dup.content.slides.length, 3);
      const indexes = dup.content.slides.map((s) => s.sourceIndex);
      assert.deepEqual(new Set(indexes).size, 3);
      const afterDup = await mod.readWorkspaceSlides(workspace, rel);
      assert.equal(deck(afterDup.artifact).content.slides.length, 3);
      assert.equal(deck(afterDup.artifact).content.slides[1]!.title, "Renamed");
      assert.equal(deck(afterDup.artifact).content.slides[0]!.title, "Renamed");

      // Reorder: swap the first two slides.
      const swapped = [...deck(afterDup.artifact).content.slides];
      const tmp = swapped[0]!;
      swapped[0] = swapped[1]!;
      swapped[1] = tmp;
      await mod.saveWorkspaceSlides(workspace, rel, { ...deck(afterDup.artifact), content: { slides: swapped } }, deck(afterDup.artifact).revision);
      const afterSwap = await mod.readWorkspaceSlides(workspace, rel);
      assert.ok(deck(afterSwap.artifact).content.slides[0]!.sourceIndex !== deck(afterSwap.artifact).content.slides[1]!.sourceIndex);
      assert.equal(deck(afterSwap.artifact).content.slides.length, 3);

      // Delete one slide.
      const reduced = deck(afterSwap.artifact).content.slides.filter((_, i) => i !== 2);
      await mod.saveWorkspaceSlides(workspace, rel, { ...deck(afterSwap.artifact), content: { slides: reduced } }, deck(afterSwap.artifact).revision);
      const afterDelete = await mod.readWorkspaceSlides(workspace, rel);
      assert.equal(deck(afterDelete.artifact).content.slides.length, 2);
      assert.equal(deck(afterDelete.artifact).content.slides[2], undefined);

      // Rejected revision yields a conflict.
      await assert.rejects(
        () => mod.saveWorkspaceSlides(workspace, rel, { ...deck(afterDelete.artifact) }, 0),
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

