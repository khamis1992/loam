/**
 * Neo N15 — server bundle builder.
 *
 * Wraps the plain esbuild invocation for `dist/server.cjs` so the Case
 * Playbook flow JSON ships inside the bundle.
 *
 * Why: the packaged app runs `dist/server.cjs` out of `resources/app.asar`.
 * `src/templates/flows/*.json` is not part of that asar, and `import.meta` is
 * unavailable in a CJS bundle, so `catalog.ts` cannot read the files from disk
 * at runtime. Instead the esbuild `onLoad` below prepends a statement to
 * `catalog.ts` that stashes the parsed JSON on `globalThis`.
 */
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const FLOWS_DIR = path.join(__dirname, "..", "src", "templates", "flows");
const CATALOG_REL = "src/templates/flows/catalog.ts";

/** Read and parse every `*.json` flow template, keyed by slug. */
function readFlows() {
  const files = {};
  for (const name of fs.readdirSync(FLOWS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const slug = name.slice(0, -".json".length);
    files[slug] = JSON.parse(fs.readFileSync(path.join(FLOWS_DIR, name), "utf8"));
  }
  return files;
}

const inlineFlows = {
  name: "inline-flow-templates",
  setup(build) {
    build.onLoad({ filter: /catalog\.ts$/ }, (args) => {
      // Match the flow catalog only, not every catalog.ts in the tree.
      const rel = path.relative(process.cwd(), args.path);
      if (rel.split(path.sep).join("/") !== CATALOG_REL) return null;
      const source = fs.readFileSync(args.path, "utf8");
      const files = readFlows();
      // Prepend a single top-level statement that stashes the JSON on
      // `globalThis`. The catalog reads it lazily, so this stays correct even
      // though esbuild hoists `var` declarations above any other statement.
      const injection = `globalThis.__LOAM_FLOW_TEMPLATES__ = ${JSON.stringify(files)};\n`;
      return { contents: injection + source, loader: "ts" };
    });
  },
};

async function main() {
  const result = await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: "dist/server.cjs",
    external: [
      "playwright",
      "node-pty",
      "@modelcontextprotocol/sdk",
      "sharp",
      "@nut-tree-fork/nut-js",
    ],
    plugins: [inlineFlows],
    metafile: false,
  });

  const errors = result.errors || [];
  if (errors.length > 0) {
    esbuild.formatMessages(errors, { kind: "error", color: true }).then((m) => {
      for (const line of m) console.error(line);
    });
    process.exitCode = 1;
    return;
  }

  fs.copyFileSync(
    "node_modules/pdfjs-dist/build/pdf.worker.mjs",
    "dist/pdf.worker.mjs"
  );
  console.log("server bundle + pdf worker written to dist/");
}

/** Exported for reuse by other scripts. */
module.exports = { inlineFlows };

/**
 * Run the build when invoked as a script. `npm run build:server` uses
 * `node -e "require('./scripts/build-server.cjs')"`, where `require.main` is
 * the `-e` script rather than this file, so check the argv shape as well.
 */
const invokedAsScript =
  require.main === module ||
  !process.argv[1] || // `node -e`
  process.argv[1].endsWith("build-server.cjs");

if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
