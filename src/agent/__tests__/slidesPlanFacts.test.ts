import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptSlideFacts, applySlideFacts, fallbackPlan, fallbackPresentationPlan, preferCanvasPlan, preferCreativePlan, preferDatasetPlan, preferDesignPlan, preferDevflowPlan, preferDocxPlan, preferHtmlSlidePlan, preferLandingPlan, preferLegalPlan, preferMarkdownPlan, preferPhotoPlan, preferResearchPlan, preferSecurityPlan, preferSheetsPlan, preferSubtitlesPlan, preferVideoPlan, placeholderText, presentationRequest, slidesEditNeedsContent, type Plan } from "../planner.js";

function plan(body: string, title = "عنوان"): Plan {
  return {
    goal: "deck",
    trivial: false,
    source: "model",
    steps: [
      { id: "s1", title: "Open", instruction: "Call office_craft with action 'open' and app 'slides'.", successCriteria: "open" },
      { id: "s2", title: "Edit", instruction: `Call office_craft with action 'edit' and app 'slides' and title '${title}' and body '${body}'.`, successCriteria: "text" },
    ],
  };
}

describe("slides plan facts", () => {
  it("recognizes a presentation request", () => {
    assert.equal(presentationRequest("اعمل برزنتيشن من صفحة 1"), true);
    assert.equal(presentationRequest("write a note"), false);
  });

  it("requires real slide content without requiring an unrelated year", () => {
    assert.equal(slidesEditNeedsContent(plan("الكويت عاصمتها مدينة الكويت وعملتها الدينار")), false);
    assert.equal(slidesEditNeedsContent(plan("<Arabic body>")), true);
    assert.equal(slidesEditNeedsContent(plan("نص حقيقي", "<title>")), true);
    assert.equal(placeholderText("<the one slide>"), true);
  });

  it("replaces the edit instruction with the returned facts", () => {
    const next = applySlideFacts(plan("<Arabic body>"), "دولة الكويت", "العاصمة مدينة الكويت والعملة الدينار الكويتي");
    assert.match(next.steps[1]!.instruction, /title 'دولة الكويت'/);
    assert.match(next.steps[1]!.instruction, /الدينار الكويتي/);
    assert.equal(next.steps[0]!.instruction.includes("open"), true);
  });

  it("rejects placeholder facts and accepts useful content without a year", () => {
    const original = plan("<Arabic body>");
    assert.equal(applySlideFacts(original, "عنوان", "<Arabic body>"), original);
    assert.equal(acceptSlideFacts("اعمل برزنتيشن عن الكويت", "دولة الكويت", "اللغة العربية والعملة الدينار"), true);
    assert.equal(acceptSlideFacts("اعمل برزنتيشن عن الكويت", "Kuwait", "Arabic and dinar"), false);
  });

  it("builds a deterministic open-edit-export presentation plan with real content", () => {
    const next = fallbackPresentationPlan("اعمل برزنتيشن عن الكويت", "دولة الكويت", "العاصمة مدينة الكويت والعملة الدينار");
    assert.equal(next.steps.length, 3);
    assert.match(next.steps[0]!.instruction, /action 'open'/);
    assert.match(next.steps[1]!.instruction, /الدينار/);
    assert.match(next.steps[2]!.instruction, /دولة الكويت\.pptx/);
    assert.doesNotMatch(next.steps.map((step) => step.instruction).join("\n"), /<Arabic body>/);
  });

  it("falls back to open, edit, and export for a docx memo", () => {
    const next = fallbackPlan("Write a one-page memo about Q4 plans as a docx");
    assert.deepEqual(next.steps.map((step) => step.instruction.includes("app 'docs'")), [true, true, true]);
    assert.match(next.steps[1]!.instruction, /Q4 plans/);
    assert.equal(fallbackPlan("اعمل برزنتيشن من صفحة 1").steps.length, 1);
    const kept = preferDocxPlan("Write a memo as a docx", fallbackPlan("Write a memo as a docx"));
    assert.match(kept.steps[2]!.instruction, /export/);
    const thin: Plan = {
      goal: "memo",
      trivial: false,
      source: "model",
      steps: [
        { id: "s1", title: "Open", instruction: "Call office_craft with action 'open' and app 'docs'.", successCriteria: "open" },
        { id: "s2", title: "Edit", instruction: "Call office_craft with action 'edit' and app 'docs'.", successCriteria: "text" },
        { id: "s3", title: "Export", instruction: "Call office_craft with action 'export' and app 'docs'.", successCriteria: "file" },
      ],
    };
    const replaced = preferDocxPlan("Write a memo as a docx", thin);
    assert.match(replaced.steps[1]!.instruction, /body 'Write a memo as a docx'/);
  });

  it("uses the studio and office export when the editor is disabled", () => {
    const previous = process.env.LOAM_CRAFT_DISABLED;
    process.env.LOAM_CRAFT_DISABLED = "1";
    try {
      const prompt = "Write a one-page memo about Q4 plans as a docx";
      const next = preferDocxPlan(prompt, fallbackPlan("hello"));
      assert.match(next.steps[0]!.instruction, /loam_studio/);
      assert.match(next.steps[0]!.instruction, /Q4 Plans Memo/);
      assert.match(next.steps[1]!.instruction, /office_export/);
      assert.equal(next.steps.some((step) => /office_craft/.test(step.instruction)), false);
    } finally {
      if (previous === undefined) delete process.env.LOAM_CRAFT_DISABLED;
      else process.env.LOAM_CRAFT_DISABLED = previous;
    }
  });

  it("replaces a spreadsheet plan that has no formula grid", () => {
    const prompt = "Create a budget spreadsheet with 5 rows and a total";
    const thin: Plan = {
      goal: "budget",
      trivial: false,
      source: "model",
      steps: [
        { id: "s1", title: "Open", instruction: "Call office_craft with action 'open' and app 'sheets'.", successCriteria: "open" },
        { id: "s2", title: "Edit", instruction: "Call office_craft with action 'edit' and app 'sheets'.", successCriteria: "rows" },
        { id: "s3", title: "Export", instruction: "Call office_craft with action 'export' and app 'sheets'.", successCriteria: "file" },
      ],
    };
    const next = preferSheetsPlan(prompt, thin);
    assert.match(next.steps[1]!.instruction, /=SUM\(B2:B6\)/);
    assert.match(fallbackPlan(prompt).steps[1]!.instruction, /app 'sheets'/);
  });

  it("writes an explicit Markdown README with loam_document", () => {
    const prompt = "Write this as Markdown: a README for a CLI";
    const next = preferMarkdownPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /loam_document/);
    assert.match(next.steps[0]!.instruction, /README\.md/);
    assert.equal(fallbackPlan(prompt).steps.length, 1);
  });

  it("draws a vector poster with loam_canvas", () => {
    const prompt = "Draw a vector poster";
    const next = preferCanvasPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /loam_canvas/);
    assert.match(next.steps[0]!.instruction, /poster\.svg/);
    assert.equal(fallbackPlan(prompt).steps.length, 1);
  });

  it("saves a metal-base product scene with loam_creative", () => {
    const prompt = "Make a 3D product scene with a metal base";
    const next = preferCreativePlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /loam_creative/);
    assert.match(next.steps[0]!.instruction, /metal-base/);
    assert.equal(fallbackPlan(prompt).steps.length, 1);
  });

  it("calculates column statistics with loam_dataset", () => {
    const prompt = "give me statistics per column\n\n`attachments\\columns.csv`";
    const next = preferDatasetPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /loam_dataset/);
    assert.match(next.steps[0]!.instruction, /attachments\/columns\.csv/);
    assert.match(next.steps[0]!.instruction, /column-stats\.json/);
    assert.equal(fallbackPlan("give me statistics per column").steps.length, 1);
  });

  it("writes Arabic subtitles with creative_subtitles", () => {
    const prompt = "make Arabic subtitles\n\n`attachments\\clip.mp4`";
    const next = preferSubtitlesPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /creative_subtitles/);
    assert.match(next.steps[0]!.instruction, /attachments\/clip\.mp4/);
    assert.match(next.steps[0]!.instruction, /format 'both'/);
    assert.equal(fallbackPlan("make Arabic subtitles").steps.length, 1);
  });

  it("checks security headers and starts the local assessment", () => {
    const prompt = "Check security headers of http://127.0.0.1:3000";
    const next = preferSecurityPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /pentest_check/);
    assert.match(next.steps[0]!.instruction, /security_headers/);
    assert.match(next.steps[1]!.instruction, /security_assess/);
    assert.match(next.steps[1]!.instruction, /http:\/\/127\.0\.0\.1:3000/);
    assert.equal(fallbackPlan(prompt).steps.length, 2);
  });

  it("writes an HTML slide page with file_write and leaves a normal deck alone", () => {
    const prompt = "Build an HTML slide page about X";
    const next = preferHtmlSlidePlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /file_write/);
    assert.match(next.steps[0]!.instruction, /index\.html/);
    assert.match(next.steps[0]!.instruction, />X</);
    assert.match(next.steps[1]!.instruction, /app-verification\.json/);
    assert.doesNotMatch(next.steps.map((step) => step.instruction).join("\n"), /presentation_build|office_craft/);
    assert.equal(fallbackPlan(prompt).steps.length, 2);
    const deck = fallbackPlan("اعمل برزنتيشن من صفحة 1 عن متحف الفن الاسلامي في قطر");
    assert.equal(preferHtmlSlidePlan("اعمل برزنتيشن من صفحة 1 عن متحف الفن الاسلامي في قطر", deck), deck);
  });

  it("searches for the Node LTS and opens the release page", () => {
    const prompt = "Research the latest Node LTS and cite sources";
    const next = preferResearchPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /web_search/);
    assert.match(next.steps[0]!.instruction, /latest Node\.js LTS/);
    assert.match(next.steps[1]!.instruction, /browser_open/);
    assert.match(next.steps[1]!.instruction, /nodejs\.org/);
    assert.equal(fallbackPlan(prompt).steps.length, 2);
  });

  it("scaffolds a responsive landing page and serves a preview", () => {
    const prompt = "Build a responsive landing page";
    const next = preferLandingPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /web_scaffold/);
    assert.match(next.steps[0]!.instruction, /install 'false'/);
    assert.match(next.steps[1]!.instruction, /preview_serve/);
    assert.equal(fallbackPlan(prompt).steps.length, 2);
  });

  it("imports a clip, cuts at 2 seconds, adds music, and exports an mp4", () => {
    const prompt = "cut at 2 s, add music, export mp4\n`attachments\\\\clip.mp4`\n`attachments\\\\tone.wav`";
    const next = preferVideoPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /action 'import'/);
    assert.match(next.steps[0]!.instruction, /attachments\/clip\.mp4/);
    assert.match(next.steps[1]!.instruction, /atSec '2'/);
    assert.match(next.steps[2]!.instruction, /attachments\/tone\.wav/);
    assert.match(next.steps[3]!.instruction, /name 'montage'/);
    assert.equal(fallbackPlan(prompt).steps.length, 4);
  });

  it("opens Loam Photo, crops the image square, brightens, and exports a png", () => {
    const prompt = "crop it square and brighten";
    const next = preferPhotoPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /app 'photo'/);
    assert.match(next.steps[0]!.instruction, /attachments\/photo\.png/);
    assert.match(next.steps[1]!.instruction, /image\.crop/);
    assert.match(next.steps[1]!.instruction, /"width":4/);
    assert.match(next.steps[1]!.instruction, /deleteCroppedPixels/);
    assert.match(next.steps[2]!.instruction, /brightnessContrast/);
    assert.match(next.steps[3]!.instruction, /format 'png'/);
    assert.match(next.steps[3]!.instruction, /"crop"/);
    assert.equal(fallbackPlan(prompt).steps.length, 4);
  });

  it("opens Loam Design and exports an A4 flyer pdf", () => {
    const prompt = "Design an A4 event flyer layout";
    const next = preferDesignPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /app 'design'/);
    assert.match(next.steps[0]!.instruction, /"preset":"A4"/);
    assert.match(next.steps[1]!.instruction, /frame\.create/);
    assert.match(next.steps[1]!.instruction, /"rect":\[36,36,559,806\]/);
    assert.match(next.steps[2]!.instruction, /format 'pdf'/);
    assert.match(next.steps[2]!.instruction, /flyer\.pdf/);
    assert.equal(fallbackPlan(prompt).steps.length, 3);
  });

  it("searches the labour law corpus and reads the annual-leave article", () => {
    const prompt = "Find the Qatar labour law article on annual leave";
    const next = preferLegalPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /legal_search/);
    assert.match(next.steps[0]!.instruction, /إجازة سنوية/);
    assert.match(next.steps[1]!.instruction, /legal_article/);
    assert.match(next.steps[1]!.instruction, /lawKey 'law\/2004\/14'/);
    assert.match(next.steps[1]!.instruction, /label '79'/);
    assert.equal(fallbackPlan(prompt).steps.length, 2);
  });

  it("lists the throwaway issue, branches without pushing, and opens a draft pull request", () => {
    const prompt = "Dev Flow: list the github issue on khamis1992/loam-r18-throwaway, create git branch r18-route, run the swarm, then open a draft pr. Do not push.";
    const next = preferDevflowPlan(prompt, fallbackPlan("hello"));
    assert.match(next.steps[0]!.instruction, /github_list_issues/);
    assert.match(next.steps[1]!.instruction, /git_branch/);
    assert.equal(/push/i.test(next.steps[1]!.instruction), false);
    assert.match(next.steps[2]!.instruction, /swarm_run/);
    assert.match(next.steps[3]!.instruction, /swarm_status/);
    assert.match(next.steps[4]!.instruction, /draft 'true'/);
    assert.equal(fallbackPlan(prompt).steps.length, 5);
  });

  it("accepts an Arabic body that still names the designer and the year", () => {
    const prompt = "اعمل برزنتيشن من صفحة 1";
    assert.equal(acceptSlideFacts(prompt, "متحف الفن الإسلامي", "Designer: I.M. Pei, Opening Year: 2008"), false);
    assert.equal(acceptSlideFacts(prompt, "متحف الفن الإسلامي", "صممه I. M. Pei وافتتح عام 2008"), true);
  });
});
