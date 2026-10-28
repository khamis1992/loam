import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { allEntities, getEntity, putEntity, removeEntity } from "../../server/sqliteStore.js";
import { taskPath } from "../../server/taskWorkspace.js";
import { writeSheetDoc } from "../../server/workspace/sheetIO.js";
import { resolveSecret } from "../../server/secretsVault.js";
import { loadOfficeArtifact } from "./artifactIO.js";
import { isRecord, OfficeIntelligenceError, type ArtifactRef, type OfficeScope } from "./contracts.js";

const CONNECTOR_KIND = "office-data-connectors";

export interface OfficeConnector {
  id: string;
  scope: OfficeScope;
  name: string;
  type: "rest-json" | "sqlite" | "webdav";
  config: {
    url?: string;
    dataPath?: string;
    bearerSecretName?: string;
    databasePath?: string;
    query?: string;
    baseUrl?: string;
    username?: string;
    passwordSecretName?: string;
    remotePath?: string;
    format?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRows {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
  syncedAt: string;
}

function text(value: unknown, name: string, max = 2000, optional = false): string {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) throw new OfficeIntelligenceError(`${name} is invalid`, 422, "invalid_connector");
  return value.trim();
}

export function registerOfficeConnector(input: unknown): OfficeConnector {
  if (!isRecord(input) || !isRecord(input.scope) || !isRecord(input.config)) throw new OfficeIntelligenceError("connector body, scope and config are required", 422, "invalid_connector");
  const type = input.type === "sqlite" ? "sqlite" : input.type === "rest-json" ? "rest-json" : input.type === "webdav" ? "webdav" : undefined;
  if (!type) throw new OfficeIntelligenceError("connector type must be rest-json, sqlite or webdav", 422, "invalid_connector");
  const config: OfficeConnector["config"] = {
    ...(input.config.url ? { url: text(input.config.url, "url", 2000) } : {}),
    ...(input.config.dataPath ? { dataPath: text(input.config.dataPath, "dataPath", 200) } : {}),
    ...(input.config.bearerSecretName ? { bearerSecretName: text(input.config.bearerSecretName, "bearerSecretName", 100) } : {}),
    ...(input.config.databasePath ? { databasePath: text(input.config.databasePath, "databasePath", 500) } : {}),
    ...(input.config.query ? { query: text(input.config.query, "query", 10_000) } : {}),
    ...(input.config.baseUrl ? { baseUrl: text(input.config.baseUrl, "baseUrl", 2000) } : {}),
    ...(input.config.username ? { username: text(input.config.username, "username", 200) } : {}),
    ...(input.config.passwordSecretName ? { passwordSecretName: text(input.config.passwordSecretName, "passwordSecretName", 100) } : {}),
    ...(input.config.remotePath ? { remotePath: text(input.config.remotePath, "remotePath", 2000) } : {}),
    ...(input.config.format ? { format: text(input.config.format, "format", 10) } : {}),
  };
  if (type === "rest-json" || type === "webdav") {
    const raw = new URL(type === "rest-json" ? config.url ?? "" : config.baseUrl ?? "");
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(raw.hostname);
    if (raw.protocol !== "https:" && !(loopback && raw.protocol === "http:")) throw new OfficeIntelligenceError(type === "rest-json" ? "REST connectors require HTTPS outside loopback tests" : "WebDAV connectors require HTTPS outside loopback tests", 422, "invalid_connector");
  }
  if (type === "webdav" && (!config.baseUrl || !config.remotePath || (config.format ?? "csv") !== "csv" && config.format !== "json")) {
    throw new OfficeIntelligenceError("WebDAV connectors require baseUrl, remotePath and format csv|json", 422, "invalid_connector");
  }
  if (type === "sqlite" && (!config.databasePath || !config.query || !/^\s*(?:select|with)\b/i.test(config.query) || /;\s*$/u.test(config.query) || config.query.includes(";") || /\b(?:insert|update|delete|drop|alter|pragma|attach|detach|vacuum)\b/i.test(config.query))) {
    throw new OfficeIntelligenceError("SQLite connectors require one read-only SELECT or WITH query", 422, "invalid_connector");
  }
  const now = new Date().toISOString();
  const connector: OfficeConnector = {
    id: `conn_${randomUUID()}`,
    scope: {
      tenantId: text(input.scope.tenantId, "tenantId", 200),
      ...(input.scope.projectId ? { projectId: text(input.scope.projectId, "projectId", 200) } : {}),
      ...(input.scope.matterId ? { matterId: text(input.scope.matterId, "matterId", 200) } : {}),
    },
    name: text(input.name, "name", 300),
    type,
    config,
    createdAt: now,
    updatedAt: now,
  };
  putEntity(CONNECTOR_KIND, connector);
  return connector;
}

export function getOfficeConnector(id: string): OfficeConnector {
  const connector = getEntity<OfficeConnector>(CONNECTOR_KIND, id);
  if (!connector) throw new OfficeIntelligenceError("connector not found", 404, "connector_not_found");
  return connector;
}

export function listOfficeConnectors(scope: OfficeScope): OfficeConnector[] {
  return allEntities<OfficeConnector>(CONNECTOR_KIND).filter((connector) => connector.scope.tenantId === scope.tenantId && (!scope.projectId || connector.scope.projectId === scope.projectId) && (!scope.matterId || connector.scope.matterId === scope.matterId));
}

export function deleteOfficeConnector(id: string): void {
  getOfficeConnector(id);
  removeEntity(CONNECTOR_KIND, id);
}

function rowsFromObjects(input: unknown): ConnectorRows {
  if (!Array.isArray(input)) throw new OfficeIntelligenceError("connector result must be an array of objects", 422, "connector_data_invalid");
  const records = input.slice(0, 1001).map((row) => {
    if (!isRecord(row)) throw new OfficeIntelligenceError("connector rows must be objects", 422, "connector_data_invalid");
    return row;
  });
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))].slice(0, 100);
  const rows = records.slice(0, 1000).map((row) => columns.map((column) => {
    const value = row[column];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value as string | number | boolean | null;
    return JSON.stringify(value).slice(0, 32_000);
  }));
  return { columns, rows, rowCount: rows.length, truncated: input.length > 1000, syncedAt: new Date().toISOString() };
}

