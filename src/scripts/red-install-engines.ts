/**
 * Red-team engine installer (RED_TEAM_BUILD_SPEC §5.8, open decision O-3:
 * heavy engines are downloaded on first use rather than bundled).
 *
 * Downloads official release artifacts from each engine's upstream project,
 * records their SHA256 and installs them under ~/.loam/tools:
 *   - nuclei  (projectdiscovery/nuclei, MIT)      -> nuclei.exe
 *   - ffuf    (ffuf/ffuf, MIT)                    -> ffuf.exe
 *   - ysoserial (frohoff/ysoserial, MIT)          -> ysoserial.jar (runs on the local JRE)
 *   - sqlmap  (sqlmapproject/sqlmap, GPL-2.0 —    -> sqlmap/sqlmap.py (runs via the local
 *              stays an external process, licence      `py` launcher; never vendored into Loam)
 *              discipline §5.9)
 *
 * The registry is written to ~/.loam/tools/engines.json and consumed by the
 * red capability layer (src/security/red/engines.ts). Idempotent: installed
 * engines are skipped unless --force.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TOOLS_ROOT = path.join(os.homedir(), ".loam", "tools");
const DOWNLOADS = path.join(TOOLS_ROOT, "downloads");
const REGISTRY = path.join(TOOLS_ROOT, "engines.json");

interface EngineRegistry {
  installedAt: string;
  versions: Record<string, string>;
  paths: { nuclei?: string; ffuf?: string; sqlmapScript?: string; ysoserialJar?: string };
  sha256: Record<string, string>;
}

const loadRegistry = (): EngineRegistry => {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as EngineRegistry;
  } catch {
    return { installedAt: new Date().toISOString(), versions: {}, paths: {}, sha256: {} };
  }
};

const saveRegistry = (r: EngineRegistry): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2), "utf8");
};

interface Release {
  tag: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

async function latestRelease(repo: string): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { "user-agent": "loam-red-installer", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${repo}: HTTP ${res.status}`);
  const doc = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
  if (!doc.tag_name || !Array.isArray(doc.assets)) throw new Error(`GitHub API ${repo}: unexpected shape`);
  return { tag: doc.tag_name, assets: doc.assets };
}

async function download(url: string, to: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(to, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

const extractZip = async (zip: string, into: string): Promise<void> => {
  fs.mkdirSync(into, { recursive: true });
  await execFileP("tar", ["-xf", zip, "-C", into], { timeout: 120_000 });
};

const first = <T,>(xs: T[], pred: (x: T) => boolean): T | undefined => xs.find(pred);

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const registry = loadRegistry();
  const results: string[] = [];

  // --- nuclei ----------------------------------------------------------------
  if (force || !registry.paths.nuclei || !fs.existsSync(registry.paths.nuclei)) {
    console.log("nuclei: resolving latest release…");
    const rel = await latestRelease("projectdiscovery/nuclei");
    const asset = first(rel.assets, (a) => /windows_amd64\.zip$/.test(a.name));
    if (!asset) throw new Error("nuclei: no windows_amd64 asset");
    const zip = path.join(DOWNLOADS, `nuclei-${rel.tag}.zip`);
    console.log(`nuclei: downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)…`);
    const sha = await download(asset.browser_download_url, zip);
    await extractZip(zip, TOOLS_ROOT);
    const exe = path.join(TOOLS_ROOT, "nuclei.exe");
    if (!fs.existsSync(exe)) throw new Error("nuclei: nuclei.exe missing after extract");
    registry.versions.nuclei = rel.tag;
    registry.paths.nuclei = exe;
    registry.sha256.nuclei = sha;
    results.push(`nuclei ${rel.tag} -> ${exe}`);
  } else results.push(`nuclei ${registry.versions.nuclei} (cached)`);

  // --- ffuf ------------------------------------------------------------------
  if (force || !registry.paths.ffuf || !fs.existsSync(registry.paths.ffuf)) {
    console.log("ffuf: resolving latest release…");
    const rel = await latestRelease("ffuf/ffuf");
    const asset = first(rel.assets, (a) => /windows_amd64\.zip$/.test(a.name));
    if (!asset) throw new Error("ffuf: no windows_amd64 asset");
    const zip = path.join(DOWNLOADS, `ffuf-${rel.tag}.zip`);
    console.log(`ffuf: downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)…`);
    const sha = await download(asset.browser_download_url, zip);
    await extractZip(zip, TOOLS_ROOT);
    const exe = path.join(TOOLS_ROOT, "ffuf.exe");
    if (!fs.existsSync(exe)) throw new Error("ffuf: ffuf.exe missing after extract");
    registry.versions.ffuf = rel.tag;
    registry.paths.ffuf = exe;
    registry.sha256.ffuf = sha;
    results.push(`ffuf ${rel.tag} -> ${exe}`);
  } else results.push(`ffuf ${registry.versions.ffuf} (cached)`);

  // --- ysoserial ---------------------------------------------------------------
  if (force || !registry.paths.ysoserialJar || !fs.existsSync(registry.paths.ysoserialJar)) {
    console.log("ysoserial: resolving latest release…");
    const rel = await latestRelease("frohoff/ysoserial");
    const asset = first(rel.assets, (a) => /\.jar$/.test(a.name) && !/sources|javadoc/.test(a.name));
    if (!asset) throw new Error("ysoserial: no jar asset");
    const jar = path.join(TOOLS_ROOT, "ysoserial.jar");
    console.log(`ysoserial: downloading ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)…`);
    const sha = await download(asset.browser_download_url, jar);
    registry.versions.ysoserial = rel.tag;
    registry.paths.ysoserialJar = jar;
    registry.sha256.ysoserial = sha;
    results.push(`ysoserial ${rel.tag} -> ${jar}`);
  } else results.push(`ysoserial ${registry.versions.ysoserial} (cached)`);

  // --- sqlmap (external process only; GPL-2.0 stays at arm's length) --------
  if (force || !registry.paths.sqlmapScript || !fs.existsSync(registry.paths.sqlmapScript)) {
    console.log("sqlmap: resolving latest release…");
    const rel = await latestRelease("sqlmapproject/sqlmap");
    // sqlmap publishes tags without release assets; the codeload archive of the
    // tag is the canonical zip.
    const asset = first(rel.assets, (a) => /\.zip$/.test(a.name) && !/-rc\d/.test(a.name));
    const url = asset?.browser_download_url ?? `https://codeload.github.com/sqlmapproject/sqlmap/zip/refs/tags/${rel.tag}`;
    const zip = path.join(DOWNLOADS, `sqlmap-${rel.tag}.zip`);
    console.log(`sqlmap: downloading ${url}…`);
    const sha = await download(url, zip);
    const extractInto = path.join(DOWNLOADS, `sqlmap-${rel.tag}`);
    await extractZip(zip, extractInto);
    const script = path.join(extractInto, `sqlmap-${rel.tag.replace(/^v/, "")}`, "sqlmap.py");
    if (!fs.existsSync(script)) throw new Error(`sqlmap: sqlmap.py missing after extract (looked at ${script})`);
    registry.versions.sqlmap = rel.tag;
    registry.paths.sqlmapScript = script;
    registry.sha256.sqlmap = sha;
    results.push(`sqlmap ${rel.tag} -> ${script} (via py launcher)`);
  } else results.push(`sqlmap ${registry.versions.sqlmap} (cached)`);

  registry.installedAt = new Date().toISOString();
  saveRegistry(registry);
  console.log("\nred engine installer: OK");
  for (const line of results) console.log(`  - ${line}`);
  console.log(`registry: ${REGISTRY}`);
}

main().catch((err: unknown) => {
  console.error(`red engine installer FAILED: ${(err as Error).message}`);
  process.exit(1);
});
