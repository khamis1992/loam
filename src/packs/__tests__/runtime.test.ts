import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ToolRegistry } from "../../tools/registry.js";
import { resolvePackId } from "../intent.js";
import { listPackManifests, loadPackManifests, PACK_MANIFESTS, validatePackManifest } from "../registry.js";
import { toolsForPack } from "../loader.js";
import { withPackGuard } from "../guard.js";
import { packResourceUri, presentPackProject, readPackProject, writePackProject } from "../present.js";
import { cancelPackJob, createPackJob, getPackJob, updatePackJob } from "../jobs.js";
import { visiblePackAttachment } from "../attachments.js";
import type { AgentEvent } from "../../agent/events.js";

describe("service pack runtime", () => {
  it("keeps host tools out of model tools", () => {
    for (const manifest of listPackManifests()) {
      validatePackManifest(manifest);
      assert.equal(manifest.modelTools.includes(manifest.gate.tool), false);
    }
  });

  it("resolves the exact studio goal and output type without a wrong-pack fallback", () => {
    assert.equal(resolvePackId({ studioGoal: "slides" }), "loam-slides");
    assert.equal(resolvePackId({ studioGoal: "video" }), "loam-video");
    assert.equal(resolvePackId({ studioGoal: "websites" }), "loam-build");
    assert.equal(resolvePackId({ outputType: "website" }), "loam-build");
    assert.equal(resolvePackId({ studioGoal: "mobile-app" }), "loam-mobile");
    assert.equal(resolvePackId({ studioGoal: "game-development" }), "loam-game");
    assert.equal(resolvePackId({ localEdit: true }), "loam-localfile");
    assert.equal(resolvePackId({ packId: "loam-video", studioGoal: "slides" }), "loam-video");
    assert.equal(resolvePackId({ loamMode: "write", prompt: "أنشئ عرضًا تقديميًا من شريحة واحدة عن الكويت" }), "loam-slides");
    assert.equal(resolvePackId({ loamMode: "write", prompt: "اكتب تقريرًا عن الكويت" }), "loam-office");
    assert.equal(resolvePackId({ loamMode: "ask", prompt: "اشرح لي الكويت" }), undefined);
    assert.equal(resolvePackId({ loamMode: "media", prompt: "أنشئ فيديو MP4 من العرض" }), "loam-video");
    assert.equal(resolvePackId({ loamMode: "build", prompt: "أنشئ موقعًا ثابتًا لمطعم" }), "loam-build");
  });

  it("filters tools to the active pack and the caller's existing allowlist", () => {
    const registry = new ToolRegistry();
    for (const name of ["design_brief", "office_craft", "video_studio", "finish", "deck_init", "deck_present"]) {
      registry.register({ name, description: name, parameters: {}, run: async () => ({ ok: true, content: name }) });
    }
    const slides = toolsForPack(registry, "loam-slides", ["design_brief", "office_craft", "video_studio", "finish"]);
    assert.deepEqual(slides.names().sort(), ["deck_init", "finish"].sort());
    assert.equal(slides.get("deck_present"), undefined);
    const hostSlides = toolsForPack(registry, "loam-slides", ["design_brief", "office_craft", "video_studio", "finish"], { includeWrapped: true });
    assert.deepEqual(hostSlides.names().sort(), ["deck_init", "design_brief", "finish", "office_craft"].sort());
    const video = toolsForPack(registry, "loam-video", ["design_brief", "office_craft", "video_studio", "finish"]);
    assert.deepEqual(video.names().sort(), ["finish"].sort());
    const office = toolsForPack(registry, "loam-office", ["design_brief", "office_craft", "video_studio", "finish"]);
    assert.deepEqual(office.names().sort(), ["design_brief", "finish", "office_craft"].sort());
    for (const name of ["task_create", "schedule_create", "browser_open"]) registry.register({ name, description: name, parameters: {}, run: async () => ({ ok: true, content: name }) });
    const schedule = toolsForPack(registry, "loam-schedule", ["task_create", "schedule_create", "browser_open", "finish"]);
    assert.deepEqual(schedule.names().sort(), ["browser_open", "finish", "schedule_create", "task_create"].sort());
  });

  it("rejects direct manifest writes even through shell commands", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "shell_run", description: "shell", parameters: {}, run: async () => ({ ok: true, content: "ok" }) });
    registry.register({ name: "file_write", description: "write", parameters: {}, run: async () => ({ ok: true, content: "ok" }) });
    const guarded = withPackGuard(registry);
    const ctx = { cfg: {} as never, workspace: "", emit: () => undefined };
    const shell = await guarded.exec("shell_run", { command: "echo bad > manifest.json" }, ctx);
    assert.match(shell.content, /tool-owned/);
    const file = await guarded.exec("file_write", { path: "nested/manifest.json" }, ctx);
    assert.match(file.content, /tool-owned/);
    const allowed = await guarded.exec("shell_run", { command: "npm test" }, ctx);
    assert.equal(allowed.ok, true);
  });

  it("returns timeout once without retrying a hung adapter", async () => {
    const registry = new ToolRegistry();
    let calls = 0;
    registry.register({
      name: "deck_init",
      description: "hung",
      parameters: {},
      run: async () => {
        calls += 1;
        await new Promise(() => undefined);
        return { ok: true, content: "unreachable" };
      },
    });
    const guarded = withPackGuard(toolsForPack(registry, "loam-slides", []), "loam-slides", 15);
    const started = Date.now();
    const result = await guarded.exec("deck_init", {}, { cfg: {} as never, workspace: "", emit: () => undefined });
    assert.equal(result.ok, false);
    const error = JSON.parse(result.content) as { code: string; retry: boolean };
    assert.equal(error.code, "timeout");
    assert.equal(error.retry, false);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 150);
  });

  it("blocks present until every item is final, then emits the real artifact", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "loam-pack-present-"));
    try {
      writePackProject(workspace, { projectId: "task_1", packId: "loam-slides", revision: 0, items: [{ id: "slide-2", state: "pending" }] });
      const blocked = presentPackProject({ workspace, packId: "loam-slides", kind: "deck", artifacts: [] });
      assert.equal(blocked.ok, false);
      if (blocked.ok) return;
      assert.deepEqual(blocked.missing, ["slide-2"]);
      writePackProject(workspace, { projectId: "task_1", packId: "loam-slides", revision: 1, items: [{ id: "slide-2", state: "final", path: "uploads/deck.pptx" }] });
      fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "uploads", "deck.pptx"), "real deck");
      const events: AgentEvent[] = [];
      const result = presentPackProject({
        workspace,
        packId: "loam-slides",
        kind: "deck",
        artifacts: [{ path: "uploads/deck.pptx", kind: "deck", title: "Deck", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }],
        emit: (event) => events.push(event),
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.uri, "loam-resource://loam-slides/deck/task_1");
      assert.equal(readPackProject(workspace, "loam-slides")?.revision, 1);
      assert.equal(events[0]?.type, "artifact_published");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("supports bounded export jobs and cancellation", () => {
    const job = createPackJob("loam-video");
    assert.equal(getPackJob(job.id)?.status, "queued");
    updatePackJob(job.id, { status: "running" });
    assert.equal(cancelPackJob(job.id).status, "cancelled");
    assert.equal(cancelPackJob(job.id).status, "cancelled");
  });

  it("validates the resource URI", () => {
    assert.equal(packResourceUri("loam-slides", "deck", "task_1"), "loam-resource://loam-slides/deck/task_1");
    assert.throws(() => packResourceUri("loam-slides", "bad kind", "task_1"));
  });

  it("loads disk manifests and rejects invalid gate timeouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-pack-manifests-"));
    try {
      for (const manifest of Object.values(PACK_MANIFESTS)) {
        fs.mkdirSync(path.join(root, manifest.id), { recursive: true });
        fs.writeFileSync(path.join(root, manifest.id, "pack.json"), JSON.stringify(manifest));
      }
      const loaded = loadPackManifests(root);
      assert.equal(loaded.length, Object.keys(PACK_MANIFESTS).length);
      assert.equal(loaded[0]?.legacyRoutes, "keep");
      const invalid = structuredClone(PACK_MANIFESTS["loam-slides"]);
      invalid.gate.timeoutMs = 0;
      assert.throws(() => validatePackManifest(invalid), /timeout/);
      invalid.gate.timeoutMs = 1000;
      invalid.ownedTools.push("office_craft");
      assert.throws(() => validatePackManifest(invalid), /overlap/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows final outputs and useful previews without internal pack assets", () => {
    assert.equal(visiblePackAttachment("loam-build", "index.html", new Set(["index.html"])), true);
    assert.equal(visiblePackAttachment("loam-build", "desktop.png", new Set(["index.html"])), true);
    assert.equal(visiblePackAttachment("loam-build", "src/App.tsx", new Set(["index.html"])), false);
    assert.equal(visiblePackAttachment("loam-video", "assets/video-review/hook.png", new Set(["uploads/video.mp4"])), false);
    assert.equal(visiblePackAttachment("loam-video", "previews/presentation-video.png", new Set(["uploads/video.mp4"])), true);
  });
});
