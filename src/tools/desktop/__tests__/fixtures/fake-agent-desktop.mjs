#!/usr/bin/env node
// Test double for the agent-desktop CLI (Loam-authored). Selected by env
// FAKE_AD_MODE; prints envelope-version-2.5 JSON on stdout exactly like the
// real binary, so runAd's parser is exercised for real.
const VERSION = "2.5";
const ok = (command, data) => process.stdout.write(JSON.stringify({ version: VERSION, ok: true, command, data }) + "\n");
const fail = (command, code, message, delivery, retry, extra = {}) =>
  process.stdout.write(
    JSON.stringify({
      version: VERSION,
      ok: false,
      command,
      error: { code, message, disposition: { delivery, retry }, ...extra },
    }) + "\n",
  );

const mode = process.env.FAKE_AD_MODE ?? "ok-version";
const argv = process.argv.slice(2);
switch (mode) {
  case "ok-version":
    ok("version", { os: "windows", target: "x86_64", version: "1.0.2-fake" });
    break;
  case "ok-snapshot": {
    const tree = {
      role: "window",
      name: "FakeApp",
      children: [
        { role: "button", name: "OK", ref_id: "@s1:e1" },
        { role: "textfield", name: "Query", ref_id: "@s1:e2", value: "" },
      ],
    };
    ok("snapshot", { app: "FakeApp.exe", window: { id: "w-1", title: "t" }, snapshot_id: "s1", ref_count: 2, complete: true, tree });
    break;
  }
  case "partial-snapshot": {
    const tree = {
      role: "window",
      name: "Big",
      children_count: 500,
      subtree_truncated: true,
      children: [{ role: "button", name: "A", ref_id: "@s2:e1" }],
    };
    ok("snapshot", { app: "Big.exe", window: { id: "w-2", title: "t" }, snapshot_id: "s2", ref_count: 1, complete: false, truncated: true, nodes_observed: 501, tree });
    break;
  }
  case "ok-no-disposition":
    // §1.3 rule: missing disposition on a success must be treated as
    // delivered_unverified / unsafe by the CALLER; the wire form itself just
    // omits it.
    ok("click", { note: "no disposition field" });
    break;
  case "garbage":
    process.stdout.write("this is not json\nsecond line\n");
    break;
  case "exit2-parse-error":
    fail("get", "INVALID_ARGS", "the `--property` flag is required for non-text", "not_delivered", "safe");
    process.exitCode = 2;
    break;
  case "sleep":
    setTimeout(() => ok("version", {}), 30_000);
    break;
  case "echo":
    ok("echo", { argv });
    break;
  default: {
    // Any of the 16 error codes, selected as FAKE_AD_MODE=err:CODE
    if (mode.startsWith("err:")) {
      const code = mode.slice(4);
      const retrySafe = code === "ELEMENT_NOT_FOUND" || code === "STALE_REF" || code === "AMBIGUOUS_TARGET" ||
        code === "SNAPSHOT_NOT_FOUND" || code === "INVALID_ARGS" || code === "WINDOW_NOT_FOUND" ||
        code === "APP_NOT_FOUND" || code === "TIMEOUT" || code === "NOTIFICATION_NOT_FOUND" ||
        code === "PLATFORM_NOT_SUPPORTED" || code === "PERM_DENIED" || code === "POLICY_DENIED" ||
        code === "ACTION_NOT_SUPPORTED";
      fail(
        "op",
        code,
        `fake ${code}`,
        retrySafe ? "not_delivered" : "unknown",
        retrySafe ? "safe" : "unsafe",
        code === "STALE_REF" ? { recovery: { strategy: "resnapshot", retryable: true, requires_fresh_snapshot: true } } : {},
      );
    } else {
      fail("op", "INTERNAL", `unknown FAKE_AD_MODE ${mode}`, "unknown", "unknown");
    }
  }
}
