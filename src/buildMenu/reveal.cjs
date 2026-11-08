'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ID = /^app_[a-z2-7]{12}$/;
const ARTIFACT_ID = /^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseRevealRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_request');
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('projectId') || !keys.includes('artifactId')) throw new Error('invalid_request');
  const projectId = body.projectId;
  const artifactId = body.artifactId;
  if (typeof projectId !== 'string' || typeof artifactId !== 'string') throw new Error('invalid_request');
  if (!PROJECT_ID.test(projectId) || !ARTIFACT_ID.test(artifactId)) throw new Error('invalid_request');
  return { projectId, artifactId };
}

function assertRevealCaller(input) {
  const senderUrl = String(input.senderUrl || '');
  const origin = String(input.appOrigin || '');
  const allowed = origin !== '' && (senderUrl === `${origin}/` || senderUrl.startsWith(`${origin}/`));
  if (!allowed) throw new Error('invalid IPC sender');
  if (typeof input.sessionToken !== 'string' || input.sessionToken.length < 8) throw new Error('unauthenticated');
  return parseRevealRequest(input.body);
}

function allowedName(artifactId, filename) {
  return filename === `${artifactId}.zip` || filename === `${artifactId}.ipynb` || filename === `${artifactId}.apk`;
}

function assertLocalDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_path');
}

function isContainedArtifact(rootReal, fileReal, filename) {
  const rel = path.relative(rootReal, fileReal);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const expected = path.join('.loam', 'build-menu', 'artifacts', filename);
  if (process.platform === 'win32') return rel.toLowerCase() === expected.toLowerCase();
  return rel === expected;
}

function revealArtifactFile(workspace, projectId, artifactId) {
  const parsed = parseRevealRequest({ projectId, artifactId });
  const root = path.resolve(workspace);
  const dir = path.resolve(root, '.loam', 'build-menu', 'artifacts');
  assertLocalDirectory(path.join(root, '.loam'));
  assertLocalDirectory(path.join(root, '.loam', 'build-menu'));
  assertLocalDirectory(dir);
  const metaPath = path.join(dir, `${parsed.artifactId}.json`);
  const metaStat = fs.lstatSync(metaPath);
  if (!metaStat.isFile() || metaStat.isSymbolicLink()) throw new Error('unsafe_path');
  const artifact = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (artifact.projectId !== parsed.projectId || artifact.artifactId !== parsed.artifactId) throw new Error('not_found');
  const filename = path.basename(String(artifact.relativePath || ''));
  if (!allowedName(parsed.artifactId, filename)) throw new Error('invalid_request');
  if (artifact.relativePath !== `.loam/build-menu/artifacts/${filename}`) throw new Error('invalid_request');
  const filePath = path.join(dir, filename);
  const fileStat = fs.lstatSync(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('unsafe_path');
  const rootReal = fs.realpathSync(root);
  const fileReal = fs.realpathSync(filePath);
  if (!isContainedArtifact(rootReal, fileReal, filename)) throw new Error('unsafe_path');
  return fileReal;
}

module.exports = { parseRevealRequest, assertRevealCaller, revealArtifactFile };
