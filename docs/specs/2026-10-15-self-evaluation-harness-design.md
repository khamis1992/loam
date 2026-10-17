# التقييم الذاتي وحلقة التعلّم — System Design

| | |
|---|---|
| **Status** | Approved v1.0 |
| **Date** | 2026-10-15 |
| **Scope** | Harness تقييم مستمر (نمط OSWorld/WebArena/GAIA) + telemetry يقود تصدير بيانات fine-tuning + self-critique/self-play |
| **Audience** | مطوّرو manus-local |
| **Basis** | كود manus-local الحالي (agent loop، reflect، learning UI) |

---

## 1. الأهداف

- **G1**: harness تقييم قابل للتشغيل محلياً: suites بصيغة JSON، كل حالة = prompt + verifiers برمجية (ground truth).
- **G2**: تشغيل الحالات عبر مسار الـ agent الحقيقي (نفس الأدوات والسياسات) في sandbox معزول لكل حالة.
- **G3**: telemetry منظّم لكل مهمة/حالة (tokens، زمن، tool calls، نجاح) — يقود التصدير والتحليل.
- **G4**: self-critique منظّم (JSON) لكل حالة، يغذّي بيانات التدريب ويكشف أسباب الفشل.
- **G5**: self-play: توليد حالات جديدة من الفشل + بوابة اعتماد قبل تشغيلها.
- **G6**: تصدير datasets جاهزة (SFT + preference) لأي مدرب خارجي.
- **G7**: تشغيل مستمر عبر scheduler + كشف انحدار passRate.

### خارج النطاق (v1)
- تدريب فعلي داخل التطبيق (Ollama لا يدرّب؛ التصدير يكفي).
- محاكاة VMs (OSWorld) أو مواقع مستضافة (WebArena).
- verifiers غير حتمية إلا اختيارياً (`llm_judge`).

## 2. نقاط التكامل الحالية

- `src/agent/loop.ts::runAgent` — إعادة استخدامها كما هي (+ إضافة قياس usage).
- `runTask` في `src/index.ts` — سكّ telemetry لكل مهمة عادية.
- `ToolRegistry` — نفس السجل يمرَّر للـ runner.
- `scheduler.ts` — إضافة tick للتقييم المستمر.
- `pending.ts` — لا تُمدَّد أنواعه؛ مسودات self-play لها مسار اعتماد خاص.
- `learning.html/js` — قسم جديد «التقييم الذاتي».

## 3. المتطلبات الوظيفية

1. `evals/<id>.json` تحمَّل من مجلد `evals/` (تجاوز `MANUS_LOCAL_EVALS_DIR`).
2. تنفيذ حالة: mkdir sandbox → تطبيق `setup` → `runAgent` → verifiers → نتيجة.
3. verifiers v1: `file_exists`, `file_absent`, `file_contains`, `file_matches` (regex), `shell_exit`, `shell_contains`, `http_ok`, `tool_used`, `answer_matches`, `llm_judge` (اختياري).
4. حالة تنجح فقط إذا نجحت كل verifiers؛ تُسجَّل checkpoints تفصيلية.
5. النتائج: `data/evals/runs/<runId>.json` + `data/evals/index.jsonl` (ملخصات).
6. telemetry: `data/telemetry/runs.jsonl` + transcripts في `data/telemetry/transcripts/`.
7. critiques: `data/telemetry/critiques.jsonl`.
8. مسودات self-play: `data/evals/drafts/<ts>-selfplay.json` + اعتماد بنسخها إلى `evals/`.
9. تصدير: `data/datasets/<ts>/{sft.jsonl,pref.jsonl,manifest.json,README.md}`.
10. API: `/api/eval/*` + `/api/telemetry/summary`؛ UI في صفحة التعلّم.
11. تشغيل مستمر: `evaluation.enabled=true` + `intervalMinutes` + تحذير انحدار (drop ≥ 0.2).

## 4. نموذج البيانات

