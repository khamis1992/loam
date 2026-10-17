# memory-skills-mcp — ذاكرة دائمة وتعلّم مستمر لـ manus-local

خادم MCP (stdio) يمنح النظام **ذاكرة دائمة** بثلاث طبقات و**مكتبة مهارات قابلة للاسترجاع والتركيب والتحسين الذاتي**.

| الطبقة | التخزين | الغرض |
|---|---|---|
| Episodic | SQLite (`memory-skills.db`) + FTS5 | سجل لكل مهمة: الهدف، النتيجة، الملخص، الدروس، الأدوات، المخرجات |
| Semantic | SQLite + FTS5 | حقائق/تفضيلات دائمة (upsert بمفتاح ثابت، ودمج شبه المكرر تلقائياً) |
| Procedural | ملفات `skills/<slug>/SKILL.md` + فهرس وإحصاءات في SQLite | مهارات بصيغة متوافقة مع manus-local، مع نسخ تاريخ محفوظة في `history/` |

البحث هجين: FTS5 (عربي/إنجليزي) + تشابه متجهات اختياري عبر Ollama. بدون Ollama يعمل البحث النصي فقط (تدهور سلس، بلا خدمات خارجية).

## الأدوات (16)

| الأداة | الوظيفة |
|---|---|
| `recall` | استرجاع موحّد قبل المهمة: أقرب حلقات سابقة + حقائق + مهارات |
| `episode_record` / `episode_search` / `episode_get` / `episode_stats` | تسجيل المهام واسترجاعها وإحصاءات التعلّم |
| `fact_remember` / `fact_search` / `fact_forget` | الذاكرة الدلالية |
| `skill_record` / `skill_search` / `skill_get` | إنشاء المهارات واسترجاعها (الترتيب = الملاءمة × معدل النجاح) |
| `skill_report` | تغذية راجعة بعد الاستخدام (نجاح/فشل/جزئي + ملاحظات) |
| `skill_improve` | تحسين ذاتي: دمج الملاحظات في قسم «Lessons & Fixes» + رفع الإصدار مع الاحتفاظ بالنسخة السابقة |
| `skill_review` | طابور ما يحتاج انتباهاً: ملاحظات معلّقة، معدل نجاح منخفض، مهارات خاملة أو غير مستخدمة |
| `skill_compose` | تركيب مهارات في خطة واحدة مرتّبة (بدون تكرار، مع نسبة كل خطوة لمصدرها وفحص الأدوات) |
| `skill_from_trace` | تحويل تسجيل جلسة متصفح (`.browser-recordings/<name>.json`) أو خطوات جاهزة إلى مسودة مهارة |
| `dashboard` | لقطة JSON منظّمة للواجهات: إحصاءات الحلقات + أحدث الحلقات والحقائق + المهارات بسجل أدائها + طابور المراجعة |

## البناء والاختبار

```powershell
npm run build:memory-skills   # يبني addons/memory-skills-mcp/dist/server.cjs
npm run check:memory-skills   # فحص الأنواع للخادم
npm run smoke:memory-skills   # اختبار شامل عبر عميل MCP حقيقي (27 فحصاً)
```

## الربط (تم فعلاً في هذا المستودع)

أُضيف إلى `mcpServers` في **`config.json`** (تشغيل من المستودع) وفي **`%APPDATA%/manus-local/config.json`** (التطبيق المثبّت، بمسار مطلق للمستودع):

```json
"memory-skills": {
  "command": "node",
  "args": ["${ROOT}/addons/memory-skills-mcp/dist/server.cjs"],
  "env": {
    "MEMSKILLS_OLLAMA_URL": "http://127.0.0.1:11434",
    "MEMSKILLS_EMBED_MODEL": "nomic-embed-text:latest"
  }
}
```

تظهر أدواته في manus-local باسم `mcp__memory-skills__<tool>`.

### متغيرات البيئة (كلها اختيارية)

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `MEMSKILLS_DATA_DIR` | `MANUS_LOCAL_DATA_DIR/memory-skills` أو `./data/memory-skills` | مجلد قاعدة البيانات |
| `MEMSKILLS_SKILLS_DIR` | `MANUS_LOCAL_SKILLS_DIR` أو `./skills` | **نفس** مجلد مهارات manus-local (بحث/إحصاءات/تحسين فوق المكتبة الموجودة) |
| `MEMSKILLS_OLLAMA_URL` + `MEMSKILLS_EMBED_MODEL` | معطّل | تفعيل البحث المتجهي ودمج شبه المكرر |
| `MEMSKILLS_DEDUPE` | `0.97` | عتبة دمج الحقائق المتشابهة |
| `MEMSKILLS_WORKSPACE` | `cwd` | لحل مسارات تسجيلات المتصفح النسبية |
| `MEMSKILLS_DEBUG` | معطّل | سطر تشخيصي على stderr |

## لوحة الواجهة (brain.html)

صفحة «الذاكرة الدائمة» في واجهة manus-local (`/brain.html`، ورابطها من الصفحة الرئيسية) تعرض مباشرةً: اللقطة العامة، طابور المراجعة مع زر «تحسين الآن» (`skill_improve`)، أحدث الحلقات، المهارات مع سجل الأداء وعرض نص المهارة، والحقائق الدائمة. تعتمد على نقاط الخادم:

| النقطة | الوظيفة |
|---|---|
| `GET /api/brain?episodes=&facts=&skills=` | لقطة JSON (تمرير `dashboard`) |
| `GET /api/brain/skill?name=` | نص مهارة كامل (`skill_get`) |
| `POST /api/brain/improve` `{name}` | دمج ملاحظات الفشل ورفع الإصدار (`skill_improve`) |

## بروتوكول الاستخدام (يُرسل تلقائياً إلى الوكيل عند الاتصال)

1. قبل المهمة: `recall` بالهدف.
2. بعد المهمة: `episode_record`.
3. حقائق دائمة: `fact_remember` / `fact_search`.
4. إجراء متكرر: `skill_record` (بعد `skill_search` لتفادي التكرار).
5. بعد استخدام مهارة: `skill_report` مع ملاحظات عند أي فشل.
6. عند الفشل: `skill_improve` ثم `skill_review` دورياً.
7. لخطة متعددة الخطوات: `skill_compose`؛ ولتحويل تسجيل متصفح إلى مهارة: `skill_from_trace`.

## ملاحظات

- يتطلب Node ≥ 22.5 (وحدة `node:sqlite` مدمجة؛ لا تبعيات إضافية سوى MCP SDK الموجود أصلاً في المستودع).
- ملفات المهارات تبقى المصدر النهائي: ما تكتبه هنا تراه أدوات manus-local المدمجة (والمجردة) والعكس — الفهرس يُزامن تلقائياً.
- الأتمتة في manus-local: `recall` يُحقن قبل كل مهمة و`episode_record` يُنفَّذ بعدها تلقائياً (نجاحاً أو فشلاً) من `src/index.ts`; لا حاجة لأن يستدعي الوكيل أدوات التسجيل بنفسه.
- `addons/**` مضمن الآن في `electron-builder.yml` — تُشحن الإضافة مع المُثبّت مستقبلاً (والإعداد المباشر في `%APPDATA%/manus-local/config.json` يشير للمسار المطلق للمستودع في هذه الآلة).
