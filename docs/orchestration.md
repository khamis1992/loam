# نواة التنسيق (Orchestration Core) — دليل التشغيل

نواة `src/orchestration/` تضيف إلى Loam عشر قدرات مترابطة (C1-C10) وفريق البرمجة ذاتي التنظيم (C11، علامة «نتريو»). كل نداء نموذج تفعله النواة على نموذج سحابي حصرًا؛ الفشل أو غياب النموذج السحابي يُخفّض القدرة ولا يوقف التشغيل أبدًا.

## مفاتيح الإعداد (`orchestration.*` في config.json)

يُدمج الإعداد عميقًا فوق `ORCHESTRATION_DEFAULTS` ثم تُقيَّد كل قيمة رقمية بـ `clampOrchestration()`، فلا يستطيع ملفُ إعدادٍ معدول يدويًا تعطيل حد أمان.

| المفتاح | الافتراضي | المعنى |
|---|---|---|
| `tracing.enabled / sampleRate / retainDays / maxSpansPerTrace / captureContent / otlpEndpoint` | true / 1 / 14 / 5000 / false / "" | تتبع محلي في `manus.db` (جدول `trace_spans`)؛ لا تصدير شبكي إلا إذا كتب المستخدم نقطة نهاية OTLP بنفسه |
| `durability.mode / keepCheckpointsPerRun` | sync / 200 | متانة نقاط التفتيش |
| `interrupts.defaultTtlMs / maxPendingPerTask` | 30د / 20 | بطاقات الانتظار البشري الدائمة |
| `contracts.repairAttempts / injectionGuard / injectionThreshold` | 1 / warn / 0.6 | عقود JSON + حارس حقن الأوامر |
| `ledger.enabled / model / maxStallCount / maxResets / everyTurns / maxLedgerChars` | true / "" / 3 / 2 / 3 / 6000 | دفتر التقدم C1 (النموذج سحابي إلزامي) |
| `selection.enabled / model / maxCandidates / runRegressionChecks` | true / "" / 8 / true | اختيار المرشحين C3 |
| `acp.advertiseFs / advertiseTerminal / permissionDefault / modelSelection / passMcpServers` | true / false / ask / true / true | عميل ACP الكامل C4 |
| `returnDirect.enabled` | true | الإرجاع المباشر C10 |
| `workflows.enabled / maxSupersteps / maxParallelNodes / maxNodes` | false / 100 / 4 / 64 | مسارات العمل C7 |
| `evals.trajectory / judgeModel` | true / "" | تقييم المسار C8 |
| `memoryRanking.enabled / …` | false | ترتيب الذاكرة C9 (معطّل افتراضيًا) |
| `swarm.enabled / maxWorkers / claimTtlSeconds / deadlineMs / idleNudgeMs / activationStaggerMs / maxInFlightTurns / selectCompetingPatches / progressJudgement` | true / 4 / 3600 / 30د / 10د / 3ث / 4 / false / true | فريق البرمجة C11 |

## المسارات (HTTP)

| المسار | الوصف |
|---|---|
| `GET/POST /api/realswarm/runs` | قائمة عمليات فريق البرمجة / إنشاء عملية (نموذج سحابي فقط، وإلا 400) |
| `GET /api/realswarm/runs/:id` و `/board` | الحالة الكاملة واللوحة المشتركة |
| `POST /api/realswarm/runs/:id/cancel|retry|resume` | إيقاف / عمال جدد على نفس اللوحة والمستودع / استئناف كل عامل من آخر نقطة تفتيش (resume يتطلب قدرة التفتيش) |
| `GET /api/traces/task/:id` و `GET /api/traces/:traceId` و `POST /api/traces/export` | قراءة شجرة التتبع؛ التصدير يرفض (409) بلا نقطة نهاية |
| `GET /api/checkpoints…` + `POST fork` | فهرس نقاط التفتيش والتفريع مع تعديل الخطة |
| `GET/POST /api/interrupts…` | البطاقات المعلّقة وحلّها (ask_user / plan_approval / tool_approval / acp_permission / stalled_replan / workflow_human) |
| `GET/PUT/DELETE /api/workflows` و `POST /api/workflows/:id/run` و `GET /api/workflows/runs/:runId` | مسارات العمل: تعريف/تحقق/تشغيل/قراءة حالة التشغيل الدائمة |

## كيف تقرأ تتبعًا

`GET /api/traces/task/:taskId` يعيد كل spans المهمة. الجذر `loam.run`، وتحته لكل عملية فريق برمجة `loam.swarm.run` ثم `loam.swarm.worker` لكل عامل، وداخلها `loam.swarm.turn` و`loam.swarm.merge` ونداءات الأدوات بسمات GenAI. لا يغادر التتبع الجهاز إطلاقًا ما لم تكتب `tracing.otlpEndpoint`.

## كيف تستأنف / تفرّع

- **استئناف مقطوع:** عملية فريق برمجة أُوقفت بإغلاق التطبيق تظهر `interrupted`؛ `POST …/resume` يعيد كل عامل من آخر نقطة تفتيش بمفتاح `realswarm/<runId>/<workerId>`.
- **إعادة محاولة:** `POST …/retry` يطلق عمالًا جددًا على نفس اللوحة والمستودع.
- **تفريع تشغيل منسّق:** `POST /api/checkpoints/fork` مع `planEdit` يبدأ فرعًا من أي نقطة تفتيش مفهرسة.

## كيف تشغّل فريق برمجة

من استوديو «فريق البرمجة» (/realswarm.html) أو مباشرة:

```bash
curl -X POST http://127.0.0.1:3939/api/realswarm/runs -H "content-type: application/json" \
  -d '{"goal":"اكتب ملفين مستقلين مع اختبارات","maxWorkers":2}'
```

كل عامل وكيل كامل في worktree خاص؛ يعلن CLAIM على لوحة SQLite المشتركة، يتحقق بأمر حقيقي (evidence)، ثم يدمج المحرك إلى main بـ --no-ff تسلسليًا. العدادات كلها من git وصفوف اللوحة — لا رقم مُلفّق.

## الفحوص

```bash
npm run test:orchestration   # كل اختبارات النواة + ACP
npm run check:orchestration  # القواعد السبع (ترخيص، سحابي فقط، أسرار، one-Core، MiroFish)
npm run check:orchestration -- --mirofish-base=HEAD   # عدم مساس MiroFish بايتيًا
```
