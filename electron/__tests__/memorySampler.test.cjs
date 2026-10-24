// Unit tests for electron/memorySampler.cjs: the J7 renderer-RSS attribution.
//
// Run with: node --test electron/__tests__/memorySampler.test.cjs
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { sampleRendererRssMB, selectRendererMetrics, sumWorkingSetMB, webContentsPids, windowWebContents } =
  require("../memorySampler.cjs");

function metric(pid, type, workingSetKb) {
  return { pid, type, memory: { workingSetSize: workingSetKb, peakWorkingSetSize: 0, privateBytes: 0 } };
}

function fakeWindow(pid, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, getOSProcessId: () => pid },
  };
}

describe("memorySampler", () => {
  it("sums working sets in MB", () => {
    assert.equal(sumWorkingSetMB([metric(1, "Tab", 1024)]), 1);
    assert.equal(sumWorkingSetMB([metric(1, "Tab", 512), metric(2, "Tab", 512)]), 1);
    assert.equal(sumWorkingSetMB([]), 0);
    assert.equal(sumWorkingSetMB(undefined), 0);
    // A row without a numeric workingSetSize contributes nothing.
    assert.equal(sumWorkingSetMB([{ pid: 1, type: "Tab" }]), 0);
  });

  it("keeps only Tab rows whose pid is a renderer we own", () => {
    const rows = [metric(10, "Tab", 100), metric(11, "Tab", 200), metric(12, "GPU", 400), metric(13, "Tab", 800)];
    const selected = selectRendererMetrics(rows, new Set([10, 11]));
    assert.deepEqual(selected.map((r) => r.pid), [10, 11]);
    assert.equal(sumWorkingSetMB(selected), 300 / 1024);
  });

  it("returns nothing when no renderer pids are supplied", () => {
    assert.deepEqual(selectRendererMetrics([metric(10, "Tab", 100)], new Set()), []);
    assert.deepEqual(selectRendererMetrics([metric(10, "Tab", 100)], undefined), []);
  });

  it("ignores malformed rows instead of crashing", () => {
    const rows = [null, { pid: "10", type: "Tab", memory: { workingSetSize: 100 } }, { pid: 10, type: "Tab" }];
    assert.deepEqual(selectRendererMetrics(rows, new Set([10])), []);
  });

  it("resolves renderer pids from webContents.getOSProcessId()", () => {
    assert.deepEqual(webContentsPids([fakeWindow(10).webContents, fakeWindow(11).webContents]), [10, 11]);
    // A webContents without the accessor is skipped rather than throwing.
    assert.deepEqual(webContentsPids([{ getOSProcessId: undefined }, null]), []);
  });

  it("skips destroyed windows when collecting webContents", () => {
    const list = windowWebContents([fakeWindow(10), fakeWindow(11, true), null]);
    assert.equal(list.length, 1);
    assert.equal(list[0].getOSProcessId(), 10);
  });

  it("reports renderer RSS for owned windows only", () => {
    const app = {
      getAppMetrics: () => [
        metric(1, "Browser", 1000),
        metric(10, "Tab", 1024 * 512), // 512 MB renderer
        metric(11, "Tab", 1024 * 256), // another renderer we do not own
        metric(12, "GPU", 1024 * 2048),
      ],
    };
    const sample = sampleRendererRssMB(app, [fakeWindow(10)]);
    assert.equal(sample.matched, 1);
    assert.ok(Math.abs(sample.mb - 512) < 0.001, `expected ~512 MB, got ${sample.mb}`);
    assert.deepEqual(sample.pids, [10]);
  });

  it("returns a zeroed sample when Electron has no metrics yet", () => {
    const sample = sampleRendererRssMB({ getAppMetrics: () => [] }, [fakeWindow(10)]);
    assert.equal(sample.mb, 0);
    assert.equal(sample.matched, 0);
  });

  it("never throws when the app object is unusable", () => {
    assert.deepEqual(sampleRendererRssMB(undefined, []), { mb: 0, matched: 0, pids: [] });
    assert.equal(sampleRendererRssMB({}, []).mb, 0);
    assert.equal(sampleRendererRssMB({ getAppMetrics: () => { throw new Error("boom"); } }, []).mb, 0);
  });
});
