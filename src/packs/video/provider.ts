export interface VideoGenerationRequest {
  prompt: string;
  durationSec?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
}

export interface VideoProvider {
  submit(request: VideoGenerationRequest): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<{ status: "queued" | "running" | "done" | "failed"; path?: string; error?: string }>;
}
