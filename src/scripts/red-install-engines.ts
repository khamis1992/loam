/**
 * Red-team engine installer (RED_TEAM_BUILD_SPEC §5.8 / O-3).
 *
 * Downloads pinned official release artifacts and verifies their SHA256 before
 * extraction or execution. A hash is never trusted merely because it was just
 * downloaded: mismatch aborts installation. sqlmap stays an external process
 * (GPL-2.0, licence discipline §5.9); nothing is vendored into Loam.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TOOLS_ROOT = path.join(os.homedir(), ".loam", "tools");
const DOWNLOADS = path.join(TOOLS_ROOT, "downloads");
const REGISTRY = path.join(TOOLS_ROOT, "engines.json");

/** Trusted pins captured from the official upstream release artifacts. */
export const ENGINE_PINS: Record<string, { version: string; url: string; sha256: string }> = {
  nuclei: {
    version: "v3.11.1",
    url: "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_windows_amd64.zip",
    sha256: "bb6cb9ff8939b753f6fcab06fd30a15f5bc61d8382a597871334c007a85ff9d2",
  },
  ffuf: {
    version: "v2.3.0",
    url: "https://github.com/ffuf/ffuf/releases/download/v2.3.0/ffuf_2.3.0_windows_amd64.zip",
    sha256: "091c8a22d0c7fbe07d343b3ae2c213dbd37b38a8a2ed40631fcd3128ea1764fb",
  },
  ysoserial: {
    version: "v0.0.6",
    url: "https://github.com/frohoff/ysoserial/releases/download/v0.0.6/ysoserial-all.jar",
    sha256: "2c9bddd6a1a4ec66c1078ea97dacb61eb66d1c41aec7b6d21e3c72214ce170f1",
  },
  sqlmap: {
    version: "1.10",
    url: "https://codeload.github.com/sqlmapproject/sqlmap/zip/refs/tags/1.10",
    sha256: "97b8fe8e06ed8b6c75c234f111393bae79e2c3d3283c086351354716277dfff1",
  },
  zap: {
    version: "v2.17.0",
    url: "https://github.com/zaproxy/zaproxy/releases/download/v2.17.0/ZAP_2.17.0_Crossplatform.zip",
    sha256: "94c8f767b1c2e94f0db66b3ae56514d5e3f5a728ee1b6c798e0c8fe2d61fbff0",
  },
};

