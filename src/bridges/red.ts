/**
 * Red-team bridge manifests (RED_TEAM_BUILD_SPEC §4.4, §6.3, §6.5, §6.6, §6.8,
 * §6.9, §6.11). Raw data on purpose: registry.ts validates every one at load.
 *
 * Red bridges ship DISABLED BY DEFAULT — bridges only run when the user enables
 * them in config (`cfg.bridges.enabled[id]`). Heavy engines are discovered on
 * the machine (where/named paths), not bundled (spec O-3). The orchestrator
 * consults the §0.4 authorization gate on the target BEFORE any bridge executes;
 * the bridge boundary is defense-in-depth, not the authorization itself.
 *
 * Licence discipline (§5.9): engines run as external processes. No upstream
 * code is copied into Loam.
 */
export const RED_MANIFESTS: unknown[] = [
  {
    id: "red-ffuf",
    name: "ffuf (web fuzzer)",
    description: "Path/param/content fuzzing against an in-scope target (RED_TEAM_BUILD_SPEC 6.5).",
    probe: { names: ["ffuf.exe", "ffuf"] },
    versionArgs: ["-V"],
    commands: [
      {
        id: "fuzz",
        description: "Fuzz a FUZZ-marked URL with a wordlist; writes JSON results into the workspace.",
        effect: "external",
        argv: [
          "-u", "{url}",
          "-w", "{wordlist}",
          "-t", "{threads}",
          "-mc", "200,301,302,401,403",
          "-of", "json", "-o", "{out}",
          { when: "rate", args: ["-rate", "{rate}"] },
        ],
        params: {
          url: { type: "string", required: true, description: "Target URL with a FUZZ keyword marking the injection point." },
          wordlist: { type: "path", access: "read", required: true, description: "Wordlist file." },
          threads: { type: "number", description: "Parallel workers (default 10)." },
          rate: { type: "number", description: "Requests per second cap (recommended 10)." },
          out: { type: "path", access: "write", required: true, description: "JSON results file inside the workspace." },
        },
        output: "text",
        timeoutSeconds: 600,
      },
    ],
  },
  {
    id: "red-nuclei",
    name: "nuclei (template scanner)",
    description: "Fast template-based vulnerability checks against an in-scope target (RED_TEAM_BUILD_SPEC 6.6).",
    probe: { names: ["nuclei.exe", "nuclei"] },
    versionArgs: ["-version"],
    commands: [
      {
        id: "scan",
        description: "Run nuclei templates against one in-scope URL, emitting JSONL findings.",
        effect: "external",
        argv: [
          "-u", "{target}",
          "-severity", "{severity}",
          "-jsonl", "-silent", "-nc",
          { when: "rate", args: ["-rl", "{rate}"] },
        ],
        params: {
          target: { type: "string", required: true, description: "In-scope target URL." },
          severity: { type: "enum", required: true, values: ["info", "low", "medium", "high", "critical"], description: "Minimum severity to report." },
          rate: { type: "number", description: "Requests per second cap (recommended 10)." },
        },
        output: "text",
        timeoutSeconds: 600,
      },
    ],
  },
  {
    id: "red-sqlmap",
    name: "sqlmap (SQL injection)",
    description: "Automated SQL injection testing against an in-scope target (RED_TEAM_BUILD_SPEC 6.3). GPL-2.0: external process only, no code copied.",
    probe: { names: ["sqlmap.py", "sqlmap.exe", "sqlmap"] },
    versionArgs: ["--version"],
    commands: [
      {
        id: "test",
        description: "Non-destructive SQLi detection: enumerate injectable parameters and fingerprint the DBMS. Never dumps data or opens a shell.",
        effect: "external",
        argv: [
          "-u", "{url}",
          "--batch", "--level", "{level}", "--risk", "{risk}",
          "--technique", "BEUSTQ",
          "--output-dir", "{workdir}",
          { when: "data", args: ["--data", "{data}"] },
        ],
        params: {
          url: { type: "string", required: true, description: "Target URL with the parameter under test." },
          level: { type: "number", description: "Test level 1-5 (default 1)." },
          risk: { type: "number", description: "Test risk 1-3 (default 1)." },
          workdir: { type: "path", access: "write", required: true, description: "sqlmap output directory inside the workspace." },
          data: { type: "string", description: "POST data string, when testing a form." },
        },
        output: "text",
        timeoutSeconds: 900,
      },
      {
        id: "dump",
        description: "DESTRUCTIVE: dump table rows from a confirmed injection. Requires the gate's destructive approval before invocation.",
        effect: "external",
        argv: [
          "-u", "{url}",
          "--batch", "--technique", "BEUSTQ",
          "--dump",
          "--output-dir", "{workdir}",
          { when: "data", args: ["--data", "{data}"] },
        ],
        params: {
          url: { type: "string", required: true },
          workdir: { type: "path", access: "write", required: true },
          data: { type: "string" },
        },
        output: "text",
        timeoutSeconds: 900,
      },
    ],
  },
  {
    id: "red-zap",
    name: "OWASP ZAP (DAST)",
    description: "Active DAST scan via ZAP's quick-scan mode against an in-scope target (RED_TEAM_BUILD_SPEC 6.3).",
    probe: { names: ["zap.bat", "zap.sh", "zap.exe"] },
    commands: [
      {
        id: "quickscan",
        description: "ZAP baseline+active quick scan of one URL; writes the report file into the workspace.",
        effect: "external",
        argv: ["-cmdline", "-quickurl", "{target}", "-quickout", "{out}", "-quickprogress"],
        params: {
          target: { type: "string", required: true, description: "In-scope target URL." },
          out: { type: "path", access: "write", required: true, description: "Report output file inside the workspace." },
        },
        output: "text",
        timeoutSeconds: 900,
      },
    ],
  },
  {
    id: "red-ysoserial",
    name: "ysoserial (Java deserialization)",
    description: "Generates Java deserialization payloads locally (RED_TEAM_BUILD_SPEC 6.8). MIT; runs as an external jar.",
    probe: { names: ["java.exe", "java"] },
    commands: [
      {
        id: "gen",
        description: "Generate one serialized gadget-chain payload on stdout. URLDNS is the benign DNS-only proof gadget; command gadgets are for approved destructive runs.",
        effect: "exec_script",
        argv: ["-jar", "{jar}", "{gadget}", "{cmd}"],
        params: {
          jar: { type: "path", access: "read", required: true, description: "Path to ysoserial.jar." },
          gadget: { type: "enum", required: true, values: ["URLDNS", "CommonsCollections1", "CommonsCollections6", "Spring1"], description: "Gadget chain." },
          cmd: { type: "string", required: true, description: "Gadget argument (a URL for URLDNS, a command otherwise)." },
        },
        output: "text",
        timeoutSeconds: 60,
      },
    ],
  },
  {
    id: "red-caldera",
    name: "Caldera (adversary simulation)",
    description: "MITRE ATT&CK adversary emulation server for the isolated lab (RED_TEAM_BUILD_SPEC 6.9). Apache-2.0.",
    probe: { names: ["caldera.bat", "caldera.exe", "caldera"] },
    commands: [
      {
        id: "start",
        description: "Start the local Caldera server (lab only; long-running).",
        effect: "external",
        argv: ["--lateral", "--fresh"],
        params: {},
        output: "text",
        timeoutSeconds: 900,
      },
    ],
  },
  {
    id: "red-freeway",
    name: "Freeway (WiFi audit)",
    description: "802.11 auditing on owned lab equipment only (RED_TEAM_BUILD_SPEC 6.11). Requires a monitor-mode adapter.",
    probe: { names: ["freeway.py", "freeway.exe", "freeway"] },
    commands: [
      {
        id: "scan",
        description: "Scan owned lab APs and clients on an interface.",
        effect: "external",
        argv: ["--scan", "{interface}"],
        params: { interface: { type: "string", required: true, description: "Monitor-mode interface name." } },
        output: "text",
        timeoutSeconds: 300,
      },
      {
        id: "capture",
        description: "DESTRUCTIVE-adjacent: capture a handshake from an allow-listed owned BSSID (disrupts the lab AP's clients).",
        effect: "external",
        argv: ["--capture", "{bssid}", "--interface", "{interface}"],
        params: {
          bssid: { type: "string", required: true, description: "Owned, allow-listed BSSID." },
          interface: { type: "string", required: true },
        },
        output: "text",
        timeoutSeconds: 600,
      },
    ],
  },
];
