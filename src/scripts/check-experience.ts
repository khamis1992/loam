/**
 * H7 - Experience E2E offline check
 * Reference: BUILD_SPEC .h2-ref/BUILD_SPEC.md section 8 (mock fixture)
 *
 * This script runs the complete correction → lesson → injection pipeline offline
 * with a deterministic fake model. It must print PASS and exit 0 when the
 * lesson block for a new prompt in the same domain contains «نتريو».
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Set up a temporary LOAM_DATA_DIR BEFORE importing any modules that use it
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loam-experience-check-"));
const dataDir = path.join(tmp, "data");
process.env.LOAM_DATA_DIR = dataDir;
process.env.MANUS_LOCAL_DATA_DIR = dataDir;

// Now import the harness modules
import { detectCorrection } from "../learning/harness/correctionDetector.js";
import { recordCorrection, addLesson, listLessons } from "../learning/harness/experienceStore.js";
import { lessonsForTask } from "../learning/harness/inject.js";
import { domainOf } from "../learning/harness/types.js";
import { parseDistill } from "../learning/harness/distill.js";

// Mock model reply from BUILD_SPEC §8
const MOCK_MODEL_REPLY = '{"cue":"عند كتابة محتوى عربي عن التطبيق","lesson":"اكتب الاسم «نتريو» بالعربي وليس Nutrio","evidence":"المستخدم صحّح كتابة الاسم","confidence":"high"}';

async function main() {
  console.log(`[check-experience] Using temp data dir: ${dataDir}`);

  // 1. Define the correction episode from §8 mock
  const taskPrompt = "اكتب منشور عن نتريو";
  const priorAssistant = "Nutrio is a healthy meal app...";
  const userCorrection = "لا، قلت لك اكتب اسم نتريو بالعربي «نتريو» مو Nutrio";

  // 2. Run detectCorrection (H3)
  console.log("[check-experience] Step 1: detectCorrection...");
  const detection = detectCorrection({ priorAssistant, userText: userCorrection });
  assert.ok(detection.isCorrection, "detectCorrection should identify this as a correction");
  console.log(`  ✓ Detected correction (score: ${detection.score.toFixed(2)}, matched: ${detection.matched.join(", ")})`);

  // 3. Run recordCorrection (H2)
  console.log("[check-experience] Step 2: recordCorrection...");
  const domain = domainOf("nutrio-content");
  console.log(`  Domain: ${domain}`);
  const correctionEvent = recordCorrection({
    agentId: null,
    taskId: "task_test_001",
    domain,
    priorAssistant,
    userText: userCorrection,
  });
  assert.ok(correctionEvent.id.startsWith("cor_"), "correction id should have cor_ prefix");
  console.log(`  ✓ Recorded correction: ${correctionEvent.id}`);

  // 4. Run distill (H4) - using fake model reply
  console.log("[check-experience] Step 3: distill (fake model)...");
  const distillResult = parseDistill(MOCK_MODEL_REPLY);
  assert.ok(distillResult !== null, "parseDistill should return a complete DistillResult");
  assert.ok(distillResult!.cue.length > 0, "cue should be non-empty");
  assert.ok(distillResult!.lesson.length > 0, "lesson should be non-empty");
  assert.ok(distillResult!.evidence.length > 0, "evidence should be non-empty");
  assert.ok(["low", "medium", "high"].includes(distillResult!.confidence), "confidence should be valid");
  console.log(`  ✓ Parsed distill result: cue="${distillResult!.cue}", lesson="${distillResult!.lesson}"`);

  // 5. Run addLesson (H2)
  console.log("[check-experience] Step 4: addLesson...");
  const lesson = await addLesson({
    agentId: null,
    domain,
    source: "correction",
    sourceRef: correctionEvent.id,
    d: distillResult!,
    embedder: undefined, // no embedder for offline check
  });
  assert.ok(lesson !== null, "addLesson should return a lesson");
  assert.ok(lesson!.id.startsWith("les_"), "lesson id should have les_ prefix");
  assert.ok(lesson!.lesson.includes("نتريو"), "lesson should contain نتريو");
  console.log(`  ✓ Added lesson: ${lesson!.id} (domain: ${lesson!.domain})`);

  // 6. Run lessonsForTask for a NEW prompt in the same domain (H5)
  console.log("[check-experience] Step 5: lessonsForTask (new prompt in same domain)...");
  const newPrompt = "اكتب محتوى عربي عن التطبيق نتريو";
  const { block, ids } = lessonsForTask({
    agentId: null,
    domain,
    prompt: newPrompt,
    vector: undefined,
    enabled: true,
  });
  console.log(`  ✓ Got lesson block (${ids.length} lessons used)`);
  console.log(`  Block:\n${block}`);

  // 7. Assert the block contains «نتريو»
  console.log("[check-experience] Step 6: Assert block contains «نتريو»...");
  assert.ok(block.includes("نتريو"), "Lesson block must contain «نتريو»");
  console.log(`  ✓ Block contains «نتريو»`);

  // Also verify the lesson is in the store
  const all = listLessons({ domain });
  assert.ok(all.some(l => l.id === lesson!.id), "Lesson should be retrievable from store");

  console.log("PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ FAIL:", err);
  process.exit(1);
});