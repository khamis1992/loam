import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, type Config } from "../config.js";
import { setLocalAuthUserDataDir } from "../security/localAuth.js";
import { loadAgents } from "../server/agents.js";
import { loadCompanionDevices } from "../server/companionDevices.js";
import { loadDb, recoverInterruptedTasks } from "../server/db.js";
import { admitAllPending } from "../server/inputQueue.js";
import { loadPending } from "../server/pending.js";
import { loadSettings } from "../server/settings.js";
import { acquireRuntimeLease, backupDatabase } from "../server/sqliteStore.js";

export function initializeStartup(cfg: Config): { recovered: number; admittedInputs: number } {
  setLocalAuthUserDataDir(process.env.LOAM_LOCAL_TOKEN_DIR || DATA_DIR);
  loadDb();
  acquireRuntimeLease();
  backupDatabase();
  const recovered = recoverInterruptedTasks();
  const admittedInputs = admitAllPending();
  const settings = loadSettings();
  const envRoot = process.env.LOAM_ROOT || process.env.MANUS_LOCAL_ROOT;
  if (!envRoot && settings.workspace && fs.existsSync(settings.workspace) && fs.statSync(settings.workspace).isDirectory()) {
    cfg.workspace = path.resolve(settings.workspace);
  } else {
    cfg.workspace = path.resolve(cfg.workspace);
  }
  fs.mkdirSync(cfg.workspace, { recursive: true });
  loadPending();
  loadAgents();
  loadCompanionDevices();
  return { recovered, admittedInputs: admittedInputs.length };
}
