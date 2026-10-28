/**
 * Loam Legal (Qatar): the domain model.
 *
 * Every type here is storage-shaped and JSON-friendly. Identity rules:
 *  - A legislation is keyed by the Al Meezan path triple `type/year/number`
 *    (OBSERVED portal URL scheme `/legislations/{type}/{year}/{number}/{issuer}`),
 *    e.g. `law/2004/22`. The constitution uses number 0 (`constitution/2004/0`).
 *  - An article is keyed by `legKey:part:label`. `part` separates the articles
 *    of an issuing law (`issuance`) from the articles of the law it promulgates
 *    (`body`); Qatari amending laws address both (Law 9/2026 replaced Article 2
 *    of the issuing Law 14/2004 and several articles of the annexed Labour Law).
 *  - An article version is one text of one article over one effective interval.
 *    Its id (`avid`) is a short stable hash so a model can copy it reliably.
 */
import type { CoverageReport } from "./corpus/coverage.js";

export type LegislationType =
  | "constitution"
  | "law"
  | "decree-law"
  | "decree"
  | "emiri-decision"
  | "emiri-order"
  | "cabinet-decision"
  | "prime-minister-decision"
  | "ministerial-decision"
  | "decision"
  | "public-prosecutor-decision"
  | "other";

export const LEGISLATION_TYPES: readonly LegislationType[] = [
  "constitution", "law", "decree-law", "decree", "emiri-decision", "emiri-order",
  "cabinet-decision", "prime-minister-decision", "ministerial-decision", "decision",
  "public-prosecutor-decision", "other",
];

export type LegislationStatus = "in_force" | "amended" | "partially_repealed" | "repealed" | "not_yet_in_force";

/** How the text entered the corpus. Only the first three are citable as VERIFIED. */
export type SourceProvenance =
  | "official_gazette"      // transcribed/OCR'd from the Official Gazette issue, human-verified
  | "almeezan_manual"       // copied by a person from almeezan.qa, human-verified
  | "moj_data_agreement"    // delivered by the Ministry of Justice under written permission
  | "research_snapshot";    // third-party snapshot (e.g. a Hugging Face dataset): never citable as verified

export const CITABLE_PROVENANCE: ReadonlySet<SourceProvenance> = new Set<SourceProvenance>([
  "official_gazette", "almeezan_manual", "moj_data_agreement",
]);

export type ArticlePart = "issuance" | "body";

export interface SourceRef {
  provenance: SourceProvenance;
  /** Canonical URL (Al Meezan page or Official Gazette issue page). */
  url?: string;
  /** Official Gazette issue number and date when known. */
  gazetteIssue?: string;
  gazetteDate?: string;
  /** sha256 of the source file the text was taken from (PDF/HTML), when kept. */
  sourceSha256?: string;
  retrievedAt: string;
  /** Person who checked the text against the official source. */
  verifiedBy?: string;
  verifiedAt?: string;
}

export interface Legislation {
  key: string;                 // "law/2004/22"
  type: LegislationType;
  year: number;
  number: number;
  titleAr: string;
  titleEn?: string;
  /** Short names lawyers use ("القانون المدني"), searchable and resolvable. */
  aliases: string[];
  issueDate?: string;          // ISO date
  publishDate?: string;        // ISO date
  effectiveDate?: string;      // ISO date (default: publishDate)
  status: LegislationStatus;
  repealedBy?: string;         // legislation key
  repealedAt?: string;         // ISO date
  source: SourceRef;
}

export interface Article {
  key: string;                 // "law/2004/22:body:171"
  legKey: string;
  part: ArticlePart;
  /** Canonical label: digits plus optional "bis" suffix ("115", "115bis", "115bis4"). */
  label: string;
  /** Number used for ordering (115 for "115bis4"). */
  ordinal: number;
  heading?: string;
  repealedAt?: string;
  repealedBy?: string;
}

export type VersionOrigin = "original" | "amendment";

