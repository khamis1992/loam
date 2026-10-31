import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CollabRooms, roomKeyFor, visibleLength } from "../rooms.js";
import type { TrackedDocument } from "../rooms.js";

function doc(paragraphs: string[]): TrackedDocument {
  return {
    paragraphs: paragraphs.map((text, i) => ({
      id: `p${i + 1}`,
      runs: [{ id: `b${i + 1}`, type: "base" as const, text }],
    })),
    authors: {},
  };
}

describe("collab rooms (د3)", () => {
  let rooms: CollabRooms;
  beforeEach(() => { rooms = new CollabRooms(); });

  it("joins members with distinct palette colors and lists presence", () => {
    const a = rooms.join("docs/x.docx", doc(["مرحبا"]), "c1", "أحمد");
    const b = rooms.join("docs/x.docx", doc(["مرحبا"]), "c2", "سارة");
    assert.notEqual(a.color, b.color);
    assert.deepEqual(rooms.members("docs/x.docx").map((m) => m.clientId).sort(), ["c1", "c2"]);
  });

  it("applies a remote insert as a tracked run by the remote author", () => {
    rooms.join("docs/x.docx", doc(["النص الأصلي"]), "c1", "أحمد");
    rooms.join("docs/x.docx", doc(["النص الأصلي"]), "c2", "سارة");
    const result = rooms.apply("docs/x.docx", "c2", { kind: "insert", paragraphId: "p1", offset: 0, text: "ملاحظة: " }, 0);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const p = result.paragraph;
    assert.equal(p.runs.some((r) => r.type === "insert" && r.text === "ملاحظة: " && r.authorId === "c2"), true);
    assert.equal(visibleLength(p), "ملاحظة: النص الأصلي".length);
  });

  it("applies a delete as a tracked delete run", () => {
    rooms.join("docs/x.docx", doc(["abcdefgh"]), "c1", "أحمد");
    rooms.join("docs/x.docx", doc(["abcdefgh"]), "c2", "سارة");
    const result = rooms.apply("docs/x.docx", "c2", { kind: "delete", paragraphId: "p1", offset: 1, direction: "forward" }, 0);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.paragraph.runs.some((r) => r.type === "delete" && r.text === "b" && r.authorId === "c2"), true);
    assert.equal(visibleLength(result.paragraph), 7);
  });

  it("rejects ops from unknown members", () => {
    const result = rooms.apply("docs/x.docx", "ghost", { kind: "insert", paragraphId: "p1", offset: 0, text: "x" }, 0);
    assert.equal(result.ok, false);
  });

  it("rejects a stale op with the current paragraph (409 contract)", () => {
    rooms.join("docs/x.docx", doc(["abcdef"]), "c1", "أحمد");
    const first = rooms.apply("docs/x.docx", "c1", { kind: "insert", paragraphId: "p1", offset: 0, text: "X" }, 0);
    assert.equal(first.ok, true);
    // c2 sends an op based on seq 0 — the paragraph changed since → stale.
    rooms.join("docs/x.docx", doc(["abcdef"]), "c2", "سارة");
    const stale = rooms.apply("docs/x.docx", "c2", { kind: "insert", paragraphId: "p1", offset: 0, text: "Y" }, 0);
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.reason, "stale");
    assert.ok(stale.paragraph, "stale response carries the canonical paragraph");
  });

  it("rejects out-of-range offsets", () => {
    rooms.join("docs/x.docx", doc(["abc"]), "c1", "أحمد");
    const tooFar = rooms.apply("docs/x.docx", "c1", { kind: "insert", paragraphId: "p1", offset: 99, text: "x" }, 0);
    assert.equal(tooFar.ok, false);
    if (tooFar.ok) return;
    assert.equal(tooFar.reason, "invalid");
  });

  it("broadcasts patches to other subscribers and presence on join/leave", () => {
    const seen: Array<{ event: string; data: unknown }> = [];
    rooms.join("docs/x.docx", doc(["abc"]), "c1", "أحمد");
    const unsub = rooms.subscribe("docs/x.docx", (event, data) => seen.push({ event, data }));
    rooms.join("docs/x.docx", doc(["abc"]), "c2", "سارة");
    rooms.apply("docs/x.docx", "c2", { kind: "insert", paragraphId: "p1", offset: 3, text: "!" }, 0);
    rooms.leave("docs/x.docx", "c2");
    unsub();
    const events = seen.map((s) => s.event);
    assert.equal(events.includes("presence"), true);
    assert.equal(events.includes("patch"), true);
  });

  it("catch-up returns patches after the requested sequence", () => {
    rooms.join("docs/x.docx", doc(["abc"]), "c1", "أحمد");
    rooms.apply("docs/x.docx", "c1", { kind: "insert", paragraphId: "p1", offset: 0, text: "X" }, 0);
    rooms.apply("docs/x.docx", "c1", { kind: "insert", paragraphId: "p1", offset: 1, text: "Y" }, 1);
    const patches = rooms.catchUp("docs/x.docx", 1);
    assert.equal(patches.length, 1);
    assert.equal(patches[0]!.seq, 2);
  });

  it("reaps idle members past the TTL", () => {
    rooms.join("docs/x.docx", doc(["abc"]), "c1", "أحمد");
    // Force the member's lastSeen into the past.
    const anyRoom = rooms as unknown as { rooms: Map<string, { members: Map<string, { lastSeen: number }>; streams: Set<unknown> }> };
    const room = anyRoom.rooms.get(roomKeyFor("docs/x.docx"))!;
    const member = room.members.get("c1")!;
    member.lastSeen = Date.now() - 60_000;
    rooms.reapIdle();
    assert.deepEqual(rooms.members("docs/x.docx"), []);
  });

  it("room keys are stable sha256 digests of the relative path", () => {
    assert.equal(roomKeyFor("a.docx"), roomKeyFor("a.docx"));
    assert.notEqual(roomKeyFor("a.docx"), roomKeyFor("b.docx"));
  });
});
