import fs from 'node:fs';
import path from 'node:path';
import type { BuildKind, BuildSelection, WebsiteSubtype } from '../../packages/shared/src/buildMenu.js';
import { loadTemplate } from '../appbuilder/templates.js';
import { readMobile, saveMobile } from '../mobile/store.js';
import { starterMobile } from './mobile/fixture.js';
import { simulationDocument } from './mobile/simulation.js';
import { DEFAULT_TIMEZONE, parseCron } from '../server/scheduleTime.js';
import { engineFor, type BuildEngine } from './catalog.js';
import { upcomingRuns, routineReadme, routineUntil, scheduleCard, schedulePage } from './automations/schedule.js';
import { approvedExtensionDigest, assertExtensionManifest, recordApprovedExtension } from './chrome/permissions.js';
import { assertLocalExtension, extensionFiles } from './extensions/source.js';
import { websiteDocument } from './websites/page.js';
import { GAME_LICENSE, gameAssetManifest } from './games/assets.js';
import { gameDocument } from './games/page.js';
import { parseNotebook, writeNotebookPreview } from './notebooks/view.js';
import { routineSendRequested } from '../../packages/shared/src/buildMenu.js';
import { gameScene, readGameBrief } from './games/scene.js';
import { checkedTuning } from './games/tuning.js';
import { currentConversion, macHandoffNote, safariPreviewHtml } from './safari/platform.js';
import { desktopPreviewHtml, desktopPreviewScript } from './desktop/previewPage.js';
import { widgetPreviewHtml, widgetPreviewScript } from './widget/previewPage.js';
import { pageBriefText, recordPlanProvenance, storedBrief } from './planProvenance.js';

export interface Materialized {
  engine: BuildEngine;
  summary: string;
  relativePreview?: string;
}

function finish(root: string, kind: BuildSelection['kind'], result: Materialized): Materialized {
  recordPlanProvenance(root, kind);
  return result;
}

