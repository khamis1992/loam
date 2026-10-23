// Shared static-file serving for the privileged vendor schemes
// (loamfilm:// for the Loam Video wasm editor, loamcraft:// for the Loam
// Docs/Sheets/Slides/Photo/Design wasm apps). Extracted from electron/main.cjs
// so both handlers resolve files and MIME types identically; loamfilm
// behaviour is unchanged.
const path = require("node:path");
const fs = require("node:fs");

// MIME types for the vendor app bundles. Unknown extensions fall back to
// application/octet-stream so they are still downloaded, never sniffed.
const VENDOR_MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** The five internal Craft app ids served by loamcraft://. */
const CRAFT_APP_IDS = ["wordcraft", "gridcraft", "deckcraft", "photocraft", "designcraft"];

/** Whether an id is one of the five vendored Craft apps. */
function isCraftApp(app) {
  return typeof app === "string" && CRAFT_APP_IDS.includes(app.toLowerCase());
}

/** Install target for one Craft app's dist. */
function craftDistDir(root, app) {
  return path.join(root, "electron", "craft", app, "dist");
}

/** Content-Type for a served vendor file path. */
function vendorMime(filePath) {
  return VENDOR_MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Resolve a URL pathname to a real file under one of baseDirs (first match
 * wins). Rejects path traversal (..) and returns null when the file is absent
 * or is not a regular file.
 */
function resolveVendorFile(relPath, baseDirs) {
  const cleaned = relPath.replace(/^\/+/, "");
  for (const baseDir of baseDirs) {
    const baseRoot = path.resolve(baseDir) + path.sep;
    const filePath = path.normalize(path.join(baseDir, cleaned));
    if (!filePath.startsWith(baseRoot)) continue;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  }
  return null;
}

/**
 * Resolve a loamcraft://<app>/<path> request against electron/craft/<app>/dist.
 * Returns null for unknown app ids, traversal attempts and missing files.
 */
function resolveCraftFile(root, request) {
  const url = new URL(request.url);
  const app = url.host.toLowerCase();
  if (!isCraftApp(app)) return null;
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/" || pathname.endsWith("/")) pathname += "index.html";
  return resolveVendorFile(pathname, [craftDistDir(root, app)]);
}

/** 404 Response for an unknown vendor resource. */
function vendorNotFound() {
  return new Response("Not Found", { status: 404 });
}

/** Build a Response for a resolved vendor file with the right Content-Type. */
function vendorResponse(filePath) {
  return new Response(fs.readFileSync(filePath), {
    headers: { "Content-Type": vendorMime(filePath) },
  });
}

module.exports = {
  VENDOR_MIME,
  CRAFT_APP_IDS,
  isCraftApp,
  craftDistDir,
  vendorMime,
  resolveVendorFile,
  resolveCraftFile,
  vendorNotFound,
  vendorResponse,
};
