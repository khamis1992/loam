/**
 * Neo N22 - the docs build CLI.
 *
 * Reads `docs/neo`, builds the manifest, checks every local link and anchor,
 * and prints a one-line verdict. `npm run verify` runs this, so the acceptance
 * criterion ("docs build, links valid") is enforced on every verify.
 *
 * Exit codes: 0 clean, 1 problems found, 2 the guide could not be read at all.
 *
 *   tsx src/scripts/check-docs-links.ts            check only
 *   tsx src/scripts/check-docs-links.ts --write    emit a snapshot for inspection
 *   tsx src/scripts/check-docs-links.ts --json     machine-readable output
 *
 * The in-app help route builds the same manifest from disk on each request, so
 * there is no generated file to keep up to date; `--write` exists to produce a
 * snapshot you can read in a diff, not to refresh anything the app serves.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import {
  NEO_DOC_FILES,
  buildNeoDocs,
  checkNeoDocs,
  type NeoDocProblem,
} from "../docs/neoDocs.js";

const DOC_DIR = path.join(ROOT, "docs", "neo");
const SNAPSHOT = path.join(DOC_DIR, "manifest.snapshot.json");

function parseArgs(argv: string[]): { write: boolean; json: boolean } {
  let write = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: check-docs-links [--write] [--json]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { write, json };
}

/** Read a guide page from disk, or `null` when it does not exist. */
function readFile(file: string): string | null {
  try {
    return fs.readFileSync(path.join(DOC_DIR, file), "utf8");
  } catch {
    return null;
  }
}

function main(): void {
  const { write, json } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DOC_DIR)) {
    const message = `docs/neo not found at ${DOC_DIR}`;
    if (json) console.log(JSON.stringify({ ok: false, problems: [{ code: "no-docs-dir", message }] }));
    else console.error(message);
    process.exit(2);
    return;
  }

  const manifest = buildNeoDocs(DOC_DIR, readFile);
  const problems: NeoDocProblem[] = checkNeoDocs(manifest);

  if (write) {
    const payload = {
      generatedAt: new Date().toISOString(),
      files: manifest.files,
      pages: manifest.pages.map((page) => ({
        file: page.file,
        locale: page.locale,
        title: page.title,
        sections: page.sections,
        anchors: page.anchors,
      })),
      problems: problems.map((problem) => `${problem.code}: ${problem.message}`),
    };
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (!json) {
      console.log(`wrote ${path.relative(ROOT, SNAPSHOT)} (${manifest.pages.length} pages)`);
    }
  }

  if (json) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
  } else if (problems.length > 0) {
    console.error(`docs/neo: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  ${problem.code}  ${problem.message}`);
  } else {
    console.log(`docs/neo: ${manifest.pages.length} pages, ${NEO_DOC_FILES.length} subjects, links OK`);
  }

  process.exit(problems.length > 0 ? 1 : 0);
}

main();
