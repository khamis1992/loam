export const BUILD_KINDS = [
  'website',
  'desktop',
  'widget',
  'automation',
  'notebook',
  'mobile',
  'chrome-extension',
  'safari-extension',
  'game',
] as const;

export type BuildKind = (typeof BUILD_KINDS)[number];
export type WebsiteSubtype = 'landing' | 'store' | 'booking' | 'chatbot';
export type BuildSelection =
  | { kind: 'website'; subtype: WebsiteSubtype }
  | { kind: Exclude<BuildKind, 'website'> };
export type Requirement = 'node' | 'electron' | 'python-container'
  | 'android-sdk' | 'macos-xcode' | 'chromium';
export type ExportKind = 'source-zip' | 'web-zip' | 'portable-exe'
  | 'ipynb' | 'apk-debug' | 'mv3-zip' | 'xcode-source';
export type PreviewKind = 'web' | 'window' | 'widget' | 'dry-run'
  | 'notebook' | 'device-frame' | 'extension' | 'game';
export interface BuildProfile {
  kind: BuildKind;
  preview: PreviewKind;
  requirements: readonly Requirement[];
  exports: readonly ExportKind[];
  network: 'none' | 'loopback';
  externalEffects: 'approval-required';
}
export interface BuildManifest {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  selection: BuildSelection;
  title: string;
  sourceDir: 'app';
  template: { id: string; revision: string; lockSha256: string };
  consent: { autostart: false | { approvedAt: string }; publish: false };
}
export type JobPhase = 'queued' | 'starting' | 'running' | 'stopping'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type JobSnapshot =
  | { phase: Exclude<JobPhase, 'failed'>; jobId: string; revision: number }
  | { phase: 'failed'; jobId: string; revision: number; code: string; message: string };
export type PreviewLease =
  | { kind: 'none' }
  | { kind: 'http'; leaseId: string; url: string; jobId: string; messageNonce: string }
  | { kind: 'native'; leaseId: string; jobId: string };
export interface Artifact {
  artifactId: string;
  projectId: string;
  revision: number;
  format: ExportKind;
  relativePath: string;
  sha256: string;
  bytes: number;
}
export interface BuildFailure {
  error: 'invalid_request' | 'approval_required' | 'stale_revision'
    | 'missing_requirement' | 'busy' | 'cancelled' | 'unsafe_path'
    | 'tool_failed' | 'unsupported_platform' | 'port_exhausted';
  message: string;
}
export type BuildAction = 'generate' | 'preview' | 'package' | 'kernel-execute';
export type BuildOperation =
  | { action: 'generate' | 'preview' }
  | { action: 'package'; format: ExportKind }
  | { action: 'kernel-execute'; cellId: string };
export interface StartBuildRequest {
  projectId: string;
  expectedRevision: number;
  operation: BuildOperation;
  planSha256: string;
  grantId: string;
  idempotencyKey: string;
}
export interface BuildJobContext {
  manifest: BuildManifest;
  workspace: string;
  jobId: string;
  operation: BuildOperation;
  signal: AbortSignal;
}
export interface DriverPorts {
  missing(ctx: BuildJobContext, required: readonly Requirement[]): Promise<readonly Requirement[]>;
  scaffold(ctx: BuildJobContext): Promise<void>;
  preview(ctx: BuildJobContext): Promise<PreviewLease>;
  export(ctx: BuildJobContext, format: ExportKind): Promise<Artifact>;
  executeCell(ctx: BuildJobContext, cellId: string): Promise<void>;
  stop(ctx: BuildJobContext): Promise<void>;
}
export interface BuildDriver {
  profile: BuildProfile;
  preflight(ctx: BuildJobContext): Promise<readonly Requirement[]>;
  scaffold(ctx: BuildJobContext): Promise<void>;
  preview(ctx: BuildJobContext): Promise<PreviewLease>;
  export(ctx: BuildJobContext, format: ExportKind): Promise<Artifact>;
  executeCell(ctx: BuildJobContext, cellId: string): Promise<void>;
  stop(ctx: BuildJobContext): Promise<void>;
}

export function routineSendRequested(prompt: string): boolean {
  if (/لا ترسل|do not send/i.test(prompt)) return false;
  return /أرسل|ارسل|\bsend\b|email|mailto/i.test(prompt);
}

export function isBuildKind(value: unknown): value is BuildKind {
  return typeof value === 'string' && (BUILD_KINDS as readonly string[]).includes(value);
}
