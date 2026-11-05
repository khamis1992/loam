// Answers the editor's native-bridge calls inside the Workspace iframe.
// Only the actions that open the sample project are served. Everything else
// comes back as an unsupported action, which the editor already handles.

const SAMPLE_ID = "sample-desktop";
const CREATED = "2026-11-02T00:00:00.000Z";
const SAMPLE_CAPTION = "مرحبا بكم في قطر";
const SAMPLE_VIDEO = "loamrecorder://app/desktop.mp4";

interface BridgeRequest {
  requestId?: string;
  domain?: string;
  action?: string;
  payload?: Record<string, unknown>;
}

interface StoredDocument {
  schemaVersion: 9;
  project: { id: string; title: string; createdAt: string; updatedAt: string };
  assets: unknown[];
  transcript: null;
  transcripts: unknown[];
  timeline: {
    clips: unknown[];
    gaps: unknown[];
    trimRanges: unknown[];
    muteRanges: unknown[];
    speedRanges: unknown[];
    captionRanges: unknown[];
  };
  annotations: unknown[];
  zoomRanges: unknown[];
  audioTracks: unknown[];
  legacyEditor: null;
}

const documents = new Map<string, StoredDocument>();

function blankDocument(id: string, title: string): StoredDocument {
  return {
    schemaVersion: 9,
    project: {
      id,
      title,
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    assets: [],
    transcript: null,
    transcripts: [],
    timeline: {
      clips: [],
      gaps: [],
      trimRanges: [],
      muteRanges: [],
      speedRanges: [],
      captionRanges: [],
    },
    annotations: [],
    zoomRanges: [],
    audioTracks: [],
    legacyEditor: null,
  };
}

function sampleDocument(): StoredDocument {
  const doc = blankDocument(SAMPLE_ID, "تسجيل الشاشة");
  doc.assets = [{
    id: "sample-video",
    kind: "video",
    label: "تسجيل الشاشة",
    originalPath: SAMPLE_VIDEO,
    durationSec: 1,
    cameraTrack: null,
  }];
  doc.timeline.clips = [{
    id: "clip-1",
    assetId: "sample-video",
    sourceStartSec: 0,
    sourceEndSec: 1,
    timelineStartSec: 0,
    timelineEndSec: 1,
    wordRefs: [],
    origin: "system",
    reason: "",
  }];
  doc.annotations = [{
    id: "caption-1",
    startMs: 0,
    endMs: 30000,
    type: "text",
    content: SAMPLE_CAPTION,
    textContent: SAMPLE_CAPTION,
    position: { x: 4, y: 86 },
    size: { width: 92, height: 12 },
    style: {
      color: "#ffffff",
      backgroundColor: "transparent",
      fontSize: 32,
      fontFamily: "Inter",
      fontWeight: "bold",
      fontStyle: "normal",
      textDecoration: "none",
      textAlign: "center",
    },
    zIndex: 1,
  }];
  return doc;
}

function ensureSample(): StoredDocument {
  const existing = documents.get(SAMPLE_ID);
  if (existing) return existing;
  const created = sampleDocument();
  documents.set(SAMPLE_ID, created);
  return created;
}

function ok(requestId: string | undefined, data: unknown) {
  return {
    ok: true,
    data,
    meta: { version: 1, requestId: requestId || "native", timestampMs: 0 },
  };
}

function unsupported(requestId: string | undefined, action: string) {
  return {
    ok: false,
    error: { code: "UNSUPPORTED_ACTION", message: `Unsupported recorder action: ${action}`, retryable: false },
    meta: { version: 1, requestId: requestId || "native", timestampMs: 0 },
  };
}

export function answerNativeBridge(request: unknown) {
  const body = request && typeof request === "object" ? request as BridgeRequest : {};
  const domain = body.domain ?? "";
  const action = body.action ?? "";
  const payload = body.payload ?? {};
  if (domain === "system" && action === "getPlatform") return ok(body.requestId, "win32");
  if (domain === "system" && action === "getAssetBasePath") return ok(body.requestId, null);
  if (domain === "system" && action === "getCapabilities") {
    return ok(body.requestId, {
      bridgeVersion: 1,
      platform: "win32",
      cursor: { telemetry: false, systemAssets: false, provider: "none" },
      project: { currentContext: false },
    });
  }
  if (domain === "project" && action === "getCurrentContext") {
    return ok(body.requestId, { currentProjectPath: null, currentVideoPath: null });
  }
  if (domain === "aiEdition" && action === "document.listProjects") {
    const doc = ensureSample();
    return ok(body.requestId, [{
      id: doc.project.id,
      title: doc.project.title,
      updatedAt: doc.project.updatedAt,
      assetCount: doc.assets.length,
    }]);
  }
  if (domain === "aiEdition" && action === "document.get") {
    const id = typeof payload.projectId === "string" ? payload.projectId : "";
    const doc = documents.get(id) ?? (id === SAMPLE_ID ? ensureSample() : undefined);
    return ok(body.requestId, doc
      ? { success: true, document: doc }
      : { success: false, error: "Project not found" });
  }
  if (domain === "aiEdition" && action === "document.create") {
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Untitled Project";
    const id = `proj_${documents.size + 1}`;
    const doc = blankDocument(id, title);
    documents.set(id, doc);
    return ok(body.requestId, { success: true, document: doc });
  }
  if (domain === "aiEdition" && action === "document.save") {
    const doc = payload.document as StoredDocument | undefined;
    const id = doc?.project?.id;
    if (!doc || !id) return ok(body.requestId, { success: false, error: "Document has no project id" });
    documents.set(id, doc);
    return ok(body.requestId, { success: true, document: doc });
  }
  return unsupported(body.requestId, `${domain}.${action}`);
}