function statOf(absolute: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function markerExists(root: string, relative: string): boolean {
  const stat = statOf(path.join(root, ...relative.split('/')));
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  return true;
}

function electronKind(root: string): 'desktop' | 'widget' {
  const config = path.join(root, 'app', 'desktop-app.json');
  const stat = statOf(config);
  if (!stat) return 'desktop';
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  try {
    const parsed = JSON.parse(fs.readFileSync(config, 'utf8')) as { surface?: unknown };
    return parsed.surface === 'widget' ? 'widget' : 'desktop';
  } catch (error) {
    if (error instanceof SyntaxError) return 'desktop';
    throw error;
  }
}

function occupiedKind(root: string): BuildKind | null {
  if (markerExists(root, 'app/automation.json') || markerExists(root, 'app/routine.json')) return 'automation';
  if (markerExists(root, 'app/notebook.ipynb')) return 'notebook';
  if (markerExists(root, 'app/desktop-app.json') || markerExists(root, 'app/electron/main.cjs')) return electronKind(root);
  if (markerExists(root, 'app/conversion.json')) return 'safari-extension';
  if (markerExists(root, 'app/manifest.json') || markerExists(root, 'app/popup.html') || markerExists(root, 'app/popup.js')) return 'chrome-extension';
  if (markerExists(root, 'app/loam-website.json') || markerExists(root, 'app/src/App.tsx')) return 'website';
  if (markerExists(root, 'app/simulation.html') || markerExists(root, '.loam/mobile.json')) return 'mobile';
  if (markerExists(root, 'app/tuning.json') || gamePage(root)) return 'game';
  if (markerExists(root, 'app/preview.html')) return 'website';
  return null;
}

function gamePage(root: string): boolean {
  const absolute = path.join(root, 'app', 'index.html');
  const stat = statOf(absolute);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  return fs.readFileSync(absolute, 'utf8').includes('function step');
}

function assertSameKind(root: string, kind: BuildKind): void {
  const occupied = occupiedKind(root);
  if (!occupied || occupied === kind) return;
  const extension = occupied === 'chrome-extension' || occupied === 'safari-extension';
  const extensionRequest = kind === 'chrome-extension' || kind === 'safari-extension';
  if (extension && extensionRequest) return;
  const shell = occupied === 'desktop' || occupied === 'widget';
  const shellRequest = kind === 'desktop' || kind === 'widget';
  if (shell && shellRequest) return;
  throw new Error('invalid_request');
}

function keptAutomation(root: string): boolean {
  const file = path.join(root, 'app', 'automation.json');
  const stat = statOf(file);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  let spec: { cron?: unknown; timezone?: unknown; dryRun?: unknown; enabled?: unknown; send?: unknown; previewCount?: unknown };
  try {
    spec = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof spec;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw error;
    throw new Error('invalid_request');
  }
  if (spec.send !== false || spec.dryRun !== true) throw new Error('approval_required');
  if (spec.cron !== '0 9 * * 1' || spec.timezone !== DEFAULT_TIMEZONE) throw new Error('invalid_request');
  if (typeof spec.enabled !== 'boolean') throw new Error('invalid_request');
  if (typeof spec.previewCount !== 'number' || !Number.isInteger(spec.previewCount) || spec.previewCount < 0) throw new Error('invalid_request');
  return true;
}

function keptExtension(root: string): boolean {
  const popup = path.join(root, 'app', 'popup.html');
  const manifest = path.join(root, 'app', 'manifest.json');
  const popupStat = statOf(popup);
  const manifestStat = statOf(manifest);
  if (!popupStat && !manifestStat) return false;
  for (const stat of [popupStat, manifestStat]) {
    if (!stat) throw new Error('invalid_request');
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  }
  const html = fs.readFileSync(popup, 'utf8');
  const raw = fs.readFileSync(manifest, 'utf8');
  if (/https?:\/\//i.test(html) || /https?:\/\//i.test(raw) || !html.includes('id="capture"')) throw new Error('unsafe_path');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('invalid_request');
  }
  assertExtensionManifest(parsed);
  return true;
}

function keptGame(root: string): boolean {
  const page = path.join(root, 'app', 'index.html');
  const pageStat = statOf(page);
  if (!pageStat) return false;
  if (pageStat.isSymbolicLink() || !pageStat.isFile() || pageStat.nlink > 1) throw new Error('unsafe_path');
  const html = fs.readFileSync(page, 'utf8');
  if (/https?:\/\//i.test(html) || !html.includes('function step')) throw new Error('unsafe_path');
  const tuningFile = path.join(root, 'app', 'tuning.json');
  const tuningStat = statOf(tuningFile);
  if (!tuningStat) throw new Error('invalid_tuning');
  if (tuningStat.isSymbolicLink() || !tuningStat.isFile() || tuningStat.nlink > 1) throw new Error('unsafe_path');
  try {
    checkedTuning(JSON.parse(fs.readFileSync(tuningFile, 'utf8')) as { speed: number; gravity: number });
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_tuning') throw error;
    throw new Error('invalid_tuning');
  }
  return true;
}

function keptMobile(root: string): boolean {
  const file = path.join(root, '.loam', 'mobile.json');
  const stat = statOf(file);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe_path');
  return readMobile(root) !== null;
}

function keptNotebook(root: string): boolean {
  const file = path.join(root, 'app', 'notebook.ipynb');
  const stat = statOf(file);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  try {
    parseNotebook(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_notebook') throw error;
    throw new Error('invalid_notebook');
  }
  return true;
}

function keptWebsite(root: string): WebsiteSubtype | null {
  const preview = path.join(root, 'app', 'preview.html');
  const stat = statOf(preview);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe_path');
  const marker = path.join(root, 'app', 'loam-website.json');
  const markerStat = statOf(marker);
  if (!markerStat || markerStat.isSymbolicLink()) return 'landing';
  if (markerStat.nlink > 1) throw new Error('unsafe_path');
  const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { subtype?: unknown };
  switch (parsed.subtype) {
    case 'landing':
    case 'store':
    case 'booking':
    case 'chatbot':
      return parsed.subtype;
    default:
      return 'landing';
  }
}

function writeFile(root: string, relative: string, content: string, replace = false): void {
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes('..')) throw new Error('unsafe_path');
  const absolute = path.join(root, ...normalized.split('/'));
  const stat = statOf(absolute);
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)) throw new Error('unsafe_path');
  if (stat && !replace) return;
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function ensureDesktopPreview(root: string, kind: 'desktop' | 'widget'): void {
  const page = statOf(path.join(root, 'app', 'dist', 'index.html'));
  if (page && (page.isSymbolicLink() || !page.isFile())) throw new Error('unsafe_path');
  if (page) return;
  const brief = storedBrief(root);
  const html = kind === 'widget' ? widgetPreviewHtml(brief) : desktopPreviewHtml(brief);
  const script = kind === 'widget' ? widgetPreviewScript() : desktopPreviewScript();
  refuseScaffoldHtml(html);
  refuseScaffoldScript(script);
  writeFile(root, 'app/dist/index.html', html);
  writeFile(root, 'app/dist/preview.js', script);
}

function appIsEmpty(root: string): boolean {
  const app = path.join(root, 'app');
  const stat = statOf(app);
  if (!stat) return true;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_path');
  return fs.readdirSync(app).length === 0;
}

function writeTemplate(root: string, id: 'web-app' | 'electron-app'): void {
  for (const file of loadTemplate(id).files) {
    writeFile(root, `app/${file.path.replace(/\\/g, '/')}`, file.content);
  }
}

export function materialize(input: {
  selection: BuildSelection;
  workspace: string;
  title: string;
}): Materialized {
  const title = input.title.trim().slice(0, 80) || 'مشروع';
  const engine = engineFor(input.selection.kind);
  const root = input.workspace;
  assertSameKind(root, input.selection.kind);
  switch (input.selection.kind) {
    case 'website': {
      const kept = keptWebsite(root);
      if (kept) return finish(root, input.selection.kind, { engine, summary: kept, relativePreview: 'app/preview.html' });
      if (!appIsEmpty(root)) throw new Error('invalid_request');
      const preview = websiteDocument(title, input.selection.subtype, storedBrief(root));
      refuseScaffoldHtml(preview);
      writeTemplate(root, 'web-app');
      writeFile(root, 'app/loam-website.json', `${JSON.stringify({ subtype: input.selection.subtype }, null, 2)}\n`);
      writeFile(root, 'app/preview.html', preview);
      return finish(root, input.selection.kind, { engine, summary: input.selection.subtype, relativePreview: 'app/preview.html' });
    }
    case 'desktop':
    case 'widget': {
      writeTemplate(root, 'electron-app');
      const configPath = path.join(root, 'app', 'desktop-app.json');
      let current: Record<string, unknown>;
      try {
        const stat = fs.lstatSync(configPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
        current = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        current = { scenario: 'file-organizer', title, version: 1 };
      }
      current.title = title;
      current.version = 1;
      if (input.selection.kind === 'desktop') current.ipc = 'notes';
      if (input.selection.kind === 'widget') current.surface = 'widget';
      writeFile(root, 'app/desktop-app.json', `${JSON.stringify(current, null, 2)}\n`, true);
      ensureDesktopPreview(root, input.selection.kind);
      return finish(root, input.selection.kind, { engine, summary: input.selection.kind === 'widget' ? 'widget' : 'window', relativePreview: 'app/dist/index.html' });
    }
    case 'automation': {
      if (keptAutomation(root)) return finish(root, input.selection.kind, { engine, summary: '0 9 * * 1 Asia/Qatar', relativePreview: 'app/preview.html' });
      const cron = '0 9 * * 1';
      parseCron(cron);
      const until = routineUntil(readGameBrief(root));
      const spec = {
        cron,
        timezone: DEFAULT_TIMEZONE,
        dryRun: true,
        enabled: false,
        send: false,
        previewCount: 0,
        ...(until ? { until } : {}),
      };
      writeFile(root, 'app/automation.json', `${JSON.stringify(spec, null, 2)}\n`);
      writeFile(root, 'app/routine.json', `${JSON.stringify({ version: 1, cron, timezone: DEFAULT_TIMEZONE, enabled: false, effects: ['local-report'], where: 'this-device' }, null, 2)}\n`);
      writeFile(root, 'app/README.md', routineReadme);
      const card = scheduleCard(upcomingRuns(cron, new Date('2026-11-06T12:00:00Z'), 3, until), until);
      const preview = schedulePage(card, routineSendRequested(readGameBrief(root)), storedBrief(root));
      refuseScaffoldHtml(preview);
      writeFile(root, 'app/schedule.txt', card);
      writeFile(root, 'app/preview.html', preview);
      writeFile(root, 'app/report.txt', 'dry-run: no outbound send\n');
      return finish(root, input.selection.kind, { engine, summary: `${cron} ${DEFAULT_TIMEZONE}`, relativePreview: 'app/preview.html' });
    }
    case 'notebook': {
      if (!keptNotebook(root)) {
        const notebook = {
          nbformat: 4,
          nbformat_minor: 5,
          metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
          cells: [{ id: 'cell-1', cell_type: 'code', source: ['print("loam")\n'], outputs: [], metadata: {}, execution_count: null }],
        };
        writeFile(root, 'app/notebook.ipynb', `${JSON.stringify(notebook, null, 2)}\n`);
      }
      writeNotebookPreview(root);
      return finish(root, input.selection.kind, { engine, summary: 'nbformat 4', relativePreview: 'app/preview.html' });
    }
    case 'mobile': {
      const kept = keptMobile(root);
      if (!kept && statOf(path.join(root, 'app', 'simulation.html'))) throw new Error('invalid_request');
      if (!kept) {
        const starter = starterMobile();
        saveMobile(root, { ...starter, title }, 0, 'build-menu');
      }
      const project = readMobile(root);
      if (!project?.screens[0]) throw new Error('tool_failed');
      const html = simulationDocument(project, storedBrief(root));
      refuseScaffoldHtml(html);
      writeFile(root, 'app/simulation.html', html, true);
      return finish(root, input.selection.kind, { engine, summary: 'home', relativePreview: 'app/simulation.html' });
    }
    case 'chrome-extension':
    case 'safari-extension': {
      if (keptExtension(root)) return finish(root, input.selection.kind, { engine, summary: input.selection.kind, relativePreview: 'app/popup.html' });
      const files = extensionFiles(title, storedBrief(root) || readGameBrief(root)).map((file) => (
        input.selection.kind === 'safari-extension' && file.path === 'popup.html'
          ? { ...file, content: safariPreviewHtml(file.content) }
          : file
      ));
      assertLocalExtension(files);
      for (const file of files) {
        if (file.path.endsWith('.html')) refuseScaffoldHtml(file.content);
        if (file.path.endsWith('.js')) refuseScaffoldScript(file.content);
      }
      for (const file of files) writeFile(root, `app/${file.path}`, file.content);
      if (input.selection.kind === 'safari-extension') {
        const conversion = currentConversion();
        writeFile(root, 'app/conversion.json', `${JSON.stringify({ conversion, platform: process.platform, safariTested: false }, null, 2)}\n`);
        writeFile(root, 'app/README-mac.md', macHandoffNote());
      }
      recordApprovedExtension(root);
      return finish(root, input.selection.kind, { engine, summary: input.selection.kind, relativePreview: 'app/popup.html' });
    }
    case 'game': {
      if (keptGame(root)) return finish(root, input.selection.kind, { engine, summary: 'canvas', relativePreview: 'app/index.html' });
      const page = gameDocument(title, gameScene(readGameBrief(root)), pageBriefText(storedBrief(root)));
      refuseScaffoldHtml(page);
      const tuning = `${JSON.stringify(checkedTuning({ speed: 200, gravity: 700 }))}\n`;
      writeFile(root, 'app/index.html', page);
      writeFile(root, 'app/tuning.json', tuning);
      writeFile(root, 'app/LICENSE', GAME_LICENSE);
      writeFile(root, 'app/assets/manifest.json', gameAssetManifest([
        { path: 'index.html', text: page },
        { path: 'tuning.json', text: tuning },
        { path: 'LICENSE', text: GAME_LICENSE },
      ]));
      return finish(root, input.selection.kind, { engine, summary: 'canvas', relativePreview: 'app/index.html' });
    }
    default: {
      const unreachable: never = input.selection;
      throw new Error(`missing_requirement:${String(unreachable)}`);
    }
  }
}

export function readPreview(workspace: string, relative: string | undefined, limit = 100_000): string | undefined {
  if (!relative || relative.includes('..') || path.isAbsolute(relative)) return undefined;
  const root = path.resolve(workspace);
  const absolute = path.resolve(root, ...relative.split('/'));
  const contained = path.relative(root, absolute);
  if (contained.startsWith('..') || path.isAbsolute(contained)) return undefined;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  const text = inlineLocalScripts(absolute, fs.readFileSync(absolute, 'utf8'));
  if (remoteMarkup(text)) throw new Error('unsafe_path');
  return text.length <= limit ? text : text.slice(0, limit);
}

const HANDSET = /(?:^|[^A-Za-z0-9])(?:mailto|tel|sms|intent|market)\s*:/i;

function decodePercents(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function joinQuoteSplits(value: string): string {
  let current = value;
  let previous = '';
  while (current !== previous) {
    previous = current;
    current = current.replace(/['"]\s*\+\s*['"]/g, '');
  }
  return current;
}

function unfoldEntities(value: string): string {
  let current = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = current
      .replace(/&amp;/gi, '&')
      .replace(/&quot;|&#0*34;(?![0-9])|&#x0*22;(?![0-9a-f])/gi, '"')
      .replace(/&apos;|&#0*39;(?![0-9])|&#x0*27;(?![0-9a-f])/gi, "'")
      .replace(/&colon;|&#0*58;(?![0-9])|&#x0*3a;(?![0-9a-f])/gi, ':');
    if (next === current) return current;
    current = next;
  }
  return current;
}

function containsHandset(value: string): boolean {
  const seen = new Set<string>();
  let pending = [value];
  for (let depth = 0; depth < 3; depth += 1) {
    const layer = pending;
    pending = [];
    for (const item of layer) {
      if (seen.has(item)) continue;
      seen.add(item);
      const opened = joinQuoteSplits(unfoldEntities(item));
      if (HANDSET.test(item) || HANDSET.test(opened)) return true;
      if (depth === 2) continue;
      for (const decoded of [decodePercents(opened), decodePercents(item)]) {
        if (!seen.has(decoded)) pending.push(decoded);
      }
    }
  }
  return false;
}

function refuseScaffoldHtml(html: string): void {
  if (remoteMarkup(html)) throw new Error('unsafe_path');
}

function refuseScaffoldScript(source: string): void {
  if (remoteScriptSource(source)) throw new Error('unsafe_path');
}

function remoteMarkup(html: string): boolean {
  const markup = html
    .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, '')
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '');
  if (/https?:\/\//i.test(markup) || /javascript\s*:/i.test(markup)) return true;
  if (/<script\b[^>]*[\s/]src\s*=\s*['"]?\s*(?:\/\/|data:|file:|blob:|(?:mailto|tel|sms|intent|market)\s*:)/i.test(markup)) return true;
  if (/[\s/.](?:formaction|href|action)\s*=\s*['"]?\s*(?:\/\/|data:|file:|blob:|(?:mailto|tel|sms|intent|market)\s*:)/i.test(markup)) return true;
  if (containsHandset(markup)) return true;
  const outside = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  return (outside.match(/<[^>]*>/g) ?? []).some((tag) => /\son[a-z]+\s*=/i.test(tag));
}

function remoteScriptSource(source: string): boolean {
  if (/https?:\/\//i.test(source) || /javascript\s*:/i.test(source) || containsHandset(source)) return true;
  return /(?<!:)\/\//.test(source);
}

function inlineLocalScripts(htmlFile: string, html: string): string {
  let inlined = false;
  const page = html.replace(/<script src="([^"]+)"><\/script>/g, (_match, src: string) => {
    const name = src.startsWith('./') ? src.slice(2) : src;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('unsafe_path');
    const scriptPath = path.resolve(path.dirname(htmlFile), name);
    if (path.dirname(scriptPath) !== path.resolve(path.dirname(htmlFile))) throw new Error('unsafe_path');
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(scriptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('unsafe_path');
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
    const source = fs.readFileSync(scriptPath, 'utf8');
    if (source.includes('</script') || remoteScriptSource(source)) throw new Error('unsafe_path');
    inlined = true;
    return `<script>${source}</script>`;
  });
  return inlined ? page.replace("script-src 'self'", "script-src 'unsafe-inline'") : page;
}
