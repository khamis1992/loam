import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleStudioTemplateRoutes } from "../routes/studioTemplates.js";

describe("studio template routes", () => {
  it("serves gallery and interactive app templates from the local API", async () => {
    const req = { method: "GET" } as IncomingMessage;
    const res = {
      status: 0,
      body: "",
      writeHead(this: { status: number }, status: number) { this.status = status; },
      end(this: { body: string }, text: string) { this.body = text; },
    } as unknown as ServerResponse & { status: number; body: string };
    const handled = await handleStudioTemplateRoutes(req, res, "/api/studio-templates");
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body as unknown as string) as { templates: unknown[]; appTemplates: unknown[] };
    assert.ok(data.templates.length > 0);
    assert.ok(data.appTemplates.length >= 4);

    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "http.ts"), "utf8");
    assert.match(source, /handleStudioTemplateRoutes/);
  });
});
