import { getApiBase, getApiHeaders, getLoamBase } from './rpc';

/**
 * Client for /api/legal (src/server/routes/legal.ts). The types mirror
 * src/legal/types.ts on the server; keep them in sync (shared via copy, like
 * knowledgeApi.ts does for the Knowledge Garden).
 */

export type Confidentiality = 'public' | 'internal' | 'confidential' | 'privileged';
export type EgressPolicy = 'local_only' | 'cloud_redacted' | 'cloud_full';
export type ReviewState = 'draft' | 'verified' | 'in_review' | 'approved' | 'rejected';
export type Verdict = 'pass' | 'pass_with_warnings' | 'fail';

export interface LegalStatus {
  enabled: boolean; today: string; keyAvailable: boolean; localModel: string; localModelApproved: boolean;
  corpus: { legislations: number; articles: number; versions: number; avgLen: number };
}

export interface LegalHit {
  avid: string; articleKey: string; legKey: string; legTitle: string; label: string; part: 'issuance' | 'body';
  text: string; truncated: boolean; effectiveFrom: string; effectiveTo: string | null;
  status: 'in_force' | 'historical' | 'not_yet_in_force'; provenance: string; citable: boolean; score: number; reasons: string[];
}
export interface CoverageIssue { legKey: string; titleAr: string; reason: 'missing' | 'unverified' | 'stale' | 'not_in_force' }
export interface CoverageReport {
  status: 'unconfigured' | 'complete' | 'incomplete'; matterKind: string; asOf: string; entries: number; issues: CoverageIssue[]; checkedAt: string;
}
export interface LegalSearchResult {
  query: string; asOf: string; hits: LegalHit[]; mode: 'lexical' | 'hybrid'; direct: boolean; noAuthority: boolean;
  authorityReason?: 'COVERAGE_UNCONFIGURED' | 'COVERAGE_INCOMPLETE' | 'NO_MATCH'; coverage: CoverageReport; corpusSnapshotId: string;
}

export interface CitationCheck {
  index: number; token: string; avid: string | null; kind: 'cite' | 'ref' | 'free_article' | 'free_law'; status: string;
  quote?: string; messageAr: string; messageEn: string; rendered?: string; span: { start: number; end: number };
}
export interface VerificationWarning { code: string; avid?: string; messageAr: string; messageEn: string }
export interface VerificationReport {
  verdict: Verdict; asOf: string; checks: CitationCheck[]; warnings: VerificationWarning[]; documentSha256: string; renderedDocument?: string;
  corpusSnapshotId: string; coverage: CoverageReport;
  counts: { cited: number; verified: number; failed: number; freeMentions: number; unverifiedMarkers: number };
}
export interface StructureIssue { level: 'error' | 'warning'; code: string; messageAr: string }

