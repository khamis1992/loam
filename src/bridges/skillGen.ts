import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../config.js";
import { assertNoSecret } from "../memory/redact.js";
import { buildSkillFile } from "../tools/skills.js";
import type { BridgeManifest } from "./types.js";

/** Markdown body for a bridge's skill: what it can do and how to call it. */
export function bridgeSkillBody(m: BridgeManifest): string {
  const cmds = m.commands.map((c) => {
    const ps = Object.entries(c.params)
      .map(([n, p]) => `  - \`${n}\` (${p.type}${p.required ? ", required" : ""})${p.description ? `: ${p.description}` : ""}`)
      .join("\n");
    return `### ${c.id}\n${c.description} Side effect: \`${c.effect}\`.\n${ps}`;
  });
  return [
    `Use the \`app_run\` tool to drive ${m.name} instead of clicking through its window.`,
    "",
    "1. `app_list` shows whether the bridge is ready. If it is disabled, ask the user to enable it in Settings › App bridges.",
    `2. \`app_run\` with \`app: "${m.id}"\`, a \`command\` below, and \`args\` keyed by parameter name.`,
    "3. Output files must stay inside the workspace. Commands marked `exec_script` or `external` wait for the user's approval.",
    "",
    "## Commands",
    "",
    cmds.join("\n\n"),
  ].join("\n");
}

/** Write `SKILLS_DIR/bridge-<id>/SKILL.md` and return its path. */
export function writeBridgeSkill(m: BridgeManifest, skillsDir: string = SKILLS_DIR): string {
  const slug = `bridge-${m.id}`;
  const content = buildSkillFile(slug, `Drive ${m.name} through the app_run bridge: ${m.description}`, bridgeSkillBody(m), [m.id, m.name.toLowerCase()]);
  assertNoSecret(content);
  const dir = path.join(skillsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
  return file;
}
