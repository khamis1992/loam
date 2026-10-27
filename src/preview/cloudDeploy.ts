/**
 * Real static cloud deploys for delivered company runs (BUILD_SPEC §6.7,
 * proposal 5). Invoked ONLY by the user-initiated, origin-checked launch
 * endpoint — never registered as an agent tool — so no model can publish.
 *
 * Scope is static output only: Vercel inline-file deployments
 * (POST /v13/deployments) and Netlify ZIP deploys
 * (POST /api/v1/sites/{site_id}/deploys). A Node HTTP service is refused
 * with an explanation, because static hosting would silently drop its API.
 */
import fs from "node:fs";
import path from "node:path";
import { zipBuffer, type ZipEntry } from "./zip.js";

export type CloudTarget = "vercel" | "netlify";
export const CLOUD_TARGETS: readonly CloudTarget[] = ["vercel", "netlify"];
export const MAX_DEPLOY_FILES = 2000;
export const MAX_DEPLOY_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const POLL_TIMEOUT_MS = 180_000;
export const POLL_INTERVAL_MS = 3000;

const SKIP = new Set([".loam", ".git", "node_modules", ".env", "backups", "coverage", ".preview-shots"]);

export interface StaticBundle { files: ZipEntry[]; bytes: number }

export interface CloudDeployRequest {
  target: CloudTarget;
  dir: string;
  projectName: string;
  token: string;
  production: boolean;
  siteId?: string;
  teamId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutMs?: number;
}

export interface CloudDeployOutcome {
  ok: boolean;
  target: CloudTarget;
  url: string | null;
  deploymentId?: string;
  siteId?: string;
  state?: string;
  files: number;
  bytes: number;
  message: string;
}

/** Collects a static directory, refusing secrets-bearing and oversized content. */
export function collectStaticBundle(dir: string): StaticBundle {
  const root = path.resolve(dir);
  const files: ZipEntry[] = []; let bytes = 0;
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIP.has(entry.name) || entry.name.startsWith(".env")) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(child); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(path.join(root, child)).size;
      if (size > MAX_FILE_BYTES) throw new Error(`${child} exceeds ${MAX_FILE_BYTES} bytes; static deploys refuse oversized files`);
      bytes += size;
      if (files.length >= MAX_DEPLOY_FILES || bytes > MAX_DEPLOY_BYTES) throw new Error(`static output exceeds ${MAX_DEPLOY_FILES} files or ${MAX_DEPLOY_BYTES} bytes`);
      files.push({ name: child, data: fs.readFileSync(path.join(root, child)) });
    }
  };
  walk("");
  if (!files.some(f => f.name === "index.html")) throw new Error("static output has no index.html at its root");
  return { files, bytes };
}

/** Lower-case, dash-separated project name accepted by both providers. */
export function safeProjectName(raw: string): string {
  const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52);
  return name || "loam-app";
}

/** Removes any occurrence of the token from provider error text before it is stored or shown. */
export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try { return await response.json() as Record<string, unknown>; } catch { return {}; }
}

