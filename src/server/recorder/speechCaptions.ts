// Captions go through the local speech server already used by creative_subtitles.
// A missing server is reported. This path does not download a whisper model.
import fs from "node:fs";
import { buildCaptions, toSrt } from "../../creative/auto.js";
import { transcribe } from "../../creative/transcript.js";
import { probeSpeechRuntime } from "../../tools/creativeStudio.js";
import type { CaptionEngine } from "./session.js";

export function createSpeechCaptionEngine(): CaptionEngine {
  return {
    async generate(video: string): Promise<{ segments: number; path: string }> {
      const problem = await probeSpeechRuntime();
      if (problem) throw new Error(problem);
      const transcript = await transcribe(video);
      const cues = buildCaptions(transcript.segments, { maxChars: 42 });
      if (!cues.length) throw new Error("No speech was found in the recording.");
      const out = `${video}.srt`;
      fs.writeFileSync(out, toSrt(cues), "utf8");
      return { segments: cues.length, path: out };
    },
  };
}
