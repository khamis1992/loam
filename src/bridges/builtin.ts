/** Built-in manifests. Raw data on purpose: registry.ts validates every one at load. */
export const BUILTIN_MANIFESTS: unknown[] = [
  {
    id: "ffmpeg",
    name: "FFmpeg",
    description: "Convert and trim audio and video files.",
    probe: {
      names: ["ffmpeg.exe"],
      paths: ["%ProgramFiles%\\ffmpeg\\bin\\ffmpeg.exe", "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\ffmpeg.exe"],
    },
    versionArgs: ["-version"],
    commands: [
      {
        id: "convert",
        description: "Convert a media file to another format; the output extension picks the format.",
        effect: "write_workspace",
        argv: ["-y", "-hide_banner", "-i", "{input}", "{output}"],
        params: {
          input: { type: "path", access: "read", required: true, description: "Source media file." },
          output: { type: "path", access: "write", required: true, description: "Destination file inside the workspace." },
        },
        output: "text",
        timeoutSeconds: 600,
      },
      {
        id: "extract_audio",
        description: "Drop the video stream and keep the audio.",
        effect: "write_workspace",
        argv: ["-y", "-hide_banner", "-i", "{input}", "-vn", "{output}"],
        params: {
          input: { type: "path", access: "read", required: true },
          output: { type: "path", access: "write", required: true },
        },
        output: "text",
        timeoutSeconds: 600,
      },
    ],
  },
  {
    id: "libreoffice",
    name: "LibreOffice",
    description: "Convert office documents between formats without opening a window.",
    probe: {
      names: ["soffice.exe"],
      paths: ["%ProgramFiles%\\LibreOffice\\program\\soffice.exe", "%ProgramFiles(x86)%\\LibreOffice\\program\\soffice.exe"],
      appPaths: ["soffice.exe"],
    },
    commands: [
      {
        id: "convert",
        description: "Convert a document to another format and write it to a workspace folder.",
        effect: "write_workspace",
        argv: ["--headless", "--convert-to", "{format}", "--outdir", "{outdir}", "{input}"],
        params: {
          input: { type: "path", access: "read", required: true },
          outdir: { type: "path", access: "write", required: true, description: "Output folder inside the workspace." },
          format: { type: "enum", required: true, values: ["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp", "csv", "html", "txt"] },
        },
        output: "text",
        timeoutSeconds: 300,
      },
    ],
  },
  {
    id: "inkscape",
    name: "Inkscape",
    description: "Export vector drawings to raster or other vector formats.",
    probe: {
      names: ["inkscape.exe"],
      paths: ["%ProgramFiles%\\Inkscape\\bin\\inkscape.exe"],
      appPaths: ["inkscape.exe"],
    },
    versionArgs: ["--version"],
    commands: [
      {
        id: "export",
        description: "Export an SVG to png, pdf, svg or eps.",
        effect: "write_workspace",
        argv: ["{input}", "--export-type={format}", "--export-filename={output}", { when: "dpi", args: ["--export-dpi={dpi}"] }],
        params: {
          input: { type: "path", access: "read", required: true },
          output: { type: "path", access: "write", required: true },
          format: { type: "enum", required: true, values: ["png", "pdf", "svg", "eps"] },
          dpi: { type: "number", description: "Raster resolution, png only." },
        },
        output: "text",
        timeoutSeconds: 300,
      },
    ],
  },
  {
    id: "blender",
    name: "Blender",
    description: "Render scenes and run Python scripts in a background Blender.",
    probe: {
      names: ["blender.exe"],
      paths: ["%ProgramFiles%\\Blender Foundation\\Blender 4.2\\blender.exe", "%ProgramFiles%\\Blender Foundation\\Blender 4.1\\blender.exe"],
      appPaths: ["blender.exe"],
    },
    versionArgs: ["--version"],
    commands: [
      {
        id: "render",
        description: "Render one frame of a .blend file to an image prefix inside the workspace.",
        effect: "write_workspace",
        argv: ["-b", "{blend}", "-o", "{output}", "-f", "{frame}"],
        params: {
          blend: { type: "path", access: "read", required: true },
          output: { type: "path", access: "write", required: true, description: "Output path prefix." },
          frame: { type: "number", required: true },
        },
        output: "text",
        timeoutSeconds: 900,
      },
      {
        id: "run_script",
        description: "Run a Python script inside Blender. The script can do anything the user can, so it needs approval.",
        effect: "exec_script",
        argv: ["-b", "--python", "{script}"],
        params: { script: { type: "path", access: "read", required: true } },
        output: "text",
        timeoutSeconds: 600,
      },
    ],
  },
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Open a vault or a search in the Obsidian app.",
    probe: {
      names: ["Obsidian.exe"],
      paths: ["%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.exe", "%ProgramFiles%\\Obsidian\\Obsidian.exe"],
    },
    commands: [
      {
        id: "open_vault",
        description: "Open a vault by name in the Obsidian window. Changes what is on screen, so it needs approval.",
        effect: "external",
        argv: ["obsidian://open?vault={vault}"],
        params: { vault: { type: "string", required: true } },
        output: "text",
        timeoutSeconds: 30,
      },
      {
        id: "search",
        description: "Open the Obsidian search panel for a query.",
        effect: "external",
        argv: ["obsidian://search?vault={vault}&query={query}"],
        params: { vault: { type: "string", required: true }, query: { type: "string", required: true } },
        output: "text",
        timeoutSeconds: 30,
      },
    ],
  },
  {
    id: "imhex",
    name: "ImHex",
    description: "Pattern-language binary inspection in ImHex (user-installed; GPL-2.0, never bundled).",
    probe: {
      names: ["imhex.exe"],
      paths: ["%ProgramFiles%\\ImHex\\imhex.exe", "%LOCALAPPDATA%\\Programs\\ImHex\\imhex.exe"],
    },
    versionArgs: ["--version"],
    commands: [
      {
        id: "open",
        description: "Open a binary in ImHex for interactive inspection (no automation, UI only).",
        effect: "external",
        argv: ["{file}"],
        params: { file: { type: "path", access: "read", required: true, description: "Binary to open (owned/authorized only)." } },
        output: "text",
        timeoutSeconds: 30,
      },
    ],
  },
  {
    id: "x64dbg",
    name: "x64dbg",
    description: "Open a binary in x64dbg for interactive debugging (user-installed; its own licence, never bundled).",
    probe: {
      names: ["x64dbg.exe", "x32dbg.exe"],
      paths: ["%ProgramFiles%\\x64dbg\\release\\x64\\x64dbg.exe", "%LOCALAPPDATA%\\Programs\\x64dbg\\x64dbg.exe"],
    },
    commands: [
      {
        id: "debug",
        description: "Start the binary under the debugger. Dynamic analysis of owned/authorized targets only; needs approval.",
        effect: "exec_script",
        argv: ["{file}"],
        params: { file: { type: "path", access: "read", required: true, description: "Binary to debug (owned/authorized only)." } },
        output: "text",
        timeoutSeconds: 60,
      },
    ],
  },
];