```ts
type VerifierSpec =
  | { type: "file_exists" | "file_absent"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_matches"; path: string; pattern: string; flags?: string }
  | { type: "shell_exit"; command: string; exitCode?: number }
  | { type: "shell_contains"; command: string; text: string }
  | { type: "http_ok"; url: string; jsonPath?: string }
  | { type: "tool_used"; name: string; expectOk?: boolean; minCount?: number }
  | { type: "answer_matches"; pattern: string; flags?: string }
  | { type: "llm_judge"; rubric: string };

interface EvalCase {
  id: string; prompt: string;
  setup?: Array<{ type: "write_file"; path: string; text: string }>;
  verify?: VerifierSpec[];
  budget?: { maxSteps?: number; timeoutSec?: number };
  tags?: string[];
  network?: boolean;
}

interface EvalSuite { id: string; name: string; version: number; cases: EvalCase[]; }

interface CaseResult {
  id: string; status: "pass" | "fail" | "error" | "skipped";
  score: number; steps: number; durationMs: number; error?: string;
  usage: { promptTokens: number; completionTokens: number };
  checkpoints: Array<{ type: string; ok: boolean; detail: string }>;
  finalText: string;
  critique?: CritiqueResult | null;
}

interface EvalRun {
  id: string; suiteId: string; suiteName: string; model: string;
  startedAt: string; finishedAt: string;
  summary: { pass: number; fail: number; error: number; skipped: number; passRate: number; cases: number };
  cases: CaseResult[];
}

interface TelemetryRecord {
  at: string; kind: "task" | "eval-case";
  taskId?: string; runId?: string; caseId?: string;
  model: string; status: "done" | "error" | "stopped";
  steps: number; durationMs: number;
  usage: { promptTokens: number; completionTokens: number };
  toolCalls: Array<{ name: string; ok: boolean; ms?: number }>;
  promptHash: string; promptChars: number;
  passed?: boolean; score?: number; error?: string;
}

interface CritiqueResult {
  passed: boolean; score: number;
  reasons: string[]; failureCauses: string[]; betterPlan: string; lessons: string[];
}
```

## 5. تدفق التشغيل (Runner)

```
runSuite(suite, deps)
  for each case:
    sandbox = workspace/eval-runs/<runId>/<caseId>
    apply setup (كتابة fixtures)
    caseCfg = { ...cfg, workspace: sandbox,
                agent.maxSteps = budget.maxSteps ?? cfg }
    t0 = now
    try runAgent(caseCfg, prompt) → finalText, usage, messages
    catch → status=error
    checkpoints = evaluate(verify, { sandbox, finalText, trace })
    status = error ? error : checkpoints.every(ok) ? pass : fail
    critique (إذا enabled): critic.call(...) → critiques.jsonl
    transcript → transcripts/<runId>_<caseId>.json
    telemetry ← record(kind=eval-case)
  persist run + index ; كشف انحدار مقابل آخر run لنفس suite
```

- التشغيل **متسلسل** (حالة واحدة في وقت) لتفادي تداخل المتصفح/الشل.
- الحالات `network` تُتخطى إن `--offline` أو `cfg.policy.networkEnabled=false`.
- sandbox يبقى كدليل؛ تُقلَّم أقدم runs حسب `evaluation.keepRuns`.

## 6. Telemetry

- `ollama.ts` يقرأ `prompt_eval_count`, `eval_count`, `total_duration` من chunk الأخير → `ChatResult.usage`.
- `loop.ts` يجمع usage عبر الخطوات + زمن كل tool call (`ms` في حدث `tool_result`).
- `runTask` يسجّل record لكل مهمة عادية (بلا transcript افتراضياً).
- تقليم: عند تجاوز JSONL حجماً حدّياً تُحفَظ آخر N سطر.

## 7. Self-critique & Self-play