async function fetchRest(connector: OfficeConnector, fetchFn: typeof fetch): Promise<ConnectorRows> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (connector.config.bearerSecretName) {
    const secret = resolveSecret("office", connector.config.bearerSecretName);
    if (!secret) throw new OfficeIntelligenceError("connector secret is unavailable", 503, "connector_secret_unavailable");
    headers.authorization = `Bearer ${secret}`;
  }
  const response = await fetchFn(connector.config.url!, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new OfficeIntelligenceError(`connector returned HTTP ${response.status}`, 502, "connector_failed");
  const textBody = await response.text();
  if (textBody.length > 5_000_000) throw new OfficeIntelligenceError("connector response exceeds 5 MB", 413, "connector_response_too_large");
  let data: unknown;
  try { data = JSON.parse(textBody); } catch { throw new OfficeIntelligenceError("connector did not return valid JSON", 422, "connector_data_invalid"); }
  for (const key of connector.config.dataPath?.split(".").filter(Boolean) ?? []) {
    if (!isRecord(data)) throw new OfficeIntelligenceError("connector dataPath was not found", 422, "connector_data_invalid");
    data = data[key];
  }
  return rowsFromObjects(data);
}

function readSqlite(connector: OfficeConnector, workspace: string): ConnectorRows {
  const databasePath = taskPath(workspace, connector.config.databasePath!);
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) throw new OfficeIntelligenceError("SQLite database not found", 404, "connector_not_found");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = db.prepare(connector.config.query!);
    const columns = statement.columns().map((column) => column.name);
    const rows: Array<Array<string | number | boolean | null>> = [];
    let truncated = false;
    for (const row of statement.iterate()) {
      if (rows.length >= 1000) { truncated = true; break; }
      rows.push(columns.map((column) => {
        const value = (row as Record<string, unknown>)[column];
        return typeof value === "bigint" ? value.toString() : value as string | number | boolean | null;
      }));
    }
    return { columns, rows, rowCount: rows.length, truncated, syncedAt: new Date().toISOString() };
  } finally {
    db.close();
  }
}