export interface ArticleVersion {
  avid: string;                // "QL-" + 10 hex chars
  articleKey: string;
  text: string;                // official text as published (no normalization)
  textSha256: string;
  effectiveFrom: string;       // ISO date, inclusive
  effectiveTo: string | null;  // ISO date, exclusive; null = open
  origin: VersionOrigin;
  introducedBy?: string;       // amending legislation key
  source: SourceRef;
}

export type AmendmentKind = "replace" | "insert" | "repeal";

export interface Amendment {
  id: string;
  amendingLegKey: string;      // "law/2026/9"
  amendingArticle: string;     // label inside the amending law ("2")
  targetArticleKey: string;    // "law/2004/14:body:3"
  kind: AmendmentKind;
  effectiveDate: string;       // ISO date
  newText?: string;            // for replace/insert
  heading?: string;
  source: SourceRef;
}

/** One version resolved for a date, with everything the verifier needs. */
export interface ResolvedArticle {
  legislation: Legislation;
  article: Article;
  version: ArticleVersion;
  /** Versions of the same article that start after `version` (later amendments). */
  laterVersions: ArticleVersion[];
  inForceAt: boolean;
  asOf: string;
}

// ---------------------------------------------------------------------------
// Matters, contracts, clauses (confidential; stored encrypted)
// ---------------------------------------------------------------------------

export type Confidentiality = "public" | "internal" | "confidential" | "privileged";

/** Cloud model egress for a matter. Default "local_only"; only the UI can change it. */
export type EgressPolicy = "local_only" | "cloud_redacted" | "cloud_full";

export interface MatterParty {
  role: "client" | "counterparty" | "court" | "prosecution" | "witness" | "other";
  name: string;
  /** Extra strings to redact (QID, CR number, aliases). */
  identifiers: string[];
}

export interface Matter {
  id: string;
  title: string;
  kind: "defense_memo" | "contract_review" | "opinion" | "research";
  confidentiality: Confidentiality;
  egress: EgressPolicy;
  /** Date the law is applied at ("as of"); default today in Asia/Qatar. */
  asOf: string;
  court?: { name: string; circuit?: string; caseNumber?: string; hearingDate?: string };
  parties: MatterParty[];
  createdAt: string;
  updatedAt: string;
  /** Purge deadline (ISO); null = keep until the user deletes. */
  retainUntil: string | null;
}

export interface ContractDoc {
  id: string;
  matterId: string;
  fileName: string;
  mime: string;
  sha256: string;
  language: "ar" | "en" | "mixed";
  /** Plain text extracted locally. Encrypted at rest. */
  text: string;
  originalBase64?: string;
  importedAt: string;
}

export type ClauseCategory =
  | "parties" | "definitions" | "subject" | "price_payment" | "term_duration" | "termination"
  | "liability" | "indemnity" | "penalty" | "confidentiality" | "ip" | "non_compete"
  | "governing_law" | "dispute_resolution" | "force_majeure" | "assignment" | "notices"
  | "warranties" | "data_protection" | "language" | "other";

export interface Clause {
  id: string;
  contractId: string;
  index: number;
  heading: string;
  text: string;
  start: number;
  end: number;
  categories: ClauseCategory[];
}

export type FindingSeverity = "high" | "medium" | "low" | "info";

export interface ReviewFinding {
  id: string;
  ruleId: string;
  clauseId: string | null;
  severity: FindingSeverity;
  titleAr: string;
  explanationAr: string;
  suggestionAr?: string;
  /** Lawyer-pinned authorities resolved and in force at the matter date (avid). */
  authorities: string[];
  /** Retrieval suggestions for the rule's authority queries (avid) — a lawyer must confirm. */
  suggestedAuthorities: string[];
  /** Authorities the rule asked for but that could not be resolved/verified. */
  unresolvedAuthorityQueries: string[];
}

// ---------------------------------------------------------------------------
// Citations and verification
// ---------------------------------------------------------------------------