- **Critic**: موديل `selfImprove.model || model`، برومبت يطلب JSON صارماً؛ parse متسامح (استخراج أول `{...}`)؛ فشل النقد لا يُفشل الحالة.
- **Self-play**: يأخذ آخر حالات فاشلة → يولّد JSON حالات جديدة بنفس عقد EvalCase (verifiers حتمية إن أمكن، وإلا `llm_judge`) → مسودة + اعتماد يدوي.

## 8. تصدير Fine-tuning

- `sft.jsonl`: مسار كامل (system/user/assistant/tool) لكل حالة ناجحة.
- `pref.jsonl`: لكل caseId له نجاح وفشل: `{prompt, chosen, rejected, meta:{failureCauses, runId, model}}`.
- `manifest.json`: أعداد، موديل، تواريخ؛ `README.md`: شرح التنسيقات.

## 9. API / UI / Config / Scripts

API (في `http.ts`):
- `GET /api/eval/suites` — قائمة + آخر نتيجة لكل suite
- `POST /api/eval/run {suite}` → `{runId}` (خلفية، متزامن واحد)
- `GET /api/eval/runs?limit` / `GET /api/eval/runs/:id` (يشمل الجاري)
- `POST /api/eval/selfplay {fromRunId?, maxCases?}` → مسودة
- `POST /api/eval/drafts/install {name}` → اعتماد
- `POST /api/eval/export` → `{dir, sft, pref}`
- `GET /api/telemetry/summary` — إجماليات، passRate عبر الزمن، أكثر الأدوات فشلاً

UI (`learning.html`): قسم «التقييم الذاتي»: suites + تشغيل + progress polling + نتائج + self-play + export.

Config (`config.json`):
```json
"evaluation": { "enabled": false, "intervalMinutes": 360, "suite": "core",
                "critique": true, "keepRuns": 30, "transcripts": true },
"selfPlay": { "maxCases": 5 }
```

Scripts:
- `npm run eval -- --suite core [--case id] [--json] [--offline]`
- `npm run eval:selfplay [--run <runId>] [--max 5]`
- `npm run ft:export [--out data/datasets]`
- `npm run check:eval` (دخان بلا Ollama) — يُضاف إلى `npm run verify`

## 10. الجدولة المستمرة وكشف الانحدار

- `evaluation.enabled` → داخل `startScheduler` tick: إن حان الموعد ولم يوجد run جارٍ → run للـ suite المحدد.
- بعد أي run: قارن `passRate` مع آخر run نفس suite؛ drop ≥ 0.2 → `log.warn` + سطر في `learning.log`.

## 11. الأمان والحدود

- كل شيء محلي؛ لا رفع بيانات. الاستثناء الوحيد: `llm_judge`/critic يستخدمان موديل Ollama المكوَّن.
- `redact()` عند تسجيل الملخصات؛ transcripts تُقلَّم (سقف رسائل وطول).
- sandbox داخل `workspace/` فقط؛ verifiers لا تخرج عن الـ sandbox (containment check).

## 12. خطة الاختبار (Ground Truth)

1. `npm run typecheck`.
2. `npm run check:eval`: suite temp بحالتين + `runAgent` بديل (stub) → يؤكد pass/fail/verifiers/telemetry/transcript/persist/export — **بلا Ollama**.
3. `npm run eval -- --suite core` حقيقي (يتطلب Ollama) — تشغيل كامل أو جزئي.
4. `npm run verify` النهائي (typecheck + encoding + check:eval).

## 13. خطة التنفيذ المرحلية

1. config + ollama usage + loop/events telemetry hooks
2. `src/eval/*` (types, suites, verify, store, runner) + `evals/core.json`
3. `src/telemetry/store.ts` + ربط `runTask`
4. `src/learning/critic.ts` + `src/learning/selfplay.ts`
5. `src/eval/export.ts` + سكربتات CLI + `check:eval`
6. `src/setup/runtime.ts` (استخراج بناء السجل من index.ts)
7. API + UI + جدولة مستمرة
8. README + verify نهائي