export interface MatterParty { role: 'client' | 'counterparty' | 'court' | 'prosecution' | 'witness' | 'other'; name: string; identifiers: string[] }
export interface Matter {
  id: string; title: string; kind: 'defense_memo' | 'contract_review' | 'opinion' | 'research';
  confidentiality: Confidentiality; egress: EgressPolicy; asOf: string;
  court?: { name: string; circuit?: string; caseNumber?: string; hearingDate?: string };
  parties: MatterParty[]; createdAt: string; updatedAt: string; retainUntil: string | null;
}
export interface ReviewParagraph { index: number; start: number; end: number; quote: string }
export interface ReviewComment { id: string; anchor: Omit<ReviewParagraph, 'index'>; body: string; author: { name: string; licenseNo: string }; createdAt: string }
export interface ReviewDecision { id: string; action: 'comment' | 'accept_warning' | 'approve' | 'reject'; actor: { name: string; licenseNo: string }; subject: string; reason?: string; at: string }
export interface AcceptedWarning { code: string; reason: string; reviewer: { name: string; licenseNo: string }; acceptedAt: string }
export interface ReviewRecord {
  id: string; matterId: string; documentName: string; state: ReviewState; verifiedSha256?: string; approvedSha256?: string;
  documentVersion?: { id: string; contentSha256: string; corpusSnapshotId: string; model: string; createdAt: string };
  verification?: VerificationReport;
  comments: ReviewComment[]; acceptedWarnings: AcceptedWarning[]; decisions: ReviewDecision[];
  reviewer?: { name: string; licenseNo: string }; decidedAt?: string; note?: string;
  history: Array<{ at: string; from: ReviewState; to: ReviewState; actor: string }>;
}
export interface EvidenceAnchor { documentId: string; page?: number; paragraph?: number; start: number; end: number; quote: string; sha256: string }
export interface EvidenceDocument { id: string; matterId: string; fileName: string; mime: string; sha256: string; language: string; text: string; importedAt: string; pages: Array<{ page: number; text: string; confidence?: number; warnings: string[] }>; warnings: string[] }
export interface FactAssertion { id: string; matterId: string; text: string; kind: string; status: string; anchors: EvidenceAnchor[]; createdAt: string }
export interface TimelineEvent { id: string; matterId: string; dateLabel: string; sortDate: string; description: string; anchors: EvidenceAnchor[] }
export interface Contradiction { id: string; kind: string; severity: 'info' | 'warning' | 'high'; title: string; details: string; anchors: EvidenceAnchor[] }
export interface EvidenceWorkspace { documents: EvidenceDocument[]; facts: FactAssertion[]; timeline: TimelineEvent[]; contradictions: Contradiction[] }
export interface LegalPipelineRun {
  id: string; kind: 'contract_review' | 'defense_memo' | 'legal_response' | 'document_analysis'; matterId: string;
  status: 'running' | 'waiting' | 'failed' | 'cancelled' | 'succeeded'; stage: string;
  state: unknown; completedStages: string[]; stageCount?: number; inputSha256: string; corpusSnapshotId: string; model: string; promptVersion: string;
  createdAt: string; updatedAt: string; error?: string;
}
export interface DefensePackage {
  theory: Record<string, unknown>;
  research: unknown[];
  draft: string;
  verification: VerificationReport;
  structure: StructureIssue[];
  adversarial: Array<{ severity: string; code: string; message: string }>;
  quality: { ok: boolean; issues: Array<{ code: string; message: string }> };
}
export interface LegalResponsePackage {
  matrix: {
    entries: Array<{
      id: string;
      allegation: string;
      sourceQuote: string;
      sourceStart: number;
      kind: string;
      disposition: string;
      response: string;
      evidenceFactIds: string[];
      needsClientDecision: boolean;
    }>;
  };
  research: unknown[];
  draft: string;
  verification: VerificationReport;
  structure: StructureIssue[];
  adversarial: DefensePackage['adversarial'];
  quality: DefensePackage['quality'];
}
export interface DocumentAnalysisReport {
  summary: string;
  documents: EvidenceDocument[];
  timeline: TimelineEvent[];
  contradictions: Contradiction[];
  obligations: Array<{ id: string; title: string; details: string; severity: string; evidenceFactIds: string[] }>;
  risks: DocumentAnalysisReport['obligations'];
  missingInformation: DocumentAnalysisReport['obligations'];
  questions: Array<{ question: string; material: boolean }>;
  coverage: CoverageReport;
  corpusSnapshotId: string;
}
export interface ApprovalArtifact {
  id: string;
  reviewId: string;
  matterId: string;
  documentName: string;
  kind: string;
  contentSha256: string;
  artifactSha256: string;
  corpusSnapshotId: string;
  playbookVersion?: string;
  model: string;
  dataBase64?: string;
  createdAt: string;
}

