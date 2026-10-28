import type { LegalPack } from "../corpusStore.js";
import type { SourceRef } from "../types.js";

export interface OfficialSourceCandidate {
  legislation: LegalPack["legislation"];
  source: Omit<SourceRef, "verifiedBy" | "verifiedAt">;
  reviewNotes: string[];
}

export const OFFICIAL_GAZETTE_URL = "https://officialgazette.gov.qa/";

export const OFFICIAL_SOURCE_CANDIDATES: readonly OfficialSourceCandidate[] = [
  {
    legislation: { type: "law", year: 2004, number: 22, titleAr: "قانون رقم (22) لسنة 2004 بإصدار القانون المدني", aliases: ["القانون المدني"], issueDate: "2004-06-30", publishDate: "2004-08-08" },
    source: { provenance: "almeezan_manual", url: "https://almeezan.qa/legislations/41003d1a-cbd9-4dc3-bc21-fa6e4565c2d7", gazetteIssue: "11", gazetteDate: "2004-08-08", retrievedAt: "2026-10-27" },
    reviewNotes: ["Verify the final commencement article and all amendments before choosing effectiveDate.", "Articles 265 and 266 address agreed compensation and require exact-text review."],
  },
  {
    legislation: { type: "law", year: 1990, number: 13, titleAr: "قانون رقم (13) لسنة 1990 بإصدار قانون المرافعات المدنية والتجارية", aliases: ["قانون المرافعات"], issueDate: "1990-06-17", publishDate: "1990-01-01" },
    source: { provenance: "almeezan_manual", url: "https://almeezan.qa/legislations/5c9caa69-4dc1-4d92-9543-9ba236171476", gazetteIssue: "13", gazetteDate: "1990-01-01", retrievedAt: "2026-10-27" },
    reviewNotes: ["The card shows 1990-01-01 while article pages show 1990-10-15; verify the Gazette before assigning dates.", "Execution provisions were repealed by Law 4/2024 and must not be returned as current law."],
  },
  {
    legislation: { type: "law", year: 2006, number: 27, titleAr: "قانون رقم (27) لسنة 2006 بإصدار قانون التجارة", aliases: ["قانون التجارة"], issueDate: "2006-07-27", publishDate: "2006-11-13" },
    source: { provenance: "almeezan_manual", url: "https://almeezan.qa/legislations/41dac9e8-6191-4518-83c7-edafe16377e3", gazetteIssue: "10", gazetteDate: "2006-11-13", retrievedAt: "2026-10-27" },
    reviewNotes: ["The card shows 2006-11-13 while article pages show 2007-05-12; verify the Gazette.", "Commencement is delayed six months, with a separate three-year rule for Article 580; do not infer effectiveDate automatically."],
  },
  {
    legislation: { type: "law", year: 2004, number: 14, titleAr: "قانون رقم (14) لسنة 2004 بإصدار قانون العمل", aliases: ["قانون العمل"], issueDate: "2004-05-19", publishDate: "2004-07-06" },
    source: { provenance: "almeezan_manual", url: "https://almeezan.qa/legislations/law/2004/14/general", gazetteIssue: "9", gazetteDate: "2004-07-06", retrievedAt: "2026-10-27" },
    reviewNotes: ["Verify the commencement article and subsequent amendments, including issuing-article amendments."],
  },
  {
    legislation: { type: "law", year: 2016, number: 13, titleAr: "قانون رقم (13) لسنة 2016 بشأن حماية خصوصية البيانات الشخصية", aliases: ["حماية البيانات الشخصية"], issueDate: "2016-11-03", publishDate: "2016-12-29" },
    source: { provenance: "almeezan_manual", url: "https://almeezan.qa/legislations/law/2016/13/general", gazetteIssue: "15", gazetteDate: "2016-12-29", retrievedAt: "2026-10-27" },
    reviewNotes: ["Check exemptions and later regulatory amendments before treating data-processing analysis as complete."],
  },
  {
    legislation: { type: "law", year: 2017, number: 2, titleAr: "قانون رقم (2) لسنة 2017 بإصدار قانون التحكيم في المواد المدنية والتجارية", aliases: ["قانون التحكيم"], issueDate: "2017-02-16", publishDate: "2017-03-13" },
    source: { provenance: "almeezan_manual", url: "https://almeezan.qa/legislations/law/2017/2/general", gazetteIssue: "3", gazetteDate: "2017-03-13", retrievedAt: "2026-10-27" },
    reviewNotes: ["Verify the commencement article and any subsequent amendments before activation."],
  },
];
