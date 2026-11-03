// src/appbuilder/processEnv.ts
import { scrubEnv } from "../subagent/env.js";
import { depsDirFor } from "./depsCache.js";
import type { AppProject } from "./types.js";

/** Environment for every process that runs generated code: verify steps, the Vite dev server, the app API server.
 *  scrubEnv() (src/subagent/env.ts) drops every inherited variable whose name contains KEY, TOKEN, SECRET or
 *  PASSWORD and the cloud-provider prefixes, so Loam's own credentials never reach generated code. `extra` wins. */
export function appProcessEnv(project: AppProject, extra: Record<string, string> = {}): Record<string, string> {
  return scrubEnv(process.env, {
    FORCE_COLOR: "0",
    BROWSER: "none",
    LOAM_DEPS_DIR: depsDirFor(project),
    LOAM_SITE_TITLE: project.title,
    LOAM_SITE_DESCRIPTION: project.description,
    ...extra,
  });
}