interface EngineRegistry {
  installedAt: string;
  versions: Record<string, string>;
  paths: { nuclei?: string; ffuf?: string; sqlmapScript?: string; ysoserialJar?: string; zapHome?: string };
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

/** Hard-fail unless the downloaded file matches the trusted pin exactly. */
export function assertSha256(file: string, expectedSha256: string): void {
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${path.basename(file)}: expected ${expectedSha256}, got ${actual}`);
  }
}

async function download(url: string, to: string, expectedSha256: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(to, bytes);
  assertSha256(to, expectedSha256);
}

const extractZip = async (zip: string, into: string): Promise<void> => {
  // Refuse traversal before extraction (defense-in-depth alongside the pin).
  const { stdout } = await execFileP("tar", ["-tf", zip], { timeout: 30_000 });
  for (const entry of stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`unsafe zip entry: ${entry}`);
    }
  }
  fs.mkdirSync(into, { recursive: true });
  await execFileP("tar", ["-xf", zip, "-C", into], { timeout: 120_000 });
};

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const registry = loadRegistry();
  const results: string[] = [];

  if (force || !registry.paths.nuclei || !fs.existsSync(registry.paths.nuclei)) {
    const pin = ENGINE_PINS.nuclei!;
    const zip = path.join(DOWNLOADS, `nuclei-${pin.version}.zip`);
    console.log(`nuclei: downloading pinned ${pin.version}…`);
    await download(pin.url, zip, pin.sha256);
    await extractZip(zip, TOOLS_ROOT);
    const exe = path.join(TOOLS_ROOT, "nuclei.exe");
    if (!fs.existsSync(exe)) throw new Error("nuclei: nuclei.exe missing after extract");
    registry.versions.nuclei = pin.version;
    registry.paths.nuclei = exe;
    registry.sha256.nuclei = pin.sha256;
    results.push(`nuclei ${pin.version} -> ${exe}`);
  } else results.push(`nuclei ${registry.versions.nuclei} (cached)`);

  if (force || !registry.paths.ffuf || !fs.existsSync(registry.paths.ffuf)) {
    const pin = ENGINE_PINS.ffuf!;
    const zip = path.join(DOWNLOADS, `ffuf-${pin.version}.zip`);
    console.log(`ffuf: downloading pinned ${pin.version}…`);
    await download(pin.url, zip, pin.sha256);
    await extractZip(zip, TOOLS_ROOT);
    const exe = path.join(TOOLS_ROOT, "ffuf.exe");
    if (!fs.existsSync(exe)) throw new Error("ffuf: ffuf.exe missing after extract");
    registry.versions.ffuf = pin.version;
    registry.paths.ffuf = exe;
    registry.sha256.ffuf = pin.sha256;
    results.push(`ffuf ${pin.version} -> ${exe}`);
  } else results.push(`ffuf ${registry.versions.ffuf} (cached)`);

  if (force || !registry.paths.ysoserialJar || !fs.existsSync(registry.paths.ysoserialJar)) {
    const pin = ENGINE_PINS.ysoserial!;
    const jar = path.join(TOOLS_ROOT, "ysoserial.jar");
    console.log(`ysoserial: downloading pinned ${pin.version}…`);
    await download(pin.url, jar, pin.sha256);
    registry.versions.ysoserial = pin.version;
    registry.paths.ysoserialJar = jar;
    registry.sha256.ysoserial = pin.sha256;
    results.push(`ysoserial ${pin.version} -> ${jar}`);
  } else results.push(`ysoserial ${registry.versions.ysoserial} (cached)`);

  if (force || !registry.paths.sqlmapScript || !fs.existsSync(registry.paths.sqlmapScript)) {
    const pin = ENGINE_PINS.sqlmap!;
    const zip = path.join(DOWNLOADS, `sqlmap-${pin.version}.zip`);
    console.log(`sqlmap: downloading pinned ${pin.version}…`);
    await download(pin.url, zip, pin.sha256);
    const extractInto = path.join(DOWNLOADS, `sqlmap-${pin.version}`);
    await extractZip(zip, extractInto);
    const script = path.join(extractInto, `sqlmap-${pin.version}`, "sqlmap.py");
    if (!fs.existsSync(script)) throw new Error(`sqlmap: sqlmap.py missing after extract (${script})`);
    registry.versions.sqlmap = pin.version;
    registry.paths.sqlmapScript = script;
    registry.sha256.sqlmap = pin.sha256;
    results.push(`sqlmap ${pin.version} -> ${script} (via py launcher)`);
  } else results.push(`sqlmap ${registry.versions.sqlmap} (cached)`);

  if (force || !registry.paths.zapHome || !fs.existsSync(path.join(registry.paths.zapHome, "zap-2.17.0.jar"))) {
    const pin = ENGINE_PINS.zap!;
    const zip = path.join(DOWNLOADS, `zap-${pin.version}.zip`);
    console.log(`ZAP: downloading pinned ${pin.version} (~286 MB)…`);
    await download(pin.url, zip, pin.sha256);
    const zapHome = path.join(TOOLS_ROOT, "zap", "ZAP_2.17.0");
    await extractZip(zip, path.join(TOOLS_ROOT, "zap"));
    if (!fs.existsSync(path.join(zapHome, "zap-2.17.0.jar"))) throw new Error(`ZAP: jar missing after extract (${zapHome})`);
    registry.versions.zap = pin.version;
    registry.paths.zapHome = zapHome;
    registry.sha256.zap = pin.sha256;
    results.push(`ZAP ${pin.version} -> ${zapHome}`);
  } else results.push(`ZAP ${registry.versions.zap} (cached)`);

  registry.installedAt = new Date().toISOString();
  saveRegistry(registry);
  console.log("\nred engine installer: OK (all artifacts SHA256-verified)");
  for (const line of results) console.log(`  - ${line}`);
  console.log(`registry: ${REGISTRY}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`red engine installer FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}