export type CitationStatus =
  | "VERIFIED"
  | "VERIFIED_NORMALIZED"     // matched only after orthographic folding (hamza, ta marbuta...)
  | "QUOTE_MISMATCH"
  | "QUOTE_TOO_SHORT"
  | "MISSING_QUOTE"
  | "UNKNOWN_ID"
  | "UNVERIFIED_SOURCE"       // text exists but provenance is research_snapshot
  | "NOT_IN_FORCE_AT_DATE"
  | "REPEALED"
  | "REF_WITHOUT_PRIOR_QUOTE"
  | "UNCITED_ARTICLE_REFERENCE"
  | "UNKNOWN_LAW_REFERENCE";

export type WarningCode =
  | "AMENDED_AFTER_DATE"
  | "NOT_RETRIEVED_IN_RUN"
  | "HISTORICAL_CITATION"
  | "ORTHOGRAPHIC_MATCH"
  | "UNCITED_LAW_REFERENCE";

export interface CitationCheck {
  /** Index of the token in the document (document order). */
  index: number;
  token: string;
  avid: string | null;
  kind: "cite" | "ref" | "free_article" | "free_law";
  status: CitationStatus | "OK";
  quote?: string;
  messageAr: string;
  messageEn: string;
  /** Formal Arabic citation rendered for VERIFIED tokens. */
  rendered?: string;
  span: { start: number; end: number };
}

export interface VerificationWarning {
  code: WarningCode;
  avid?: string;
  messageAr: string;
  messageEn: string;
}

export interface VerificationReport {
  verdict: "pass" | "pass_with_warnings" | "fail";
  asOf: string;
  checks: CitationCheck[];
  warnings: VerificationWarning[];
  /** sha256 of the document text that was verified. */
  documentSha256: string;
  /** Document with tokens replaced by formal citations (only when not "fail"). */
  renderedDocument?: string;
  corpusSnapshotId: string;
  coverage: CoverageReport;
  counts: { cited: number; verified: number; failed: number; freeMentions: number; unverifiedMarkers: number };
}

// ---------------------------------------------------------------------------
// Review gate and audit
// ---------------------------------------------------------------------------

export type ReviewState = "draft" | "verified" | "in_review" | "approved" | "rejected";

export interface ReviewComment {
  id: string;
  anchor: { start: number; end: number; quote: string };
  body: string;
  author: { name: string; licenseNo: string };
  createdAt: string;
}

export interface ReviewDecision {
  id: string;
  action: "comment" | "accept_warning" | "approve" | "reject";
  actor: { name: string; licenseNo: string };
  subject: string;
  reason?: string;
  at: string;
}

export interface AcceptedWarning {
  code: string;
  reason: string;
  reviewer: { name: string; licenseNo: string };
  acceptedAt: string;
}

export interface ReviewRecord {
  id: string;
  matterId: string;
  documentName: string;
  state: ReviewState;
  verifiedSha256?: string;
  approvedSha256?: string;
  verifiedCorpusSnapshotId?: string;
  approvedCorpusSnapshotId?: string;
  approvedArtifactSha256?: string;
  artifactId?: string;
  documentVersion?: import("./review/documentVersion.js").DocumentVersion;
  verification?: VerificationReport;
  sourceText?: string;
  comments: ReviewComment[];
  acceptedWarnings: AcceptedWarning[];
  decisions: ReviewDecision[];
  reviewer?: { name: string; licenseNo: string };
  decidedAt?: string;
  note?: string;
  history: Array<{ at: string; from: ReviewState; to: ReviewState; actor: string }>;
}

export type AuditAction =
  | "corpus.import" | "corpus.amend" | "search" | "cite_check" | "contract.import" | "evidence.import"
  | "contract.review" | "matter.create" | "matter.update" | "matter.delete" | "egress.decision"
  | "review.transition" | "review.comment" | "review.warning" | "run.start" | "run.cancel" | "run.resume" | "export.final" | "export.draft" | "purge"
  | "work.create" | "work.update" | "work.delete";

export interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  action: AuditAction;
  matterId: string | null;
  subject: string;
  /** Metadata only: ids, hashes, counts, model names. Never contract text. */
  details: Record<string, string | number | boolean | null>;
  prevHash: string;
  hash: string;
}
