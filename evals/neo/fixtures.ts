/**
 * The ten N20 long-horizon fixtures.
 *
 * Each fixture is a self-contained, offline, deterministic case: a prompt, a
 * scripted model, seeded knowledge, and assertions the scorer checks. Together
 * they cover the four scored dimensions (completion, citation, flatness,
 * recovery) plus the recurring and restart behaviours the gate exists to
 * protect.
 *
 * A recurring fixture's script has one entry per round; each round is a fresh
 * agent run at its own virtual-clock instant, so the tracker has to accumulate
 * across rounds on disk rather than in the model's memory.
 */
import { text } from "./_text.js";
import type { NeoFixture, NeoScriptRuntime } from "../../src/neoEval/types.js";

/** Build the 100-section document used by the long-document fixture. */
export function longDocument(sections = 100): string {
  const lines: string[] = [];
  for (let i = 1; i <= sections; i++) {
    lines.push(`## Section ${i}`);
    lines.push("");
    lines.push(`Section ${i} records the ${i}${ordinal(i)} observation in the dossier.`);
    lines.push("");
  }
  return lines.join("\n");
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

export const NEO_FIXTURES: NeoFixture[] = [
  // ------------------------------------------------------------------ 1
  {
    id: "research-to-report",
    name: "Multi-round research into a cited report",
    dimension: "completion",
    prompt:
      "Research the seeded knowledge base and write a report to report.md. Cover every seeded document, " +
      "cite each claim as [seed:ID], and finish with a short conclusion.",
    tools: ["file_read", "file_write", "file_list", "file_search", "kb_search"],
    seeds: [
      {
        id: "kb-001",
        title: "Northwind tariff schedule",
        body: "The Northwind tariff schedule sets a 7 percent import duty on semiconductor substrates.",
        tags: ["tariff", "northwind"],
      },
      {
        id: "kb-002",
        title: "Port of Alameda congestion note",
        body: "The Port of Alameda reported a 19 day average dwell time for container vessels in Q3.",
        tags: ["shipping", "alameda"],
      },
      {
        id: "kb-003",
        title: "Grain futures bulletin",
        body: "Grain futures fell 4.2 percent after the harvest forecast was revised upward by the ministry.",
        tags: ["futures", "grain"],
      },
      {
        id: "kb-004",
        title: "Freight insurance addendum",
        body: "The freight insurance addendum raises premiums for routes transiting the southern corridor.",
        tags: ["insurance", "freight"],
      },
    ],
    script: {
      steps: [
        {
          text: text("Let me search the knowledge base for the tariff schedule."),
          calls: [{ tool: "kb_search", args: { query: "tariff semiconductor duty" } }],
        },
        {
          text: text("And the shipping congestion figures."),
          calls: [{ tool: "kb_search", args: { query: "port congestion dwell time" } }],
        },
        {
          text: text("Let me capture the futures move before writing."),
          calls: [{ tool: "kb_search", args: { query: "grain futures harvest" } }],
        },
        {
          text: text("One more lookup for the insurance terms."),
          calls: [{ tool: "kb_search", args: { query: "freight insurance premium corridor" } }],
        },
        {
          text: text("I have all four sources. Writing the report now."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "report.md",
                content:
                  "# Trade conditions report\n\n" +
                  "- Import duty: the Northwind tariff schedule sets a 7 percent duty on semiconductor substrates [seed:kb-001].\n" +
                  "- Port congestion: the Port of Alameda reported a 19 day average dwell time in Q3 [seed:kb-002].\n" +
                  "- Grain futures: futures fell 4.2 percent after the harvest forecast was revised [seed:kb-003].\n" +
                  "- Insurance: the freight addendum raises premiums for the southern corridor [seed:kb-004].\n\n" +
                  "Conclusion: costs are rising on both the tariff and the shipping side.\n",
              },
            },
          ],
        },
        { text: text("The report is written to report.md and cites all four seeded documents.") },
      ],
    },
    capture: ["report.md"],
    asserts: [
      { kind: "file_exists", path: "report.md" },
      { kind: "file_matches", path: "report.md", value: "seed:kb-001" },
      { kind: "file_matches", path: "report.md", value: "seed:kb-004" },
      { kind: "trace_used", tool: "kb_search" },
      { kind: "count_min", tool: "kb_search", count: 3 },
      { kind: "trajectory", expect: { steps: [{ tool: "kb_search" }, { tool: "file_write", args: { path: "report.md" } }], ordering: "relaxed", forbiddenTools: ["shell_run"] } },
    ],
  },

  // ------------------------------------------------------------------ 2
  {
    id: "recurring-tracker",
    name: "Recurring tracker across a virtual week",
    dimension: "recurring",
    // Weekly Monday 09:00 UTC — the shape the production schedule layer
    // actually parses (5-field cron, not a custom cadence keyword).
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    prompt:
      "This is a recurring weekly check. Append this week's entry to tracker.md, then read the file back and " +
      "report how many entries it now holds. Never overwrite an earlier entry.",
    tools: ["file_read", "file_write", "file_edit", "file_list"],
    rounds: [
      { at: "2026-01-05T09:00:00Z", name: "week-1", prompt: "Week 1: record shipments 412, dwell 18 days." },
      { at: "2026-01-12T09:00:00Z", name: "week-2", prompt: "Week 2: record shipments 438, dwell 17 days." },
      { at: "2026-01-19T09:00:00Z", name: "week-3", prompt: "Week 3: record shipments 455, dwell 16 days." },
      { at: "2026-01-26T09:00:00Z", name: "week-4", prompt: "Week 4: record shipments 471, dwell 15 days." },
    ],
    script: {
      steps: [
        {
          text: text("I will read the existing tracker before appending."),
          calls: [{ tool: "file_read", args: { path: "tracker.md" } }],
        },
        {
          text: text("Appending this round's entry."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "tracker.md",
                append: true,
                content: "2026-01-05 shipments 412 dwell 18\n",
              },
            },
          ],
        },
        {
          text: text("Reading it back to confirm the accumulated entries."),
          calls: [{ tool: "file_read", args: { path: "tracker.md" } }],
        },
        { text: text("The tracker is updated and the earlier entries are preserved.") },
      ],
    },
    capture: ["tracker.md"],
    asserts: [
      { kind: "file_exists", path: "tracker.md" },
      { kind: "count_min", tool: "file_write", count: 4 },
      { kind: "count_min", tool: "file_read", count: 4 },
    ],
  },

  // ------------------------------------------------------------------ 3
  {
    id: "long-document-assembly",
    name: "Assembling a 100-section long document",
    dimension: "completion",
    prompt:
      "Write dossier.md containing exactly 100 numbered sections. Each section is a heading reading " +
      "\"## Section N\" followed by one sentence. Write it in a single pass.",
    tools: ["file_read", "file_write", "file_edit", "file_list"],
    script: {
      steps: [
        {
          text: text("Generating the 100 sections now."),
          calls: [{ tool: "file_write", args: { path: "dossier.md", content: longDocument(100) } }],
        },
        {
          text: text("Let me verify the section count before finishing."),
          calls: [{ tool: "file_read", args: { path: "dossier.md" } }],
        },
        { text: text("dossier.md contains 100 numbered sections.") },
      ],
    },
    capture: ["dossier.md"],
    asserts: [
      { kind: "file_exists", path: "dossier.md" },
      { kind: "file_matches", path: "dossier.md", value: "## Section 1\\b" },
      { kind: "file_matches", path: "dossier.md", value: "## Section 100\\b" },
      { kind: "count_min", tool: "file_write", count: 1 },
    ],
  },

  // ------------------------------------------------------------------ 4
  {
    id: "kb-grounded-answer",
    name: "Answering strictly from the seeded knowledge base",
    dimension: "citation",
    prompt:
      "Answer the question in answer.md using ONLY the seeded knowledge base. Every claim must carry a " +
      "[seed:ID] citation. Do not guess or invent a source.",
    tools: ["file_read", "file_write", "file_list", "kb_search"],
    seeds: [
      {
        id: "kb-101",
        title: "Battery cell chemistry",
        body: "The reference cell uses a nickel-manganese-cobalt cathode with a silicon-doped anode.",
        tags: ["battery", "chemistry"],
      },
      {
        id: "kb-102",
        title: "Thermal runway limit",
        body: "Sustained operation above 62 degrees Celsius reduces the cell's cycle life by half.",
        tags: ["thermal", "limit"],
      },
      {
        id: "kb-103",
        title: "Charge curve policy",
        body: "The charge curve policy caps the fast-charge rate at 1.5C above 80 percent state of charge.",
        tags: ["charging", "policy"],
      },
    ],
    script: {
      steps: [
        {
          text: text("Searching for the cathode chemistry."),
          calls: [{ tool: "kb_search", args: { query: "cathode chemistry anode" } }],
        },
        {
          text: text("Searching for the thermal limit."),
          calls: [{ tool: "kb_search", args: { query: "thermal limit temperature cycle life" } }],
        },
        {
          text: text("Searching for the charge policy."),
          calls: [{ tool: "kb_search", args: { query: "charge curve fast charge rate" } }],
        },
        {
          text: text("Writing the grounded answer."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "answer.md",
                content:
                  "# Answer\n\n" +
                  "- The reference cell uses a nickel-manganese-cobalt cathode with a silicon-doped anode [seed:kb-101].\n" +
                  "- Sustained operation above 62 degrees Celsius halves cycle life [seed:kb-102].\n" +
                  "- Fast charging is capped at 1.5C above 80 percent state of charge [seed:kb-103].\n",
              },
            },
          ],
        },
        { text: text("The answer is written to answer.md and cites every claim.") },
      ],
    },
    capture: ["answer.md"],
    asserts: [
      { kind: "file_exists", path: "answer.md" },
      { kind: "file_matches", path: "answer.md", value: "seed:kb-101" },
      { kind: "file_matches", path: "answer.md", value: "seed:kb-102" },
      { kind: "file_matches", path: "answer.md", value: "seed:kb-103" },
      { kind: "count_min", tool: "kb_search", count: 3 },
    ],
  },

  // ------------------------------------------------------------------ 5
  {
    id: "tool-failure-recovery",
    name: "Recovering from repeated tool failures",
    dimension: "recovery",
    prompt:
      "Create summary.md with one line: \"recovered\". A tool you need may fail; when it does, recover and " +
      "still deliver the file.",
    tools: ["file_read", "file_write", "file_edit", "file_list", "kb_search"],
    script: {
      // The first two writes fail; the third succeeds. The run must still deliver.
      onCall: (tool: string, _args: Record<string, unknown>, runtime: NeoScriptRuntime) => {
        if (tool !== "file_write" || runtime.calls >= 2) return undefined;
        return `injected failure: ${tool} (attempt ${runtime.calls + 1})`;
      },
      steps: [
        {
          text: text("Trying to write the summary."),
          calls: [{ tool: "file_write", args: { path: "summary.md", content: "recovered\n" } }],
        },
        {
          text: text("That write was rejected. Retrying it."),
          calls: [{ tool: "file_write", args: { path: "summary.md", content: "recovered\n" } }],
        },
        {
          text: text("Still blocked; retrying once more."),
          calls: [{ tool: "file_write", args: { path: "summary.md", content: "recovered\n" } }],
        },
        {
          text: text("The write succeeded. Verifying the file."),
          calls: [{ tool: "file_read", args: { path: "summary.md" } }],
        },
        { text: text("summary.md now contains \"recovered\".") },
      ],
    },
    capture: ["summary.md"],
    asserts: [
      { kind: "file_exists", path: "summary.md" },
      { kind: "file_matches", path: "summary.md", value: "recovered" },
      { kind: "count_min", tool: "file_write", count: 3 },
      { kind: "trajectory", expect: { steps: [{ tool: "file_write", args: { path: "summary.md" } }, { tool: "file_read", args: { path: "summary.md" } }], ordering: "relaxed" }, minScore: 0.5 },
    ],
  },

  // ------------------------------------------------------------------ 6
  {
    id: "restart-from-step",
    name: "Resuming after an interruption mid-run",
    dimension: "recovery",
    prompt:
      "Gather the two source facts, then write findings.md combining them. If the run is interrupted, resume " +
      "from the step you were on instead of starting over.",
    tools: ["file_read", "file_write", "file_list", "kb_search"],
    seeds: [
      { id: "kb-201", title: "Fact one", body: "The first fact: the depot holds 1,204 units in reserve.", tags: ["fact"] },
      { id: "kb-202", title: "Fact two", body: "The second fact: the depot turns over 96 units per day.", tags: ["fact"] },
    ],
    // The harness interrupts this run after the first tool call and resumes it
    // from the saved checkpoint, so the second lookup happens after the resume.
    script: {
      steps: [
        {
          text: text("Looking up the first fact."),
          calls: [{ tool: "kb_search", args: { query: "depot reserve units" } }],
        },
        {
          text: text("Looking up the second fact."),
          calls: [{ tool: "kb_search", args: { query: "depot daily turnover" } }],
        },
        {
          text: text("Writing the combined findings."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "findings.md",
                content:
                  "# Findings\n\n- The depot holds 1,204 units in reserve [seed:kb-201].\n- It turns over 96 units per day [seed:kb-202].\n",
              },
            },
          ],
        },
        { text: text("findings.md combines both facts: the depot holds 1,204 units in reserve [seed:kb-201] and turns over 96 units per day [seed:kb-202].") },
      ],
    },
    capture: ["findings.md"],
    interruptAfter: 1,
    asserts: [
      { kind: "file_exists", path: "findings.md" },
      { kind: "file_matches", path: "findings.md", value: "seed:kb-201" },
      { kind: "file_matches", path: "findings.md", value: "seed:kb-202" },
      { kind: "trajectory", expect: { steps: [{ tool: "kb_search" }, { tool: "file_write", args: { path: "findings.md" } }], ordering: "relaxed" } },
      { kind: "resumed" },
    ],
  },

  // ------------------------------------------------------------------ 7
  {
    id: "step-budget",
    name: "Staying inside a step budget",
    dimension: "flatness",
    prompt:
      "Write notes.md with three bullet points, one per source, each citing its seed. Do this in as few steps " +
      "as possible.",
    tools: ["file_read", "file_write", "file_list", "kb_search"],
    seeds: [
      { id: "kb-301", title: "Alpha", body: "Alpha: the margin improved to 12 percent this quarter.", tags: ["margin"] },
      { id: "kb-302", title: "Beta", body: "Beta: the margin held at 9 percent despite higher freight.", tags: ["margin"] },
      { id: "kb-303", title: "Gamma", body: "Gamma: the margin fell to 6 percent after the duty increase.", tags: ["margin"] },
    ],
    script: {
      steps: [
        {
          text: text("Pulling all three margin figures in one search."),
          calls: [{ tool: "kb_search", args: { query: "margin percent" } }],
        },
        {
          text: text("Writing the three bullets."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "notes.md",
                content:
                  "# Notes\n\n- Alpha: margin improved to 12 percent [seed:kb-301].\n- Beta: margin held at 9 percent [seed:kb-302].\n- Gamma: margin fell to 6 percent [seed:kb-303].\n",
              },
            },
          ],
        },
        { text: text("notes.md is complete with three cited bullets.") },
      ],
    },
    capture: ["notes.md"],
    asserts: [
      { kind: "file_exists", path: "notes.md" },
      { kind: "file_matches", path: "notes.md", value: "seed:kb-301" },
      { kind: "file_matches", path: "notes.md", value: "seed:kb-303" },
    ],
  },

  // ------------------------------------------------------------------ 8
  {
    id: "no-hallucinated-citations",
    name: "Citing nothing that is not in the knowledge base",
    dimension: "citation",
    prompt:
      "Answer in brief.md: which seeded documents mention a tariff, and what rate do they give? Cite only " +
      "documents you actually retrieved.",
    tools: ["file_read", "file_write", "file_list", "kb_search"],
    seeds: [
      { id: "kb-401", title: "Tariff schedule", body: "The schedule lists a 7 percent duty on semiconductor substrates.", tags: ["tariff"] },
      { id: "kb-402", title: "Harbour dues", body: "Harbour dues are levied at 1.8 percent of cargo value.", tags: ["dues"] },
      { id: "kb-403", title: "Steel quota", body: "The steel quota caps annual imports at 420,000 tonnes.", tags: ["quota"] },
    ],
    script: {
      steps: [
        {
          text: text("Searching for tariff documents."),
          calls: [{ tool: "kb_search", args: { query: "tariff duty rate" } }],
        },
        {
          text: text("Writing the brief, citing only what I retrieved."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "brief.md",
                content: "# Brief\n\n- The tariff schedule gives a 7 percent duty [seed:kb-401].\n",
              },
            },
          ],
        },
        { text: text("brief.md cites only the retrieved tariff document.") },
      ],
    },
    capture: ["brief.md"],
    asserts: [
      { kind: "file_exists", path: "brief.md" },
      { kind: "file_matches", path: "brief.md", value: "seed:kb-401" },
      { kind: "trace_not_used", tool: "file_edit" },
    ],
  },

  // ------------------------------------------------------------------ 9
  {
    id: "deep-file-triage",
    name: "Reading a tree before writing the summary",
    dimension: "completion",
    prompt:
      "Inspect the seeded files under notes/, then write triage.md ranking the three issues by severity, each " +
      "with the file it came from.",
    tools: ["file_read", "file_write", "file_list", "file_search"],
    seedFiles: [
      { path: "notes/sev-1.md", text: "Issue: coolant leak in rack 12. Severity: critical.\n" },
      { path: "notes/sev-2.md", text: "Issue: fan bearing noise in rack 03. Severity: moderate.\n" },
      { path: "notes/sev-3.md", text: "Issue: label peeling on rack 07. Severity: low.\n" },
    ],
    script: {
      steps: [
        {
          text: text("Listing the notes directory."),
          calls: [{ tool: "file_list", args: { path: "." } }],
        },
        {
          text: text("Reading the first issue file."),
          calls: [{ tool: "file_read", args: { path: "notes/sev-1.md" } }],
        },
        {
          text: text("Reading the second issue file."),
          calls: [{ tool: "file_read", args: { path: "notes/sev-2.md" } }],
        },
        {
          text: text("Reading the third issue file."),
          calls: [{ tool: "file_read", args: { path: "notes/sev-3.md" } }],
        },
        {
          text: text("Writing the ranked triage."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "triage.md",
                content:
                  "# Triage\n\n1. critical: coolant leak in rack 12 (notes/sev-1.md)\n2. moderate: fan bearing noise in rack 03 (notes/sev-2.md)\n3. low: label peeling on rack 07 (notes/sev-3.md)\n",
              },
            },
          ],
        },
        { text: text("triage.md ranks all three issues by severity.") },
      ],
    },
    capture: ["triage.md"],
    asserts: [
      { kind: "file_exists", path: "triage.md" },
      { kind: "file_matches", path: "triage.md", value: "critical" },
      { kind: "file_matches", path: "triage.md", value: "notes/sev-1.md" },
      { kind: "count_min", tool: "file_read", count: 3 },
    ],
  },

  // ----------------------------------------------------------------- 10
  {
    id: "uninterrupted-baseline",
    name: "Clean baseline with no injected faults",
    dimension: "completion",
    prompt: "Write baseline.md with a single line confirming the run completed cleanly. Use one search first.",
    tools: ["file_read", "file_write", "file_list", "kb_search"],
    seeds: [{ id: "kb-501", title: "Baseline note", body: "The baseline run has no injected faults.", tags: ["baseline"] }],
    script: {
      steps: [
        {
          text: text("Confirming the baseline note."),
          calls: [{ tool: "kb_search", args: { query: "baseline note" } }],
        },
        {
          text: text("Writing the confirmation."),
          calls: [
            {
              tool: "file_write",
              args: {
                path: "baseline.md",
                content: "# Baseline\n\n- Completed cleanly with no injected faults [seed:kb-501].\n",
              },
            },
          ],
        },
        { text: text("baseline.md is written and the run completed cleanly.") },
      ],
    },
    capture: ["baseline.md"],
    asserts: [
      { kind: "file_exists", path: "baseline.md" },
      { kind: "file_matches", path: "baseline.md", value: "Completed cleanly" },
    ],
  },
];

/** Look up a fixture by id. */
export function fixtureById(id: string): NeoFixture | undefined {
  return NEO_FIXTURES.find((f) => f.id === id);
}
