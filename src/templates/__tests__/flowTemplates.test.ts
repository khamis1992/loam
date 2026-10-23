/**
 * Case Playbook (N15) — the 12 seeded flow templates and their HTTP surface.
 *
 * Acceptance criteria covered:
 *   - all 12 flow JSON files exist and pass the flow-template schema check
 *   - the required seed content is present (Nutrio dashboards, Arabic report,
 *     site, slides)
 *   - each template's mode/effort match a known Loam mode and effort level
 *   - GET /api/flow-templates lists them and /:id reads one (404 otherwise)
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  FLOW_TEMPLATE_FILE_NAMES,
  FLOW_TEMPLATE_IDS,
  isValidFlowTemplate,
  validateFlowTemplates,
  type FlowTemplate,
} from "../flows/schema.js";
import { FLOW_TEMPLATES, getFlowTemplate } from "../flows/catalog.js";

const FLOWS_DIR = path.join(process.cwd(), "src", "templates", "flows");

describe("N15 flow template schema", () => {
  it("exposes exactly the 12 seeded flow ids", () => {
    assert.equal(FLOW_TEMPLATE_IDS.length, 12);
    assert.deepEqual([...FLOW_TEMPLATE_IDS].sort(), [
      "arabic-report",
      "automation-workflow",
      "code-review",
      "data-analysis",
      "image-generation",
      "landing-site",
      "market-research",
      "nutrio-dashboard",
      "nutrio-dashboard-arabic",
      "product-slides",
      "security-audit",
      "video-storyboard",
    ]);
  });

  it("accepts a well-formed template and rejects a malformed one", () => {
    const good: unknown = {
      id: "x",
      title: "X",
      description: "d",
      prompt: "p",
      mode: "build",
      effort: "max",
      outputType: "website",
    };
    assert.equal(isValidFlowTemplate(good), true);

    assert.equal(isValidFlowTemplate(null), false);
    assert.equal(isValidFlowTemplate({ ...(good as object), mode: "nope" }), false);
    assert.equal(isValidFlowTemplate({ ...(good as object), effort: "turbo" }), false);
    assert.equal(isValidFlowTemplate({ ...(good as object), prompt: "" }), false);
    assert.equal(isValidFlowTemplate({ ...(good as object), outputType: "pdf" }), false);
  });

  it("validateFlowTemplates keeps only the valid entries", () => {
    const kept = validateFlowTemplates([{ id: "ok", title: "t", description: "d", prompt: "p", mode: "ask", effort: "fast" }, { id: "bad" }]);
    assert.deepEqual(kept.map((t) => t.id), ["ok"]);
  });
});

describe("N15 seeded flow templates (JSON schema check)", () => {
  it("has a JSON file for every seeded flow id", () => {
    for (const id of FLOW_TEMPLATE_IDS) {
      const file = FLOW_TEMPLATE_FILE_NAMES[id];
      assert.ok(file, `missing file mapping for ${id}`);
      assert.ok(fs.existsSync(path.join(FLOWS_DIR, file)), `missing ${file}`);
    }
    // No stray files: every JSON in the directory is a seeded flow.
    const onDisk = fs.readdirSync(FLOWS_DIR).filter((f) => f.endsWith(".json")).sort();
    assert.deepEqual(onDisk, [...Object.values(FLOW_TEMPLATE_FILE_NAMES)].sort());
  });

  it("all 12 flow JSON files pass the schema check", () => {
    const parsed: unknown[] = [];
    for (const id of FLOW_TEMPLATE_IDS) {
      const raw = fs.readFileSync(path.join(FLOWS_DIR, FLOW_TEMPLATE_FILE_NAMES[id]), "utf8");
      parsed.push(JSON.parse(raw));
    }
    const valid = validateFlowTemplates(parsed);
    assert.equal(valid.length, 12, "every seeded flow must validate");

    // Each file's own id must match the slug it is filed under.
    for (const flow of valid) {
      assert.equal(flow.id, FLOW_TEMPLATES.find((t) => t.id === flow.id)?.id);
    }
  });

  it("the catalog loads all 12 in order with unique ids", () => {
    assert.equal(FLOW_TEMPLATES.length, 12);
    assert.equal(new Set(FLOW_TEMPLATES.map((t) => t.id)).size, 12);
    assert.deepEqual(FLOW_TEMPLATES.map((t) => t.id), [...FLOW_TEMPLATE_IDS]);
  });

  it("seeds the required flows: Nutrio (en + ar), Arabic report, site, slides", () => {
    const ids = new Set(FLOW_TEMPLATES.map((t) => t.id));
    for (const required of ["nutrio-dashboard", "nutrio-dashboard-arabic", "arabic-report", "landing-site", "product-slides"]) {
      assert.ok(ids.has(required), `missing required flow ${required}`);
    }
    const arabic = FLOW_TEMPLATES.find((t) => t.id === "nutrio-dashboard-arabic")!;
    assert.match(arabic.title, /نتريو/, "the Arabic Nutrio flow keeps its Arabic name");
    assert.match(arabic.prompt, /[\u0600-\u06FF]/, "the Arabic flow carries an Arabic prompt");
  });

  it("every flow targets a real Loam mode and a valid effort level", () => {
    const knownModes = new Set(["ask", "research", "build", "write", "data", "media", "security", "automate"]);
    for (const flow of FLOW_TEMPLATES) {
      assert.ok(knownModes.has(flow.mode), `${flow.id} has unknown mode ${flow.mode}`);
      assert.ok(flow.effort === "fast" || flow.effort === "max", `${flow.id} has unknown effort`);
      assert.ok(flow.prompt.trim().length > 0, `${flow.id} needs a prompt`);
      assert.ok(flow.title.trim().length > 0, `${flow.id} needs a title`);
    }
  });

  it("looks a flow up by slug", () => {
    assert.equal(getFlowTemplate("nutrio-dashboard")?.mode, "build");
    assert.equal(getFlowTemplate("nope"), undefined);
  });
});

interface Captured {
  status?: number;
  body?: unknown;
}

function fakeRes(): { res: http.ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(text?: unknown) { captured.body = text === undefined ? undefined : JSON.parse(String(text)); },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

async function call(method: string, p: string): Promise<Captured> {
  const { handleFlowTemplateRoutes } = await import("../../server/routes/flowTemplates.js");
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.method = method;
  const { res, captured } = fakeRes();
  const handled = await handleFlowTemplateRoutes(req, res, p);
  assert.equal(handled, true, `${method} ${p} must be handled by the module`);
  return captured;
}

describe("N15 flow template routes", () => {
  it("lists the 12 flows", async () => {
    const captured = await call("GET", "/api/flow-templates");
    assert.equal(captured.status, 200);
    const flows = (captured.body as { flows: FlowTemplate[] }).flows;
    assert.equal(flows.length, 12);
    assert.equal(new Set(flows.map((f) => f.id)).size, 12);
  });

  it("reads one flow by slug", async () => {
    const captured = await call("GET", "/api/flow-templates/nutrio-dashboard-arabic");
    assert.equal(captured.status, 200);
    const flow = (captured.body as { flow: FlowTemplate }).flow;
    assert.equal(flow.id, "nutrio-dashboard-arabic");
    assert.equal(flow.mode, "build");
    assert.equal(flow.effort, "max");
  });

  it("404s an unknown slug", async () => {
    assert.equal((await call("GET", "/api/flow-templates/nope")).status, 404);
  });

  it("rejects non-GET methods and leaves unrelated paths unhandled", async () => {
    assert.equal((await call("POST", "/api/flow-templates")).status, 405);
    const { handleFlowTemplateRoutes } = await import("../../server/routes/flowTemplates.js");
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = "GET";
    const { res } = fakeRes();
    assert.equal(await handleFlowTemplateRoutes(req, res, "/api/agents"), false);
    assert.equal(await handleFlowTemplateRoutes(req, res, "/api/flow-templatesx"), false);
  });
});
