/** §8.0 fixture set — created as real git repos in a temp dir by the harness;
 *  this module defines contents + expected inventory so tests are declarative.
 *  Never shipped (test-only). */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface Fixture {
  name: string;
  files: Record<string, string>;
  /** Expected (file, signal-substring, currentVersion, pinStyle, status, proposedTarget). */
  expect: Array<{ file: string; signalIncludes: string; current: string | null; pin: string; status: string; target: string | null }>;
}

export const FIXTURES: Fixture[] = [
  {
    name: "node-vuln-app",
    files: {
      "Dockerfile": "FROM node:22.21.0-alpine\nWORKDIR /app\nCOPY . .\nCMD [\"npm\", \"test\"]\n",
      ".nvmrc": "22.21.0\n",
      ".github/workflows/ci.yml": "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm ci\n      - run: npm test\n",
      "package.json": "{\"name\":\"node-vuln-app\",\"version\":\"1.0.0\",\"scripts\":{\"test\":\"node test.js\"}}\n",
      "test.js": "console.log('ok');\n",
    },
    expect: [
      { file: "Dockerfile", signalIncludes: "node:22.21.0-alpine", current: "22.21.0", pin: "exact", status: "vulnerable", target: "22.23.4" },
      { file: ".nvmrc", signalIncludes: "22.21.0", current: "22.21.0", pin: "exact", status: "vulnerable", target: "22.23.4" },
      { file: ".github/workflows/ci.yml", signalIncludes: "node-version: 22", current: "22", pin: "floating", status: "vulnerable", target: "22.23.4" },
    ],
  },
  {
    name: "node-eol-app",
    files: {
      ".nvmrc": "20.19.0\n",
      "package.json": "{\"name\":\"node-eol-app\",\"version\":\"1.0.0\"}\n",
    },
    expect: [
      { file: ".nvmrc", signalIncludes: "20.19.0", current: "20.19.0", pin: "exact", status: "eol", target: null },
    ],
  },
  {
    name: "node-regression-app",
    files: {
      "Dockerfile": "FROM node:22.21.0-alpine\nWORKDIR /app\nCOPY . .\nCMD [\"npm\", \"test\"]\n",
      ".nvmrc": "22.21.0\n",
      "package.json": "{\"name\":\"node-regression-app\",\"version\":\"1.0.0\",\"scripts\":{\"test\":\"node test.js\"}}\n",
      "test.js": "const v = process.versions.node.split('.').map(Number);\nif (v[0] === 22 && v[2] >= 23) { console.error('planted regression'); process.exit(1); }\nconsole.log('ok');\n",
    },
    expect: [
      { file: "Dockerfile", signalIncludes: "node:22.21.0-alpine", current: "22.21.0", pin: "exact", status: "vulnerable", target: "22.23.4" },
      { file: ".nvmrc", signalIncludes: "22.21.0", current: "22.21.0", pin: "exact", status: "vulnerable", target: "22.23.4" },
    ],
  },
  {
    name: "php-vuln-app",
    files: {
      "Dockerfile": "FROM php:8.3.12-fpm-bookworm\nWORKDIR /var/www\nCOPY . .\n",
      "composer.json": "{\"name\":\"acme/php-vuln-app\",\"require\":{\"php\":\">=8.3\"},\"scripts\":{\"test\":\"echo php-test-ok\"}}\n",
    },
    expect: [
      { file: "Dockerfile", signalIncludes: "php:8.3.12-fpm-bookworm", current: "8.3.12", pin: "exact", status: "vulnerable", target: "8.3.36" },
    ],
  },
  {
    name: "gitlab-omnibus-iac",
    files: {
      "ansible/gitlab.yml": "---\n- hosts: gitlab\n  tasks:\n    - name: pin gitlab-ee\n      apt:\n        name: gitlab-ee=19.4.0-ee.0\n        state: present\n",
    },
    expect: [
      { file: "ansible/gitlab.yml", signalIncludes: "gitlab-ee=19.4.0-ee.0", current: "19.4.0-ee.0", pin: "package", status: "vulnerable", target: "19.4.3" },
    ],
  },
  {
    name: "electron-app",
    files: {
      "package.json": "{\n  \"name\": \"electron-app\",\n  \"devDependencies\": { \"electron\": \"44.7.2\" }\n}\n",
      "package-lock.json": "{\"lockfileVersion\":3,\"packages\":{\"\":{\"name\":\"electron-app\",\"devDependencies\":{\"electron\":\"44.7.2\"}},\"node_modules/electron\":{\"version\":\"44.7.2\"}}}\n",
    },
    expect: [
      { file: "package.json", signalIncludes: "electron", current: "44.7.2", pin: "bundled", status: "vendor_update_required", target: null },
    ],
  },
  {
    name: "clean-node-app",
    files: {
      "Dockerfile": "FROM node:22.23.4-alpine\nWORKDIR /app\nCOPY . .\n",
    },
    expect: [
      { file: "Dockerfile", signalIncludes: "node:22.23.4-alpine", current: "22.23.4", pin: "exact", status: "fixed", target: null },
    ],
  },
];

/** Materialize a fixture as a real git repo (one commit on main) and return its path. */
export function materialize(fixture: Fixture, parentDir: string): string {
  const dir = path.join(parentDir, fixture.name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(fixture.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, "utf8");
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@test", "commit", "-qm", "fixture"], { cwd: dir });
  return dir;
}

/** Read every fixture file for the inventory input (repo-relative). */
export function readFixtureFiles(dir: string): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else out.push({ rel, content: fs.readFileSync(p, "utf8") });
    }
  };
  walk(dir, "");
  return out;
}
