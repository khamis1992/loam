/**
 * Smoke check for the project wiki: off by default, secrets never reach disk,
 * pages are searchable, a handoff resolves exactly once and is announced as
 * metadata only, and the CURRENT.md export carries no body of a handoff.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-wiki-check-"));
process.env.MANUS_LOCAL_DATA_DIR = path.join(tmp, "data");

const { wikiRoot } = await import("../wiki/paths.js");
const { writePage, readPage } = await import("../wiki/store.js");
const { search, closeIndex } = await import("../wiki/wikiIndex.js");
const { createHandoff, resolveHandoff, closeHandoffs } = await import("../wiki/handoff.js");
const { wikiStartNotice, recordWikiSession } = await import("../wiki/hooks.js");
const { exportCurrent } = await import("../wiki/interop.js");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const workspace = path.join(tmp, "ws");
const root = wikiRoot(workspace);
const off = { workspace };
const on = { workspace, wiki: { enabled: true } };

console.log("project wiki smoke");

createHandoff(root, { title: "Finish the parser", body: "SECRET-BODY-TEXT only for the reader" });
check("disabled wiki announces nothing", wikiStartNotice(off) === "");
check("disabled wiki records nothing", recordWikiSession(off, "t1") === false);

const notice = wikiStartNotice(on);
check("enabled wiki announces the handoff title", notice.includes("Finish the parser"));
check("notice never carries the handoff body", !notice.includes("SECRET-BODY-TEXT"));

const fakeKey = "sk-" + "a1B2c3D4".repeat(6);
writePage(root, { kind: "note", id: "deploy", title: "Deploy steps", body: `run the release script ${fakeKey}`, tags: [] });
const page = readPage(root, "note", "deploy");
check("page round-trips", Boolean(page) && page!.body.includes("release script"));
check("credential is stripped before it reaches disk", !JSON.stringify(page).includes(fakeKey));
check("page is searchable", search(root, "release").some((h) => h.id === "deploy"));

const exported = exportCurrent(root, workspace);
const text = fs.readFileSync(exported, "utf8");
check("CURRENT.md lists the open handoff", text.includes("Finish the parser"));
check("CURRENT.md omits the handoff body", !text.includes("SECRET-BODY-TEXT"));

const first = createHandoff(root, { title: "Second", body: "x" });
check("handoff resolves once", resolveHandoff(root, first.id, "accepted") === true && resolveHandoff(root, first.id, "dismissed") === false);

closeHandoffs();
closeIndex();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "project wiki smoke: PASS" : `project wiki smoke: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
