/** Track-changes sidecar persistence for the workspace doc editor.
 *
 *  IMPORTANT: this stores Loam's own plain-JSON tracked-changes model
 *  (packages/shared/src/trackChanges.ts) next to the document. It is NOT the
 *  Word-native w:ins/w:del revision markup — accepting/rejecting changes in the
 *  web editor writes plain text back into the document surface, and the sidecar
 *  is never embedded into the .docx itself. */
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DocFileError } from "./docIO.js";
import { taskPath } from "../taskWorkspace.js";

/** Hard cap for the serialized sidecar payload (2 MB). */
export const TRACK_SIDECAR_MAX_BYTES = 2_000_000;

/** Where sidecars live inside the task workspace: .loam/track/<sha1-of-rel>.json */
function sidecarPath(workspace: string, rel: string): string {
  const hash = createHash("sha1").update(rel).digest("hex");
  return taskPath(workspace, path.join(".loam", "track", `${hash}.json`));
}

/** Minimal structural validation: an object with a `paragraphs` array whose
 *  entries carry string ids and run arrays. The full model is re-validated by
 *  the pure functions on the client; this only guards storage abuse. */
export function assertTrackPayload(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("track must be an object");
  const doc = value as Record<string, unknown>;
  if (!Array.isArray(doc.paragraphs)) fail("track.paragraphs must be an array");
  if (doc.paragraphs.length > 2000) fail("track.paragraphs too large");
  for (const paragraph of doc.paragraphs) {
    if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) fail("track.paragraphs entries must be objects");
    const entry = paragraph as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id) fail("track.paragraphs entries need a string id");
    if (!Array.isArray(entry.runs)) fail("track.paragraphs entries need a runs array");
  }
  if (doc.threads !== undefined && !Array.isArray(doc.threads)) fail("track.threads must be an array");
  if (doc.authors !== undefined && (!doc.authors || typeof doc.authors !== "object" || Array.isArray(doc.authors))) fail("track.authors must be an object");
}

function fail(message: string): never {
  throw new DocFileError(message, 400);
}

/** Read the stored sidecar for `rel`, or null when none exists. */
export function loadDocTrack(workspace: string, rel: string): unknown | null {
  const file = sidecarPath(workspace, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new DocFileError("Stored track-changes sidecar is corrupted", 500);
  }
}

/** Atomically persist the tracked document (mkdir -p + .tmp + rename, like docIO). */
export function saveDocTrack(workspace: string, rel: string, track: unknown): void {
  assertTrackPayload(track);
  const file = sidecarPath(workspace, rel);
  const json = JSON.stringify(track);
  if (Buffer.byteLength(json, "utf8") > TRACK_SIDECAR_MAX_BYTES) fail("Tracked document too large (2 MB cap)");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}-${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, json, { flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
