/** Builtin bridge manifest for wakaru (Cap F). Merge into bridges/builtin.ts. */
export const WAKARU_MANIFEST = {
  id: "wakaru",
  name: "wakaru",
  description: "JavaScript decompiler and bundle unpacker (pinned binary)",
  probe: { names: ["wakaru"], paths: ["%LOAM_DATA%\\bin\\wakaru\\1.14.0\\wakaru.exe"] },
  versionArgs: ["--version"],
  commands: [
    {
      id: "decompile",
      description: "Decompile a JS file to modern syntax",
      effect: "write_workspace" as const,
      argv: ["--output", { when: "out", args: ["$out"] }, "$input"],
      params: {
        input: { type: "path" as const, access: "read" as const, required: true },
        out: { type: "path" as const, access: "write" as const, required: true },
      },
      output: "json" as const,
      timeoutSeconds: 120,
    },
    {
      id: "unpack",
      description: "Unpack a bundler output into modules",
      effect: "write_workspace" as const,
      argv: ["--unpack=auto", "-o", "$out", "$input"],
      params: {
        input: { type: "path" as const, access: "read" as const, required: true },
        out: { type: "path" as const, access: "write" as const, required: true },
      },
      output: "json" as const,
      timeoutSeconds: 600,
    },
  ],
};
