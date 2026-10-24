export type PageKind = "session" | "lesson" | "note" | "handoff";

export const PAGE_KINDS: readonly PageKind[] = ["session", "lesson", "note", "handoff"];

export interface PageMeta {
  id: string;
  kind: PageKind;
  title: string;
  created: string;
  updated: string;
  tags: string[];
  /** Id of the page this one replaces; the older page is marked with `supersededBy`. */
  supersedes?: string;
  supersededBy?: string;
  sessionId?: string;
}

export interface Page {
  meta: PageMeta;
  body: string;
}

export interface SearchHit {
  id: string;
  kind: PageKind;
  title: string;
  score: number;
  snippet: string;
}
