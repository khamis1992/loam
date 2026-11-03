import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
const start = source.indexOf("function modelOptionValue");
const end = source.indexOf("async function applyModelChoice");
if (start < 0 || end < start) throw new Error("S9 model select functions are missing from ui/app.js");

const html = fs.readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");

test("S9 groups registry models and keeps an unregistered value visible", () => {
  assert.match(html, /id="model"/);
  assert.match(html, /id="sidebarModel"/);
  const selects = {
    model: { innerHTML: "", value: "" },
    sidebarModel: { innerHTML: "", value: "" },
  };
  const state = { runModel: "" };
  const sandbox = {
    state,
    esc: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char)),
    $: (id: "model" | "sidebarModel") => selects[id],
  };
  vm.runInNewContext(`${source.slice(start, end)}
    fillModelSelects(payload, settingsModel);
    result = { model: $('model').innerHTML, sidebar: $('sidebarModel').innerHTML, value: $('model').value, runModel: state.runModel };
  `, Object.assign(sandbox, {
    payload: {
      entries: [
        { id: "ollama/qwen", providerId: "ollama", label: "Qwen", location: "local", enabled: true },
        { id: "openrouter/claude", providerId: "openrouter", label: "Claude", location: "cloud", enabled: true },
        { id: "ollama/hidden", providerId: "ollama", label: "Hidden", location: "local", enabled: false },
      ],
    },
    settingsModel: "old-local-model",
    result: {},
  }));
  const result = (sandbox as { result: { model: string; sidebar: string; value: string; runModel: string } }).result;
  assert.equal(result.model, result.sidebar);
  assert.match(result.model, /<optgroup label="محلي">/);
  assert.match(result.model, /<optgroup label="سحابي">/);
  assert.match(result.model, /Qwen — ollama/);
  assert.match(result.model, /Claude — openrouter/);
  assert.equal(result.model.includes("Hidden"), false);
  assert.match(result.model, /\(not registered\) old-local-model/);
  assert.equal(result.value, "registry:ollama\tqwen");
  assert.equal(result.runModel, "old-local-model");
});
