import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../../tools/registry.js";
import { num, str } from "../../tools/registry.js";
import { musicProvider } from "../../creative/genProviders.js";
import { readPackProject, writePackProject, presentPackProject } from "../present.js";
import type { PackProject } from "../types.js";
import { taskPath } from "../../server/taskWorkspace.js";

export interface AudioAsset {
  bytes: Buffer;
  mime: string;
  extension: "mp3" | "wav";
}

export interface AudioProvider {
  generate(request: { prompt: string; durationSec?: number; voice?: string; instrumental?: boolean }, ctx: ToolContext): Promise<AudioAsset>;
}

export interface AudioPackOptions {
  tts?: AudioProvider;
  music?: AudioProvider;
}

function openAiTtsProvider(): AudioProvider | undefined {
  const baseUrl = process.env.LOAM_TTS_URL?.trim();
  if (!baseUrl) return undefined;
  return {
    async generate(request) {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(process.env.LOAM_TTS_API_KEY ? { authorization: `Bearer ${process.env.LOAM_TTS_API_KEY}` } : {}) },
        body: JSON.stringify({ model: process.env.LOAM_TTS_MODEL || "tts-1", voice: request.voice || process.env.LOAM_TTS_VOICE || "alloy", input: request.prompt, response_format: "mp3" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`TTS provider returned HTTP ${response.status}`);
      return { bytes: Buffer.from(await response.arrayBuffer()), mime: "audio/mpeg", extension: "mp3" };
    },
  };
}

function configuredMusicProvider(): AudioProvider | undefined {
  if (!process.env.LOAM_MUSIC_URL?.trim()) return undefined;
  return {
    async generate(request, ctx) {
      const generated = await musicProvider.run({ prompt: request.prompt, ...(request.durationSec ? { durationSec: request.durationSec } : {}), instrumental: request.instrumental === true }, ctx);
      if (!generated.ok) throw new Error(generated.content);
      const data = generated.output.data as { audioUrl?: string };
      if (!data.audioUrl) throw new Error("music provider returned no downloadable audio bytes");
      const response = await fetch(data.audioUrl, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`music download returned HTTP ${response.status}`);
      return { bytes: Buffer.from(await response.arrayBuffer()), mime: "audio/mpeg", extension: "mp3" };
    },
  };
}

function project(ctx: ToolContext): PackProject {
  const value = readPackProject(ctx.workspace, "loam-audio");
  if (!value) throw new Error("audio project is missing");
  return value;
}

export function createAudioPackTools(options: AudioPackOptions = {}): Tool[] {
  const tts = options.tts ?? openAiTtsProvider();
  const music = options.music ?? configuredMusicProvider();
  const generate = async (kind: "tts" | "music", args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const provider = kind === "tts" ? tts : music;
    if (!provider) return { ok: false, content: JSON.stringify({ error: "provider_not_configured", capability: kind }) };
    try {
      const prompt = str(args, "prompt").trim();
      if (!prompt || prompt.length > 10_000) throw new Error("audio prompt must contain 1..10000 characters");
      const requestedDuration = num(args, "durationSec", kind === "tts" ? 0 : 30);
      const durationSec = requestedDuration > 0 ? Math.max(1, Math.min(120, requestedDuration)) : undefined;
      const asset = await provider.generate({ prompt, ...(durationSec ? { durationSec } : {}), ...(str(args, "voice") ? { voice: str(args, "voice") } : {}), instrumental: args.instrumental === true }, ctx);
      if (asset.bytes.length < 100) throw new Error("audio provider returned an empty file");
      const relative = `uploads/${kind}-${Date.now()}.${asset.extension}`;
      const absolute = taskPath(ctx.workspace, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, asset.bytes);
      const value: PackProject = { projectId: ctx.taskId ?? "local-audio", packId: "loam-audio", revision: 0, items: [{ id: `${kind}-1`, state: "final", path: relative }], data: { kind, mime: asset.mime, durationSec } };
      writePackProject(ctx.workspace, value);
      return { ok: true, content: JSON.stringify({ path: relative, mime: asset.mime, bytes: asset.bytes.length }) };
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  };

  return [
    {
      name: "tts_generate",
      description: "Generate real spoken audio through LOAM_TTS_URL or an injected provider. No Piper or Arabic voice is claimed when unconfigured.",
      parameters: { type: "object", additionalProperties: false, properties: { prompt: { type: "string" }, voice: { type: "string" }, durationSec: { type: "number", minimum: 1, maximum: 120 } }, required: ["prompt"] },
      run: async (args, ctx) => generate("tts", args, ctx),
    },
    {
      name: "music_generate",
      description: "Generate and download a real music file through LOAM_MUSIC_URL or an injected provider; never substitutes unrelated audio.",
      parameters: { type: "object", additionalProperties: false, properties: { prompt: { type: "string" }, durationSec: { type: "number", minimum: 1, maximum: 120 }, instrumental: { type: "boolean" } }, required: ["prompt"] },
      run: async (args, ctx) => generate("music", args, ctx),
    },
    {
      name: "audio_present",
      description: "Host-only gate that publishes a real generated audio file.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async run(_args, ctx) {
        const value = project(ctx);
        const artifacts = value.items.flatMap((item) => item.state === "final" && item.path ? [{ path: item.path, kind: "file" as const, title: item.id, mime: String(value.data?.mime ?? "audio/mpeg") }] : []);
        const presented = presentPackProject({ workspace: ctx.workspace, packId: "loam-audio", kind: "audio", artifacts, emit: ctx.emit });
        if (!presented.ok) return { ok: false, content: JSON.stringify(presented) };
        return { ok: true, content: JSON.stringify(presented) };
      },
    },
  ];
}