/** RFC4180-ish CSV parser: BOM strip, quoted fields with "" escapes, comma/semicolon
 * delimiter auto-detected from the header line. Pure, no dependencies. */
export function parseCsv(input: string): string[][] {
  const text0 = input.replace(/^\uFEFF/, "");
  const headerDelimiter = /;/.test((text0.split(/\r?\n/, 1)[0] ?? "")) ? ";" : ",";
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  let truncated = false;
  for (let i = 0; i < text0.length; i++) {
    const ch = text0[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text0[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === headerDelimiter) { row.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text0[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length >= 1001) { truncated = true; break; }
      continue;
    }
    field += ch;
  }
  if (!truncated) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

function webdavAuthHeaders(connector: OfficeConnector): Record<string, string> {
  const headers: Record<string, string> = {};
  if (connector.config.username) {
    const secret = connector.config.passwordSecretName ? resolveSecret("office", connector.config.passwordSecretName) : undefined;
    if (!secret) throw new OfficeIntelligenceError("connector secret is unavailable", 503, "connector_secret_unavailable");
    headers.authorization = `Basic ${Buffer.from(`${connector.config.username}:${secret}`).toString("base64")}`;
  }
  return headers;
}

function webdavUrl(connector: OfficeConnector): string {
  const base = connector.config.baseUrl!.replace(/\/+$/, "");
  const remote = connector.config.remotePath!.startsWith("/") ? connector.config.remotePath : `/${connector.config.remotePath}`;
  return base + remote.split("?")[0]!.split("#")[0]!;
}

/** WebDAV connectivity probe: PROPFIND (Depth 0) must answer 207 multistatus. */
async function testWebdav(connector: OfficeConnector, fetchFn: typeof fetch): Promise<ConnectorRows> {
  const response = await fetchFn(webdavUrl(connector), {
    method: "PROPFIND",
    headers: { ...webdavAuthHeaders(connector), depth: "0", accept: "application/xml" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new OfficeIntelligenceError("تعذّر الوصول إلى خادم WebDAV", 502, "connector_failed"); });
  if (response.status === 404) throw new OfficeIntelligenceError("الملف غير موجود على خادم WebDAV", 404, "connector_not_found");
  if (response.status === 401 || response.status === 403) throw new OfficeIntelligenceError("تعذّر المصادقة مع خادم WebDAV", 502, "connector_failed");
  if (response.status !== 207) throw new OfficeIntelligenceError(`خادم WebDAV رد بـ HTTP ${response.status}`, 502, "connector_failed");
  const body = (await response.text()).slice(0, 1_000_000);
  const contentType = /<D:getcontenttype>([^<]+)<\/D:getcontenttype>/i.exec(body)?.[1] ?? /<getcontenttype>([^<]+)<\/getcontenttype>/i.exec(body)?.[1] ?? "";
  const modified = /<D:getlastmodified>([^<]+)<\/D:getlastmodified>/i.exec(body)?.[1] ?? /<getlastmodified>([^<]+)<\/getlastmodified>/i.exec(body)?.[1] ?? "";
  return { columns: ["status", "contentType", "modified"], rows: [["207", contentType, modified]], rowCount: 1, truncated: false, syncedAt: new Date().toISOString() };
}

/** WebDAV sync: GET the remote CSV/JSON file and map it through the shared row model. */
async function readWebdav(connector: OfficeConnector, fetchFn: typeof fetch): Promise<ConnectorRows> {
  const response = await fetchFn(webdavUrl(connector), {
    headers: webdavAuthHeaders(connector),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => { throw new OfficeIntelligenceError("تعذّر الوصول إلى خادم WebDAV", 502, "connector_failed"); });
  if (response.status === 404) throw new OfficeIntelligenceError("الملف غير موجود على خادم WebDAV", 404, "connector_not_found");
  if (response.status === 401 || response.status === 403) throw new OfficeIntelligenceError("تعذّر المصادقة مع خادم WebDAV", 502, "connector_failed");
  if (!response.ok) throw new OfficeIntelligenceError(`خادم WebDAV رد بـ HTTP ${response.status}`, 502, "connector_failed");
  const body = await response.text();
  if (body.length > 5_000_000) throw new OfficeIntelligenceError("connector response exceeds 5 MB", 413, "connector_response_too_large");
  if ((connector.config.format ?? "csv") === "json") return rowsFromObjects(JSON.parse(body));
  const table = parseCsv(body);
  if (!table.length) throw new OfficeIntelligenceError("connector did not return CSV rows", 422, "connector_data_invalid");
  const [header, ...data] = table;
  const rows = data.slice(0, 1000).map((cells) => header!.map((_, index) => {
    const raw = cells[index] ?? "";
    if (raw !== "" && /^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw) as string | number;
    return raw;
  }));
  return { columns: header!, rows, rowCount: rows.length, truncated: data.length > 1000, syncedAt: new Date().toISOString() };
}

/** Route "test" action: cheap probe without downloading the payload (PROPFIND for webdav; the normal read otherwise). */
export async function testOfficeConnector(id: string, options: { workspace: string; fetchFn?: typeof fetch }): Promise<ConnectorRows> {
  const connector = getOfficeConnector(id);
  return connector.type === "webdav" ? testWebdav(connector, options.fetchFn ?? fetch) : syncOfficeConnector(id, options);
}

export async function syncOfficeConnector(id: string, options: { workspace: string; fetchFn?: typeof fetch }): Promise<ConnectorRows> {
  const connector = getOfficeConnector(id);
  return connector.type === "sqlite" ? readSqlite(connector, options.workspace) : connector.type === "webdav" ? readWebdav(connector, options.fetchFn ?? fetch) : fetchRest(connector, options.fetchFn ?? fetch);
}

export async function syncConnectorToSheet(id: string, options: { workspace: string; taskId: string; path: string; fetchFn?: typeof fetch }): Promise<ArtifactRef> {
  const connector = getOfficeConnector(id);
  const data = await syncOfficeConnector(id, options);
  if (!data.columns.length) throw new OfficeIntelligenceError("connector returned no columns", 422, "connector_data_invalid");
  const refPath = text(options.path, "path", 500);
  if (path.extname(refPath).toLowerCase() !== ".xlsx") throw new OfficeIntelligenceError("connector output must be an .xlsx path", 422, "invalid_contract");
  await writeSheetDoc(taskPath(options.workspace, refPath), {
    taskId: options.taskId,
    path: refPath,
    name: path.basename(refPath),
    sheets: [{ name: "Data", cells: [data.columns, ...data.rows.map((row) => row.map((value) => value === null ? "" : String(value)))], styles: {}, columnWidths: [], rowHeights: [], merges: [], hiddenRows: [], hiddenColumns: [] }],
    notes: [`Source: ${connector.name}`, `Synced: ${data.syncedAt}`, ...(data.truncated ? ["Result truncated to 1000 rows"] : [])],
  });
  return (await loadOfficeArtifact(options.workspace, { taskId: options.taskId, path: refPath, kind: "spreadsheet", tenantId: connector.scope.tenantId })).ref;
}