export interface ReviewFinding {
  id: string; ruleId: string; clauseId: string | null; severity: 'high' | 'medium' | 'low' | 'info'; titleAr: string; explanationAr: string;
  suggestionAr?: string; authorities: string[]; suggestedAuthorities: string[]; unresolvedAuthorityQueries: string[];
}
export type ClientPosition = 'buyer' | 'seller' | 'employer' | 'employee' | 'landlord' | 'tenant' | 'contractor' | 'client' | 'principal' | 'agent' | 'other';
export type RiskTolerance = 'conservative' | 'balanced' | 'aggressive';
export interface ContractReviewReport {
  clientPosition: ClientPosition; riskTolerance: RiskTolerance; findings: ReviewFinding[];
  bilingualFindings: Array<{ id: string; severity: 'info' | 'warning' | 'high'; title: string; details: string }>;
  negotiation: Array<{ findingId: string; priority: 'must_change' | 'negotiate' | 'acceptable' | 'escalate'; rationale: string; fallback?: string }>;
  coverage: CoverageReport; corpusSnapshotId: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await getApiHeaders()), ...(init?.headers as Record<string, string> | undefined) };
  const desktop = typeof window !== 'undefined' && ((window as unknown as { __apis?: unknown }).__apis || (window as unknown as { desktopSync?: unknown }).desktopSync);
  const base = desktop ? getLoamBase().replace(/\/$/, '') : getApiBase().replace(/\/api\/?$/, '');
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `status ${res.status}`);
  return data;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const legalApi = {
  status: () => request<LegalStatus>('/api/legal/status'),
  coverage: (matterKind = 'research', asOf?: string) => request<{ coverage: CoverageReport; snapshot: { id: string; contentSha256: string; versions: number } }>(`/api/legal/coverage?matterKind=${enc(matterKind)}${asOf ? `&asOf=${enc(asOf)}` : ''}`),
  getCoverageManifest: () => request<{ entries: Array<{ legKey: string; titleAr: string; requiredFor: string[]; maxReviewAgeDays?: number }> }>('/api/legal/coverage/manifest'),
  setCoverageManifest: (entries: Array<{ legKey: string; titleAr: string; requiredFor: string[]; maxReviewAgeDays?: number }>) =>
    request<{ entries: typeof entries }>('/api/legal/coverage/manifest', jsonInit('PUT', { entries })),
  search: (q: string, opts: { asOf?: string; lawKey?: string; k?: number; historical?: boolean; matterKind?: string } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.asOf) params.set('asOf', opts.asOf);
    if (opts.lawKey) params.set('lawKey', opts.lawKey);
    if (opts.k) params.set('k', String(opts.k));
    if (opts.historical) params.set('historical', 'true');
    if (opts.matterKind) params.set('matterKind', opts.matterKind);
    return request<LegalSearchResult>(`/api/legal/search?${params.toString()}`);
  },
  verify: (input: { text: string; asOf?: string; matterId?: string; kind?: 'defense_memo' | 'opinion' | 'contract_report'; documentName?: string }) =>
    request<{ report: VerificationReport; structure: StructureIssue[]; coverSheet?: string; review?: ReviewRecord }>('/api/legal/verify', jsonInit('POST', input)),
  listMatters: () => request<{ matters: Matter[] }>('/api/legal/matters'),
  createMatter: (input: { title: string; kind: Matter['kind']; confidentiality?: Confidentiality; asOf?: string; parties?: MatterParty[]; court?: Matter['court'] }) =>
    request<{ matter: Matter }>('/api/legal/matters', jsonInit('POST', input)),
  getMatter: (id: string) => request<{ matter: Matter; contracts: Array<{ id: string; fileName: string; sha256: string; language: string }>; reviews: ReviewRecord[] }>(`/api/legal/matters/${enc(id)}`),
  getMatterDocuments: (id: string) => request<EvidenceWorkspace>(`/api/legal/matters/${enc(id)}/documents`),
  uploadMatterDocument: (matterId: string, fileName: string, dataBase64: string) =>
    request<{ document: EvidenceDocument; facts: FactAssertion[]; timeline: TimelineEvent[]; contradictions: Contradiction[]; vaultId: string }>(`/api/legal/matters/${enc(matterId)}/documents`, jsonInit('POST', { fileName, dataBase64 })),
  analyzeDocuments: (matterId: string) => request<DocumentAnalysisReport>(`/api/legal/matters/${enc(matterId)}/analyze-documents`, jsonInit('POST', {})),
  buildDefense: (matterId: string) => request<DefensePackage>(`/api/legal/matters/${enc(matterId)}/defense`, jsonInit('POST', {})),
  buildResponse: (matterId: string, sourceText: string) => request<LegalResponsePackage>(`/api/legal/matters/${enc(matterId)}/response`, jsonInit('POST', { sourceText })),
  startRun: (matterId: string, kind: LegalPipelineRun['kind'], input: { sourceText?: string; contractId?: string; contractType?: string; clientPosition?: ClientPosition; riskTolerance?: RiskTolerance } = {}) =>
    request<{ run: LegalPipelineRun }>(`/api/legal/matters/${enc(matterId)}/runs`, jsonInit('POST', { kind, ...input })),
  getRun: (id: string) => request<{ run: LegalPipelineRun }>(`/api/legal/runs/${enc(id)}`),
  listRuns: (matterId: string) => request<{ runs: LegalPipelineRun[] }>(`/api/legal/runs?matterId=${enc(matterId)}`),
  cancelRun: (id: string) => request<{ run: LegalPipelineRun }>(`/api/legal/runs/${enc(id)}/cancel`, jsonInit('POST', {})),
  resumeRun: (id: string, answer?: unknown) => request<{ run: LegalPipelineRun }>(`/api/legal/runs/${enc(id)}/resume`, jsonInit('POST', { answer })),
  verifyArtifact: (input: { matterId: string; documentName: string; dataBase64: string }) =>
    request<{ report: VerificationReport; structure: StructureIssue[]; review: ReviewRecord; paragraphs: ReviewParagraph[] }>('/api/legal/artifacts/verify', jsonInit('POST', input)),
  approveArtifact: (id: string, dataBase64: string, reviewerName: string, licenseNo: string) =>
    request<{ review: ReviewRecord; artifact: ApprovalArtifact }>(`/api/legal/reviews/${enc(id)}/approve-artifact`, jsonInit('POST', { dataBase64, reviewerName, licenseNo })),
  addReviewComment: (id: string, input: { anchor: Omit<ReviewParagraph, 'index'>; body: string; reviewerName: string; licenseNo: string }) =>
    request<{ review: ReviewRecord }>(`/api/legal/reviews/${enc(id)}/comments`, jsonInit('POST', input)),
  acceptReviewWarning: (id: string, input: { code: string; reason: string; reviewerName: string; licenseNo: string }) =>
    request<{ review: ReviewRecord }>(`/api/legal/reviews/${enc(id)}/accept-warning`, jsonInit('POST', input)),
  reviewPackage: (id: string) => request<{ fileName: string; dataBase64: string; internal: true }>(`/api/legal/reviews/${enc(id)}/review-package`),
  exportArtifact: (id: string) => request<{ fileName: string; dataBase64: string; artifact: ApprovalArtifact }>(`/api/legal/reviews/${enc(id)}/export`),
  updateMatter: (id: string, patch: Partial<Matter>, confirmEgress = false) =>
    request<{ matter: Matter }>(`/api/legal/matters/${enc(id)}`, jsonInit('PATCH', { ...patch, ...(confirmEgress ? { confirmEgress: true } : {}) })),
  deleteMatter: (id: string) => request<{ deleted: boolean }>(`/api/legal/matters/${enc(id)}`, { method: 'DELETE' }),
  addContract: (matterId: string, fileName: string, text: string, originalBase64?: string) =>
    request<{ contract: { id: string; fileName: string; sha256: string; language: string }; clauses: number }>(`/api/legal/matters/${enc(matterId)}/contracts`, jsonInit('POST', { fileName, text, ...(originalBase64 ? { originalBase64 } : {}) })),
  getContractClauses: (matterId: string, contractId: string) => request<{ clauses: Array<{ id: string; index: number; heading: string; text: string }> }>(`/api/legal/matters/${enc(matterId)}/contracts/${enc(contractId)}/clauses`),
  reviewContract: (matterId: string, contractId: string, contractType = 'any', opts: { clientPosition?: ClientPosition; riskTolerance?: RiskTolerance } = {}) =>
    request<ContractReviewReport>(`/api/legal/matters/${enc(matterId)}/contracts/${enc(contractId)}/review`, jsonInit('POST', { contractType, ...opts })),
  redlineContract: (matterId: string, contractId: string, edits: Array<{ clauseId: string; newText: string }>) =>
    request<{ fileName: string; dataBase64: string; draft: boolean }>(`/api/legal/matters/${enc(matterId)}/contracts/${enc(contractId)}/redline`, jsonInit('POST', { edits })),
  submitReview: (id: string) => request<{ review: ReviewRecord }>(`/api/legal/reviews/${enc(id)}/submit`, jsonInit('POST', {})),
  approveReview: (id: string, text: string, reviewerName: string, licenseNo: string) =>
    request<{ review: ReviewRecord }>(`/api/legal/reviews/${enc(id)}/approve`, jsonInit('POST', { text, reviewerName, licenseNo })),
  rejectReview: (id: string, note: string) => request<{ review: ReviewRecord }>(`/api/legal/reviews/${enc(id)}/reject`, jsonInit('POST', { note })),
  audit: (matterId?: string) => request<{ events: Array<{ seq: number; at: string; actor: string; action: string; subject: string }> }>(`/api/legal/audit${matterId ? `?matterId=${enc(matterId)}` : ''}`),
  auditVerify: () => request<{ intact: boolean; firstBrokenSeq: number | null }>('/api/legal/audit/verify'),
};

/**
 * The matter that Legal-mode chats run against. Only the opaque matter id is kept
 * in localStorage (never a title, party or contract text); the server re-loads the
 * matter from the encrypted store and rejects an unknown id.
 */
export const ACTIVE_MATTER_KEY = 'loam.legal.activeMatter';

export function activeLegalMatterId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const id = window.localStorage.getItem(ACTIVE_MATTER_KEY);
    return id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function setActiveLegalMatterId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_MATTER_KEY, id);
    else window.localStorage.removeItem(ACTIVE_MATTER_KEY);
  } catch {
    /* storage unavailable: chats run without a matter (client tools then refuse) */
  }
}

/** extData fragment for the chat socket: adds the active matter id when one is set. */
export function legalExtData(): { legalMatterId?: string } {
  const id = activeLegalMatterId();
  return id ? { legalMatterId: id } : {};
}