/** Vercel: one inline-file deployment, then poll readyState until READY or ERROR. */
export async function deployToVercel(req: CloudDeployRequest): Promise<CloudDeployOutcome> {
  const f = req.fetchImpl ?? fetch; const sleep = req.sleep ?? defaultSleep;
  const bundle = collectStaticBundle(req.dir);
  const query = new URLSearchParams({ skipAutoDetectionConfirmation: "1", ...(req.teamId ? { teamId: req.teamId } : {}) });
  const headers = { authorization: `Bearer ${req.token}`, "content-type": "application/json" };
  const body = {
    name: safeProjectName(req.projectName),
    files: bundle.files.map(file => ({ file: file.name, data: file.data.toString("base64"), encoding: "base64" })),
    projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
    ...(req.production ? { target: "production" } : {}),
  };
  const created = await f(`https://api.vercel.com/v13/deployments?${query}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await readJson(created);
  if (!created.ok) return { ok: false, target: "vercel", url: null, files: bundle.files.length, bytes: bundle.bytes, message: redactToken(`Vercel rejected the deployment (HTTP ${created.status}): ${JSON.stringify(payload.error ?? payload).slice(0, 400)}`, req.token) };
  const id = String(payload.id ?? "");
  let state = String(payload.readyState ?? "QUEUED");
  let url = typeof payload.url === "string" ? `https://${payload.url}` : null;
  const deadline = Date.now() + (req.pollTimeoutMs ?? POLL_TIMEOUT_MS);
  while (id && !["READY", "ERROR", "CANCELED"].includes(state) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const polled = await f(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}${req.teamId ? `?teamId=${encodeURIComponent(req.teamId)}` : ""}`, { headers: { authorization: `Bearer ${req.token}` } });
    const p = await readJson(polled);
    state = String(p.readyState ?? state);
    if (typeof p.url === "string") url = `https://${p.url}`;
  }
  const ok = state === "READY";
  return { ok, target: "vercel", url: ok ? url : null, deploymentId: id, state, files: bundle.files.length, bytes: bundle.bytes, message: ok ? `Deployed to Vercel: ${url}` : `Vercel deployment ${id} ended in state ${state}` };
}

/** Netlify: create the site when no id is configured, upload one ZIP, then poll until ready or error.
 * A ZIP deploy publishes to the site; `production` only affects Vercel (see §13 UNKNOWN U-9). */
export async function deployToNetlify(req: CloudDeployRequest): Promise<CloudDeployOutcome> {
  const f = req.fetchImpl ?? fetch; const sleep = req.sleep ?? defaultSleep;
  const bundle = collectStaticBundle(req.dir);
  const auth = { authorization: `Bearer ${req.token}` };
  let siteId = req.siteId;
  if (!siteId) {
    const site = await f("https://api.netlify.com/api/v1/sites", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: `${safeProjectName(req.projectName)}-${Date.now().toString(36)}` }) });
    const s = await readJson(site);
    if (!site.ok || typeof s.id !== "string") return { ok: false, target: "netlify", url: null, files: bundle.files.length, bytes: bundle.bytes, message: redactToken(`Netlify could not create a site (HTTP ${site.status}): ${JSON.stringify(s).slice(0, 400)}`, req.token) };
    siteId = s.id;
  }
  const zip = zipBuffer(bundle.files);
  const created = await f(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, { method: "POST", headers: { ...auth, "content-type": "application/zip" }, body: new Uint8Array(zip) });
  const payload = await readJson(created);
  if (!created.ok) return { ok: false, target: "netlify", url: null, siteId, files: bundle.files.length, bytes: bundle.bytes, message: redactToken(`Netlify rejected the deploy (HTTP ${created.status}): ${JSON.stringify(payload).slice(0, 400)}`, req.token) };
  const id = String(payload.id ?? "");
  let state = String(payload.state ?? "uploaded");
  let url = typeof payload.deploy_ssl_url === "string" ? payload.deploy_ssl_url : typeof payload.ssl_url === "string" ? payload.ssl_url : null;
  const deadline = Date.now() + (req.pollTimeoutMs ?? POLL_TIMEOUT_MS);
  while (id && !["ready", "error"].includes(state) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const polled = await f(`https://api.netlify.com/api/v1/deploys/${encodeURIComponent(id)}`, { headers: auth });
    const p = await readJson(polled);
    state = String(p.state ?? state);
    if (typeof p.deploy_ssl_url === "string") url = p.deploy_ssl_url;
    else if (typeof p.ssl_url === "string") url = p.ssl_url;
  }
  const ok = state === "ready";
  return { ok, target: "netlify", url: ok ? url : null, deploymentId: id, siteId, state, files: bundle.files.length, bytes: bundle.bytes, message: ok ? `Deployed to Netlify: ${url}` : `Netlify deploy ${id} ended in state ${state}` };
}

/** Dispatches to the provider. Errors are converted to an outcome with the token redacted. */
export async function deployStatic(req: CloudDeployRequest): Promise<CloudDeployOutcome> {
  try { return req.target === "vercel" ? await deployToVercel(req) : await deployToNetlify(req); }
  catch (error) { return { ok: false, target: req.target, url: null, files: 0, bytes: 0, message: redactToken(String(error instanceof Error ? error.message : error), req.token).slice(0, 600) }; }
}

/** True when a static UI calls same-origin API routes that static hosting cannot serve. */
export function callsSameOriginApi(html: string): boolean {
  return /fetch\(\s*["'`]\/(?!\/)/.test(html) || /fetch\(\s*["'`](?:\.\/)?api\//.test(html) || /XMLHttpRequest/.test(html);
}
