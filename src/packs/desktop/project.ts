import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAppProject, getAppProject, listAppProjects } from '../../appbuilder/projects.js';
import { loadTemplate } from '../../appbuilder/templates.js';
import type { AppProject } from '../../appbuilder/types.js';
import { designDocSkeleton } from '../../appbuilder/designDoc.js';
import { taskPath } from '../../server/taskWorkspace.js';
import { type DesktopTemplateId } from './catalog.js';

export interface DesktopVerification {
  projectId: string;
  verifiedAt: string;
  entry: string;
  nativePackage: false;
  sha256: string;
  files?: Record<string, string>;
}

export function createDesktopProject(input: { title: string; baseWorkspace: string; template?: DesktopTemplateId }): AppProject {
  const template = input.template ?? 'file-organizer';
  const project = createAppProject({ title: input.title, baseWorkspace: input.baseWorkspace, kind: 'electron-app', features: [template] });
  const root = path.join(project.workspaceDir, project.appDir);
  for (const file of loadTemplate('electron-app', [template]).files) {
    const relative = file.path.replace(/\\/g, '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Invalid desktop template path');
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute)) continue;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.content, 'utf8');
  }
  const config = path.join(root, 'desktop-app.json');
  if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({ scenario: template, title: input.title, version: 1 }, null, 2), 'utf8');
  const design = path.join(project.workspaceDir, 'DESIGN.md');
  if (!fs.existsSync(design)) fs.writeFileSync(design, designDocSkeleton(project.title), 'utf8');
  return project;
}

export function attachDesktopProject(projectId: string): AppProject {
  const project = getAppProject(projectId) ?? listAppProjects().find((candidate) => candidate.taskId === projectId);
  if (!project) throw new Error('desktop_project_missing');
  if (project.kind !== 'electron-app') throw new Error('desktop_project_kind_mismatch');
  return project;
}

export function desktopVerificationPath(project: AppProject): string {
  return path.join(project.workspaceDir, '.loam', 'packs', 'loam-desktop', 'verification.json');
}

export function writeDesktopVerification(project: AppProject): DesktopVerification {
  const entry = 'dist/index.html';
  const files = ['package.json', 'electron/main.cjs', 'electron/preload.cjs', 'renderer/index.html', entry];
  const hashes = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(project.workspaceDir, project.appDir, file))).digest('hex')]));
  const verification: DesktopVerification = {
    projectId: project.id,
    verifiedAt: new Date().toISOString(),
    entry,
    nativePackage: false,
    sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
    files: hashes,
  };
  const target = desktopVerificationPath(project);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(verification, null, 2));
  return verification;
}

export function readDesktopVerification(project: AppProject): DesktopVerification {
  const file = desktopVerificationPath(project);
  if (!fs.existsSync(file)) throw new Error('desktop_verification_required');
  const verification = JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopVerification;
  if (verification.projectId !== project.id) throw new Error('desktop_verification_project_mismatch');
  if (!fs.existsSync(taskPath(project.workspaceDir, path.join(project.appDir, verification.entry)))) throw new Error('desktop_entry_missing');
  for (const [relative, expected] of Object.entries(verification.files ?? {})) {
    const absolute = taskPath(project.workspaceDir, path.join(project.appDir, relative));
    const actual = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (actual !== expected) throw new Error('desktop_verification_stale');
  }
  return verification;
}

export function desktopMetadataPath(project: AppProject, workspace = project.workspaceDir): string {
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'desktop-app';
  return taskPath(workspace, `uploads/${slug}.desktop.json`);
}
