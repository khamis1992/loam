import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export interface AppLaunchOptions {
  appDistPath: string;
  appFallbackMain: string;
  env?: Record<string, string>;
  args?: string[];
}

function findExecutable(opts: AppLaunchOptions): string {
  const candidates = [opts.appDistPath];
  if (os.platform() === "win32") {
    const dir = path.dirname(opts.appDistPath);
    candidates.push(path.join(dir, "AgentStudio.exe"));
    candidates.push(path.join(dir, "Agent Studio.exe"));
    candidates.push(path.join(dir, "loam.exe"));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return opts.appFallbackMain;
}

export async function launchApp(opts: AppLaunchOptions): Promise<ElectronApplication> {
  const executable = findExecutable(opts);
  const isMainScript = executable.endsWith(".cjs") || executable.endsWith(".js") || executable.endsWith(".ts");
  const extraArgs = opts.args ?? [];
  const args = isMainScript ? [executable, ...extraArgs] : [executable, ...extraArgs];
  const app = await _electron.launch({
    args,
    env: {
      ...process.env,
      NODE_ENV: "test",
      MOCK_PORT: process.env.MOCK_PORT ?? "8787",
      API_BASE: process.env.API_BASE ?? `http://localhost:${process.env.MOCK_PORT ?? "8787"}`,
      SOCKET_BASE: process.env.SOCKET_BASE ?? `http://localhost:${process.env.MOCK_PORT ?? "8787"}`,
      WEB_LOGIN_BASE: process.env.WEB_LOGIN_BASE ?? `http://localhost:${process.env.MOCK_PORT ?? "8787"}`,
      UPDATE_FEED_URL: "",
      LOAM_DISABLE_BRIDGE: "1",
      ...(opts.env ?? {}),
    },
  });
  return app;
}

export async function firstWindow(app: ElectronApplication): Promise<Page> {
  return app.firstWindow({ timeout: 45_000 });
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  try {
    await app.close();
  } catch {
    /* ignore */
  }
}
