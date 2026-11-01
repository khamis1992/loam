// Downloads the pinned agent-desktop release (Vercel Labs, Apache-2.0),
// verifies the sha256 of both the tarball and the extracted exe, extracts with
// the Windows System32 tar (GNU tar mangles drive letters), and writes LICENSE
// + VERSION beside it. Unmodified binary only; no npm postinstall, no @latest.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VERSION = "1.0.2";
const BASE = "https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/";
const ASSET = "agent-desktop-v1.0.2-x86_64-pc-windows-msvc.tar.gz";
const TAR_SHA = "2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222";
const EXE_SHA = "409e58cbdd6aed47e29771ffa60bc122a9843505a227af488cded85215943988";
const LICENSE_URL = "https://raw.githubusercontent.com/vercel-labs/agent-desktop/v1.0.2/LICENSE";

const out = path.resolve("resources/agent-desktop");
fs.mkdirSync(out, { recursive: true });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const exeOut = path.join(out, "agent-desktop.exe");

if (fs.existsSync(exeOut) && sha(fs.readFileSync(exeOut)) === EXE_SHA && fs.existsSync(path.join(out, "LICENSE"))) {
  console.log("agent-desktop already vendored");
  process.exit(0);
}

const get = async (u) => {
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const tgz = await get(BASE + ASSET);
if (sha(tgz) !== TAR_SHA) throw new Error("tarball sha256 mismatch");
const sums = (await get(BASE + "checksums.txt")).toString("utf8");
if (!sums.includes(TAR_SHA)) throw new Error("checksums.txt does not list the pinned tarball sha");

const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? out, "ad-"));
const tarFile = path.join(tmp, ASSET);
fs.writeFileSync(tarFile, tgz);
const tarExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
execFileSync(tarExe, ["-xzf", tarFile, "-C", tmp], { stdio: "inherit" });
const exe = fs.readFileSync(path.join(tmp, "agent-desktop.exe"));
if (sha(exe) !== EXE_SHA) throw new Error("exe sha256 mismatch");
fs.writeFileSync(exeOut, exe);
fs.writeFileSync(path.join(out, "LICENSE"), await get(LICENSE_URL));
fs.writeFileSync(
  path.join(out, "VERSION"),
  `agent-desktop ${VERSION} (unmodified binary, Apache-2.0)\nsource https://github.com/vercel-labs/agent-desktop\n`,
);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("agent-desktop vendored", VERSION);
