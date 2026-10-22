export type SqliteCell = string | number | null;
export interface SqliteCheck { database: string; table: string; columns: string[]; rows: SqliteCell[][] }
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function validateSqliteChecks(value: unknown): asserts value is SqliteCheck[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error("SQLite checks require 1–4 declarations");
  for (const c of value) {
    if (!c || typeof c !== "object" || !/^\/tmp\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}\.(?:sqlite|db)$/.test(c.database) || typeof c.table !== "string" || !identifier.test(c.table)) throw new Error("Invalid SQLite database path or table");
    if (!Array.isArray(c.columns) || !c.columns.length || c.columns.length > 16 || c.columns.some((x: unknown) => typeof x !== "string" || !identifier.test(x)) || new Set(c.columns).size !== c.columns.length) throw new Error("Invalid SQLite columns");
    if (!Array.isArray(c.rows) || c.rows.length > 100 || c.rows.some((row: unknown) => !Array.isArray(row) || row.length !== c.columns.length || row.some((v: unknown) => !(v === null || typeof v === "string" && v.length <= 4000 || typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER)))) throw new Error("Invalid SQLite expected rows");
  }
}
export function canonicalRows(rows: SqliteCell[][]): string {
  return JSON.stringify(rows.map(r => JSON.stringify(r)).sort());
}

// Trusted fixed program, executed only inside the owned sandbox. The contract
// provides identifiers and expected data, never executable SQL or JavaScript.
export const SQLITE_PROBE = String.raw`
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
const c=JSON.parse(input), real=fs.realpathSync(c.database), stat=fs.statSync(real);
if(!real.startsWith('/tmp/')||!stat.isFile()||stat.size>33554432)throw Error('Invalid SQLite file');
const db=new DatabaseSync(real,{readOnly:true});
try {
db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(c.table))throw Error('SQLite table missing');
const columns=new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(c.table).map(r=>r.name));
if(c.columns.some(k=>!columns.has(k)))throw Error('SQLite column missing');
const quote=x=>'"'+x.replaceAll('"','""')+'"';
const rows=db.prepare('SELECT '+c.columns.map(quote).join(',')+' FROM '+quote(c.table)+' LIMIT 101').all().map(r=>c.columns.map(k=>r[k]));
if(rows.length>100)throw Error('SQLite row budget exceeded');
console.log(JSON.stringify(rows));
}finally{db.close()}
});`;
