# manus-local

> تحديث الحفظ والاستئناف: أصبح مخزن المهام SQLite مع ترحيل تلقائي من JSON، ونقاط استئناف وطابور تنفيذ مشترك. يتطلب التشغيل Node 22.13 أو أحدث. انظر [دليل المرحلة الثانية](docs/phase-two-recovery.md) لطريقة الاستئناف والنسخ الاحتياطي وحدود إعادة المحاولة.

نظام وكيل محلي (بمعمارية مشابهة لـ Manus) يعمل بـ **Ollama**، وكل الأدوات تُنفَّذ على جهازك:
طرفية، ملفات، جلب ويب، متصفح آلي (Playwright)، Computer Use (ويندوز)، مهارات MCP، وطابور مهام + جدولة.

## التشغيل

```powershell
cd C:\Users\khamis\Desktop\manus-local
npm install            # يثبّت Playwright بدون تنزيل متصفحات (نستخدم Edge/Chrome النظامي)
npm run typecheck
npm start              # ثم افتح http://127.0.0.1:3939
```

أو للتطوير: `npm run dev`.

## الإعداد (`config.json`)

| المفتاح | الوصف |
|---|---|
| `model` | نموذج Ollama الافتراضي (يدعم `:cloud` مثل `qwen3-coder-next:cloud`) |
| `fallbackModel` | نموذج احتياطي محلي عند فشل النموذج الأول |
| `workspace` | مجلد العمل الوحيد المسموح للكتابة |
| `policy.denyCommandPatterns` | أنماط أوامر ممنوعة (حماية) |
| `policy.networkEnabled` | السماح بالوصول الشبكي لأدوات الويب/المتصفح |
| `browser.channel` | `msedge` أو `chrome` (بدون تنزيل متصفح) |
| `orchestrator.enabled` | تفعيل حلقة Planner/Executor/Verifier + حلقة التأمل (بديل التسلسل الخطي) |
| `orchestrator.plannerModel` / `verifierModel` | نموذجا التخطيط والتحقق (فارغ = النموذج الرئيسي) |
| `orchestrator.maxStepsPerWorker` / `maxRevisionsPerStep` / `maxReplans` | حدود الوكيل التنفيذي ومحاولات المراجعة وإعادة التخطيط |
| `orchestrator.verifyFinal` | تحقق نهائي شامل بعد اكتمال الخطة (+ إصلاح واحد عند الرسوب) |
| `mcpServers` | خوادم MCP (stdio) لتفعيل المهارات |

## المعمارية (تكافؤ مع ما حلّلناه في Manus Studio)

```
Ollama (نماذج)  ←→  وكيل (حلقة تفكير/أدوات)  ←→  أدوات محلية
                        │
        ┌───────────────┼──────────────────────────────┐
        shell        files/web      browser        computer-use
      (policy)     (path guard)   (Playwright)   (PowerShell UIA)
                        │
                  MCP skills (stdio)   +   SQLite (مهام/جدولة)   +   Web UI (SSE)
```

- **Agent loop (Planner/Executor/Verifier)**: حلقة متعددة الوكلاء بدل التسلسل الخطي —
  **Plan** (المخطِّط يبني خطة JSON بخطوات ومعايير نجاح) ← **Act** (كل خطوة وكيل تنفيذي `worker` مستقل
  بالأدوات ومسارات النظام نفسها) ← **Observe** (تتبّع الأدوات والأدلة لكل خطوة) ← **Critique**
  (ناقد `verifier` يحكم على الخطوة بالأدلة: `pass|revise|fail`) ← **Revise** (إعادة تنفيذ الخطوة
  بملاحظات الناقد) مع **إعادة تخطيط** محدودة عند الفشل و**تحقق نهائي** شامل للناتج.
  بديل قديم: حلقة خطية واحدة عند `orchestrator.enabled=false`.
- **الحماية**: قائمة مسارات مسموحة، منع أنماط أوامر خطرة، مهل زمنية، تحديث المخرجات، وتنقية الأسرار من السجلات.
- **Skills**: ملفات `skills/<name>/SKILL.md` تُحقن في رسالة النظام (نفس فكرة إضافات Manus).
- **Tasks/Scheduler**: تُحفظ في `data/manus.db` (node:sqlite) وتُشغَّل يدوياً أو دورياً.

## ملاحظة قانونية/أخلاقية
هذا مشروع أصلي (clean-room). لم يُنسخ أي كود من ملفات Manus التنفيذية؛ التحليل السابق كان للفهم فقط.

---

## ما تم التحقق منه فعلياً (اختبار حقيقي)

- `npx tsc --noEmit` → نجح بلا أخطاء.
- `npm run ollama:check` → **النموذج السحابي `glm-5.3-flash:cloud` يدعم tool-calling** (أعاد `tool_calls` صحيحة).
  - تنبيه: `qwen3-coder-next:cloud` **متقاعد** (HTTP 410) — الافتراضي تغيّر إلى `glm-5.3-flash:cloud`.
- مهمة عربية كاملة عبر `/api/chat`: الوكيل استدعى `file_write` ثم `file_read` (3 خطوات) وأُنشئ
  `workspace/test/hello.txt` بمحتوى UTF-8 صحيح (24 بايت).
- الواجهة: `/` (HTML)، `/app.js`، `/styles.css`، `/api/models` (30 نموذجاً)، `/api/tasks`، `/api/schedules` — كلها 200.

## الأدوات (33 أداة)

| المجموعة | الأدوات |
|---|---|
| ملفات | `file_read`, `file_write`, `file_edit`, `file_list`, `file_search`, `file_stat`, `file_mkdir`, `file_move`, `file_delete` |
| طرفية | `shell_run`, `shell_start`, `shell_write`, `shell_read`, `shell_list`, `shell_kill` |
| ويب | `web_fetch` |
| متصفح (Playwright) | `browser_open`, `browser_goto`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_eval`, `browser_screenshot`, `browser_pages`, `browser_close` |
| Computer Use (ويندوز) | `computer_screenshot`, `computer_list_windows`, `computer_ui_tree`, `computer_focus_window`, `computer_click`, `computer_type`, `computer_key` |
| MCP | `mcp__<server>__<tool>` (تُسجَّل ديناميكياً من `config.json → mcpServers`) |

## واجهات HTTP

| المسار | الوصف |
|---|---|
| `GET /` | واجهة الويب |
| `POST /api/chat` | تشغيل مهمة (SSE): `{prompt, taskId?, model?}` |
| `GET /api/tasks`, `GET /api/tasks/:id` | المهام والسجل |
| `GET/POST /api/schedules`, `DELETE /api/schedules/:id` | الجدولة |
| `GET /api/models`, `GET /api/config` | النماذج والإعداد |

## الخطوات التالية (P1/P2 المقترحة)

1. **جلسات PTY حقيقية** (`node-pty`) بدل الأنابيب البسيطة، وواجهة طرفية في الويب.
2. **استيراد مهارات MCP جاهزة** (مثال: `@modelcontextprotocol/server-filesystem`، Playwright MCP) عبر `mcpServers`.
3. **Computer Use أذكى**: دمج `computer_ui_tree` + نقرة على العنصر (بدل الإحداثيات فقط).
4. **ذاكرة/بجث دلالي** باستخدام `nomic-embed-text` + تخزين متجهات بسيط.
5. **بث الشاشة/المراقبة** لتقرير ما يفعله الوكيل لحظياً (SSE→WebSocket).
6. **تغليف Electron** لسطح مكتب (مثل Manus Studio) مع Tray ومؤشّر نشاط.

---

# ✅ تحديثات P1 — نُفِّذت الأربعة

## 1) طرفية PTY حقيقية + واجهة طرفية
- `node-pty` يعمل فعلياً (ConPTY) — تحقق: `pty: node-pty loaded (real PTY sessions available)`.
- أدوات الوكيل: `pty_start`, `pty_write`, `pty_read`, `pty_list`, `pty_kill` (بوسائط shell/cwd/cols/rows).
- واجهة **xterm.js** على `/terminal.html` (تُخدم محلياً من `node_modules` عبر `/vendor/xterm.js`, `/vendor/xterm.css`, `/vendor/addon-fit.js` — بلا إنترنت).
- بثّ مباشر عبر SSE: `GET /api/pty/:id/stream` + `POST /api/pty/:id/input|resize` + `GET /api/pty/:id/output`.
- تحقق: تشغيل `powershell` عبر PTY وإرسال أمر وإرجاع المخرجات ✓.

## 2) خوادم MCP جاهزة (24 أداة إضافية)
مسجّلة تلقائياً من `config.json`:
| الخادم | الأدوات |
|---|---|
| `filesystem` | 14 |
| `memory` | 9 |
| `sequential-thinking` | 1 |
- تظهر للوكيل بأسماء `mcp__<server>__<tool>`، ويدعم الإعداد `${ROOT}` و`${WORKSPACE}`.

## 3) Computer Use بالعناصر (لا إحداثيات فقط)
- `computer_ui_tree` → شجرة مؤشّرة: `[index] depth Role 'name' @x,y wxh`.
- `computer_ui_list` → بحث بالاسم/الدور مع حدود العنصر (JSON).
- `computer_ui_click` → **يحلّ العنصر عبر إمكانية الوصول ثم ينقر مركزه**.
- `computer_ui_set_text` → ValuePattern إن توفّر، وإلا تركيز + لصق من الحافظة (يدعم العربية).
- `computer_focus_window`, `computer_click` (احتياطي), `computer_type`, `computer_key`, `computer_screenshot`, `computer_list_windows`.

### درس تقني مهم (مضاد الفيروسات)
Defender/AMSI كان **يحجب ويندوز PowerShell** لأن السكربت يجمع `mouse_event + SetCursorPos + GetForegroundWindow` أو يستدعي أنماط النقر (`Invoke/Toggle/Select`) — وهي توقيعات "إدخال قسري/clickjacking". الحل:
- `scripts/win-ui.ps1` **قراءة فقط**: شجرة إمكانية الوصول + لقطة + ValuePattern + تركيز (بلا Win32، بلا نقر).
- `scripts/input.ps1` منفصل للإدخال النصي (حافظة + SendKeys) — يمرّ بلا حجب.
- **الإدخال الفيزيائي (الفأرة) عبر `@nut-tree-fork/nut-js`** في Node.

## 4) تطبيق سطح مكتب Electron
- `electron/main.cjs`: يشغّل الخادم (حزمة `dist/server.cjs` عبر esbuild مع `ELECTRON_RUN_AS_NODE`)، ينتظر الجهوزية، يفتح نافذة 1440×920، قائمة "عرض" (المحادثة/الطرفية/DevTools)، ويقتل الخادم عند الإغلاق.
- أوامر: `npm run build:server` (بناء الحزمة ~2MB) ثم `npm run desktop` (تشغيل التطبيق).
- تحقق: الحزمة تُقلع وتُسجّل 65 أداة ✓.

## الأرقام النهائية
**65 أداة** = 41 محلية (ملفات 9، طرفية أنابيب 6، PTY 5، ويب 1، متصفح 10، Computer Use 10) + **24 MCP**.

---

# ✅ تحديثات P2 — الذاكرة الدلالية + البثّ الحيّ للشاشة (مع رؤية حقيقية)

## 1) ذاكرة دلالية محلية (nomic-embed-text + بحث متجهات)
- التضمين عبر Ollama: `/api/embed` (دفعة) مع تراجع إلى `/api/embeddings`. النموذج: `nomic-embed-text:latest` (**768 بُعداً**).
- المخزن: `data/memory.json` — متجهات **مطبَّعة** مُرمَّزة base64 (‏Float32) + بحث جيب التمام بالقوة الغاشمة (كافٍ لآلاف العناصر، بلا خدمات خارجية).
- **أدوات الوكيل**: `memory_store`, `memory_search`, `memory_list`, `memory_delete`.
- **استدعاء تلقائي (RAG)**: قبل كل مهمة تُستدعى أفضل 3 ذكريات (عتبة تشابه 0.45) وتُحقن في رسالة النظام.
- **حفظ تلقائي**: بعد كل مهمة ناجحة تُحفظ `Q→A` كذكرى (قابل للتعطيل: `memory.autoStore`).
- واجهة: `/memory.html` (بحث دلالي + إضافة + حذف).
- ✅ تحقق: تخزين عنصر (dim=768) ثم بحث دلالي بعبارة مختلفة → **0.794** تشابه مطابق.

## 2) بثّ الشاشة الحيّ للوكيل (والرؤية)
- خدمة `ScreenLive`: التقاط دوري (0.2–10 إطار/ث) + بثّ SSE + الاحتفاظ بآخر إطار.
- النقاط: `GET /api/screen/stream` (SSE صور)، `GET /api/screen/frame` (JPEG)، `POST /api/screen/start|stop`، `GET /api/screen/status`.
- **أدوات الوكيل**: `screen_look` (يُرفق الصورة للنموذج!)، `screen_stream_start/status/stop`.
- **رؤية حقيقية**: نتائج الأدوات صارت تحمل `images`، والحلقة تُرفقها في رسالة المستخدم التالية (Ollama `images`) — فيرى الوكيل الشاشة فعلاً.
- واجهة: `/screen.html` (عرض حيّ + تحكم).
- ✅ تحقق: الوكيل استدعى `screen_look` و**وصف شاشتك بدقة**: نافذة Excel، اسم الملف، ومحتوى الجدول العربي، وحالة AutoSave والساعة.

## ملاحظة أمنية ثانية (مضاد الفيروسات)
إضافة ترميز JPEG/التصغير **داخل PowerShell** (`ImageCodecInfo` + `DrawImage` على لقطة شاشة) أعادت تفعيل الحجب (توقيع "قناص شاشة"). الحل النهائي: **PowerShell يلتقط PNG خاماً فقط**، و`sharp` في Node يقوم بالتصغير والترميز إلى JPEG.

## الأرقام بعد P2
**73 أداة** = 49 محلية (‏+4 ذاكرة، +4 شاشة) + **24 MCP**.

---

# ✅ تحديثات P3 — واجهة بنمط manus.im + مشاريع + خطوات + معاينة + مؤشر نشاط

## 1) الواجهة الجديدة (نمط manus.im)
- **شريط جانبي**: شعار، «＋ مهمة جديدة»، بحث، تنقل (الرئيسية/المهام/المشاريع/الجدولة/الشاشة/الطرفية/الذاكرة)، قائمة المهام الأخيرة، مبدّل النموذج (30 نموذجاً)، زر المظهر (داكن/فاتح).
- **الرئيسية**: «ما الذي يمكنني فعله لك؟» + **7 مقترحات جاهزة** (عرض تقديمي، موقع، ألعاب، فيديو، تصميم، بحث وتقرير، انظر إلى شاشتي) + صندوق إدخال كبير + مهام حديثة كبطاقات.
- **المحادثة**: شريط الخطوات، بطاقات أدوات (الاسم + الوسائط + النتيجة/الحالة)، فقاعات الرسائل، حالة المهمة (يعمل/مكتمل/خطأ).
- **لوحة يمينية بثلاث تبويبات**: **الملفات** (شجرة مساحة العمل + عرض محتوى أي ملف) · **المعاينة** (iframe حيّ) · **الشاشة** (آخر إطار لحظي).
- المظهر الداكن الافتراضي مطابق لروح manus.im مع ثيم فاتح اختياري (يُحفظ في `data/settings.json`).

## 2) المشاريع (Projects)
- إنشاء مشروع باسم + **تعليمات دائمة** تُحقن تلقائياً في بداية كل مهمة داخل المشروع.
- تصفية المهام بحسب المشروع، وحذف المشروع (لا يحذف المهام).
- `GET/POST /api/projects`, `POST/DELETE /api/projects/:id`.

## 3) خطوات المهمة الحيّة (Task steps)
- كل مهمة تحفظ سجل خطواتها (step/tool_call/tool_result/done/error) في قاعدة البيانات.
- بثّ مباشر: `GET /api/tasks/:id/stream` (SSE) — يُعيد الخطوات السابقة ثم الحدث الحيّ. يمكن فتح مهمة قيد التشغيل ومتابعتها.

## 4) خدمة المعاينة (Preview)
- خدمة ملفات محلية: `preview_serve/preview_status/preview_stop` (أدوات للوكيل) + `POST /api/preview`.
- تعرض مشروع الموقع/اللعبة داخل التطبيق، مع **قائمة مجلدات تلقائية** عند غياب `index.html`.
- ✅ تحقق: خادم المعاينة يعمل ويخدم المجلد (HTTP 200).

## 5) Tray + مؤشر النشاط العائم
- **Tray** بأيقونة مولّدة + قائمة: فتح، مهمة جديدة، الشاشة، الطرفية، الذاكرة، إظهار/إخفاء مؤشر النشاط، خروج.
- **مؤشر النشاط**: نافذة صغيرة شفافة دائمة الأعلى أسفل الشاشة تعرض المهام الجارية لحظياً (استعلام كل 2.5ث).
- قائمة التطبيق: العرض (الرئيسية Ctrl+1، الشاشة Ctrl+2، الطرفية Ctrl+3، الذاكرة Ctrl+4).

## 6) مهارات أنواع المهام (6 Skills)
`slides` · `website` · `game` · `report` · `design` · `video` — كل مهارة تشرح خطوات العمل ومعيار التحقق (بما فيها التحقق البصري عبر المتصفح).

## 7) نقاط API جديدة
`/api/settings` · `/api/projects*` · `/api/tasks/:id/stream` · `/api/files` · `/api/file` · `/api/preview` · `/api/memory*` · `/api/screen*` · `/api/pty*`

## الأرقام بعد P3
**76 أداة** = 52 محلية (‏+3 معاينة) + **24 MCP** · 17 نقطة API · واجهة كاملة بنمط manus.im.

---

## ⚠️ قاعدة للمطوّرين: لا تُحرِّر ملفات UTF-8 بـPowerShell
`Get-Content` في PowerShell 5.1 يقرأ الملفات **بدون BOM** بترميز ANSI (cp1252) فيحوّل العربية إلى حروف لاتينية متتابعة
(نفس نمط البايتات UTF-8 حين تُفسَّر كأنها cp1252). <!-- encoding-check: allow -->
لذلك:
- استخدم محرّراً يكتب UTF-8 (أدوات Write/Edit) لملفات `ui/`, `electron/`, `skills/`.
- إن اضطررت لـPowerShell: `Get-Content -Encoding UTF8` و`Set-Content -Encoding utf8NoBOM` (PS 7).
- للإصلاح عند حدوث التشويه: `py scripts\fix-encoding2.py --apply` (يعكس التحويل إلى بايتات UTF-8 الأصلية).

---

# ✅ تحديثات P4 — المتصفح السريع (مساحة أفعال مفهرسة) + حلقة التحسين الذاتي

## 1) المتصفح السريع — مستوحى من browser-use/jev-ultrafast (MIT)
المصدر: <https://github.com/browser-use/jev-ultrafast> — وكيل متصفح بمعمارية «مساحة أفعال مفهرسة».
اعتمدنا **المعمارية فقط** (لا خدمات مدفوعة ولا Python)، وأعدنا تنفيذها في TypeScript فوق Playwright:

| المبدأ في Jev | التنفيذ عندنا |
|---|---|
| جدول عناصر مرقّم من قراءة DOM واحدة | `browser_table` → `[n] role "name" · "value"  ops:CLICK,TYPE_TEXT` (نصّي فقط، بلا لقطات) |
| عملية واحدة لكل خطوة: `CLICK/TYPE_TEXT/SELECT/SCROLL_UP/SCROLL_DOWN/WAIT/DONE/BLOCKED` | `browser_act {op, index, text?, snapshotId?}` |
| لا محددات ولا إحداثيات من النموذج | الفهرس فقط؛ التنفيذ يحلّ العنصر داخلياً |
| التحقق من الهدف قبل الإدخال | فحص الاتصال + الرؤية + **الحجب** (`elementFromPoint`) قبل النقر |
| رفض الحالات القديمة | `snapshotId` — أي فعل بملاحظة قديمة يُرفض بـ«stale observation» |
| الانتظار بعد الكتابة لظهور الاقتراحات | `TYPE_TEXT` ينتظر 150ms ثم يُعيد الجدول الجديد |
| إبقاء التبويبات المخفية تعمل | `Emulation.setFocusEmulationEnabled` عبر CDP لكل صفحة |
| النص يُولَّد فقط عند TYPE_TEXT | وكيلنا يكتب النص عند الحاجة فقط (نفس الاقتصاد) |

- مهارة جديدة: `skills/browser-fast/SKILL.md` (تشرح الحلقة والقواعد).
- لم نأخذ: TypeSafe API، Browser Harness، تنفيذ Python — كل شيء محلي.

## 2) حلقة التحسين الذاتي (استكمال تنفيذ جزئي كان موجوداً)
النظام كان يشير في رسالة النظام إلى أدوات غير منفّذة؛ أنجزناها ووحّدنا التوقيعات:
- `skill_list` · `skill_view` · `skill_create` · `skill_patch` (تكتب/تحدّث `skills/<name>/SKILL.md` مع تحقق من الاسم ومنع الهروب من المجلد).
- `session_search` موجود (بحث نصّي في مهامك السابقة من `data/db.json`) — أُزيل تكرار دلالي كان يسبّب تعارضاً.
- المراجع الخلفي `agent/reflect.ts` يستخدم الآن نفس الأدوات ويجمع ما تغيّر (`onApply`).

## 3) متانة التشغيل
- Electron: إعادة محاولة تشغيل الخادم ×3 عند فشل المنفذ + **إعادة تحميل تلقائية** للصفحة عند فشل التحميل.
- بدء الخادم يطبع فحص الترميز دائماً.

## التحقق
| الفحص | النتيجة |
|---|---|
| `check-fastbrowser.ts` (بلا أي نموذج) | ✅ جدول → `TYPE_TEXT(زيوريخ)` → `SELECT(Business)` → `CLICK` → المخرجات `HELLO:زيوريخ:Business` · ورفض الملاحظة القديمة ✅ |
| `check-tools.ts` (مهارات) | ✅ create/list/view/patch + رفض التكرار + رفض `../evil` |
| `npm run verify` | ✅ typecheck + encoding |
| الأدوات | **84** (منها 2 متصفح سريع + 4 مهارات) |

---

# ✅ تحديثات P5 — تسجيل جلسة المتصفح + لوحة المتصفح الحيّة

## 1) تسجيل وتتبّع الجلسة
- `browser_trace_start {name}` → يبدأ **تسجيل فيديو** (Playwright/ffmpeg) لكل صفحة تُفتح بعده + **سجل إجراءات**.
- `browser_act` / `browser_goto` يكتبان كل خطوة في السجل: العملية، الفهرس، النص، النجاح/الفشل، الرابط، الوقت.
- `browser_trace_stop` → يُنهي الفيديو ويحفظه كـ`.webm` + ملف تتبّع JSON، ويعيد المسارين.
- `browser_trace_status` → حالة الجلسة (تسجيل/صفحات/آخر جدول/أحدث الإجراءات/آخر ملفات).
- المخرجات في: `workspace/.browser-recordings/<name>.webm` و`<name>.json`.

## 2) لوحة المتصفح الحيّة في الواجهة
- تبويب **«المتصفح»** في اللوحة اليمنى (مع الملفات/المعاينة/الشاشة) يعرض لحظياً:
  - **جدول العناصر المفهرس** كما يراه الوكيل (نصّي)
  - آخر الإجراءات مع نجاح/فشل ملوّن
  - **مشغّل الفيديو** لآخر تسجيل
- نقاط جديدة: `GET /api/browser/state` و`GET /api/media?path=` (يخدم ملفات مساحة العمل بأنواع MIME صحيحة).
- عارض وسائط في تبويب الملفات: الصور والفيديو والصوت تُعرض مباشرة بدل نصّ خام.

## التحقق
| الفحص | النتيجة |
|---|---|
| `check-browser-trace.ts` | ✅ تسجيل → جدول → كتابة → نقر → إيقاف: **فيديو 21,892 بايت** + تتبّع بـ**إجرائين** → PASS |
| `GET /api/browser/state` | ✅ يعمل (recording/pages/actions) |
| الأدوات | **87** (‏+3 تتبّع المتصفح) |
| `npm run verify` | ✅ أنواع + ترميز نظيف |



---

# ✅ تحديثات P4 — حلقة التعلّم الذاتي (نمط Hermes)

## 1) مهارات يديرها الوكيل (ذاكرة إجرائية)
- أدوات جديدة: `skill_list`, `skill_view`, `skill_create`, `skill_patch`, `skill_delete`
  (تُكتب في `skills/<name>/SKILL.md`، والأسماء تُنقّى من أي مسار خارج المجلد).
- **تحميل انتقائي (Progressive disclosure)**: رسالة النظام تحمل **فهرس** المهارات فقط
  (الاسم + الوصف)؛ النص الكامل يُحمَّل عبر `skill_view` عند الحاجة فقط.

## 2) مراجعة تعلّم خلفية (self-improvement review)
- `src/agent/reflect.ts`: بعد كل `selfImprove.reviewEvery` مهمة ناجحة تُشغَّل مراجعة تعمل
  **بحلقة الوكيل نفسها** لكن بأدوات الذاكرة/المهارات فقط، فتُنشئ مهارة أو تُحسّن موجودة أو
  تحفظ حقيقة دائمة. كل تغيير يُسجَّل في `data/learning.log`. لا تُسقط المهمة لو فشلت.
- **بحث الجلسات**: `session_search` يبحث في المهام السابقة (`data/db.json`).

## 3) بوابة الموافقة على الكتابة (`selfImprove.writeApproval`)
- عند تفعيلها تُعلَّق كل كتابات المهارات/الذاكرة (من الوكيل أو المراجعة) بدل تطبيقها.
- المراجعة والتطبيق عبر: صفحة **التعلّم** `/learning.html`، أو
  `GET /api/pending` · `POST /api/pending/<id>/approve` · `POST /api/pending/<id>/reject`.

## 4) تنقيح الذاكرة الدلالية
- دمج المتشابهات عند `memory.dedupeThreshold` (تشابه جيبي)، وسقف `memory.maxEntries`
  بإزالة الأقدم وأولوية حذف الوسوم `auto`؛ `memory.autoStore` صار `false` افتراضياً
  (المراجعة تكتب حقائق مُنتقاة بدل تفريغ Q→A).
- تنقيح يدوي: `POST /api/memory/curate` أو زر «تنقيح الذاكرة».

## 5) صفحة التعلّم في الواجهة
- `ui/learning.html` + `ui/learning.js` (+ رابط في الشريط الجانبي «التعلّم»).

## التحقق
- `npm run typecheck` ✓ · `npm run check:selfimprove` → PASS (يشمل مسار الموافقة) ·
  `npx tsx src/scripts/check-tools.ts` → PASS · `npm run verify` → ترميز سليم.

---

# ✅ تحديثات P5 — التقييم الذاتي (نمط OSWorld/WebArena/GAIA)

## 1) Harness تقييم قابل للتشغيل
- Suites بصيغة JSON في `evals/` (أو `MANUS_LOCAL_EVALS_DIR`). كل حالة = prompt + verifiers برمجية (ground truth)
  + `setup` اختياري لكتابة fixtures + `budget` للخطوات/المهلة. مجموعات جاهزة: `evals/core.json` (6 حالات)،
  `evals/hard.json` (متعددة الخطوات)، `evals/web.json` (شبكية — تُتخطى offline وتُوسم `network`).
- verifiers مدعومة: `file_exists` · `file_absent` · `file_contains` · `file_matches` (regex) ·
  `shell_exit` · `shell_contains` · `http_ok` · `tool_used` · `answer_matches` · `llm_judge`.
- كل حالة تعمل في sandbox معزول `workspace/eval-runs/<runId>/<caseId>/` بنفس أدوات الوكيل وسياساته.
- التشغيل: `npm run eval -- --suite core [--case <id>] [--offline] [--json] [--no-critique]`.

## 2) مراقبة (Telemetry) تقود التصدير
- `data/telemetry/runs.jsonl`: سجل لكل مهمة عادية وحالة تقييم (تغطية tokens/زمن/أدوات/نتيجة).
- قياس التوكنات من Ollama (`prompt_eval_count`/`eval_count`) لكل نداء، وزمن كل أداة في الأحداث.
- `GET /api/telemetry/summary`: إجماليات + أكثر الأدوات فشلاً + اتجاه passRate.

## 3) نقد ذاتي (Self-critique) وتوليد ذاتي (Self-play)
- بعد كل حالة يكتب الناقد JSON صارماً: `{passed, score, failure_causes, better_plan, lessons}`
  → `data/telemetry/critiques.jsonl` و`data/telemetry/transcripts/`.
- `npm run eval:selfplay [--run <id>] [--max N]`: يولّد حالات جديدة من الفشل إلى مسودات
  `data/evals/drafts/` — تُعتمد يدوياً (صفحة التعلّم أو نسخها إلى `evals/`).

## 4) تصدير بيانات fine-tuning
- `npm run ft:export`: `data/datasets/<ts>/` = `sft.jsonl` (مسارات ناجحة كاملة) +
  `pref.jsonl` (chosen/rejected لنفس الحالة مع أسباب الفشل) + `manifest.json` + `README.md`.
- جاهزة لأي مدرب خارجي (Unsloth/Axolotl/LLaMA-Factory). التدريب نفسه خارج التطبيق.

## 5) استمرارية وكشف الانحدار
- `evaluation.enabled=true` + `intervalMinutes` → تشغيل دوري عبر الـ scheduler الموجود
  (انخفاض passRate ≥ 20 نقطة يُسجَّل تحذيراً في `data/learning.log`).
- واجهة: قسم «التقييم الذاتي» في `learning.html` (تشغيل/نتائج/self-play/تصدير).

## 6) الإعدادات الجديدة (`config.json`)
```json
"evaluation": { "enabled": false, "intervalMinutes": 360, "suite": "core",
                "critique": true, "keepRuns": 30, "transcripts": true },
"selfPlay": { "maxCases": 5 }
```

## التحقق
- `npm run typecheck` ✓ · `npm run check:eval` → 18/18 PASS (بدون Ollama) ·
  `npm run verify` ✓ · تشغيل حقيقي: core 6/6 وsuite مولّدة ذاتياً 2/2 مع `glm-5.3-flash:cloud`.

---

# ✅ تحديثات P6 — حلقة تخطيط/تنفيذ/تأمل (Planner/Executor/Verifier, Actor-Critic)

## 1) البنية الجديدة (بدل التسلسل الخطي)
- **`src/agent/orchestrator.ts`**: المنسّق — نفس توقيع `runAgent` (قابل للحقن في أي واجهة
  تقبل `RunOptions`، بما فيها `eval.runAgentFn`). يطبّق الحلقة الكاملة:
  `plan → act → observe → critique → revise` مع إعادة تخطيط محدودة وتحقق نهائي.
- **`src/agent/planner.ts`**: دور المخطِّط — نداء واحد يعيد خطة JSON
  `{goal, trivial, steps:[{id,title,instruction,success_criteria}]}` مع استخراج JSON متدرّج
  (خام ← سياج ```json ← أقواس متوازنة) وخطة احتياطية أحادية الخطوة عند أي فشل.
- **`src/agent/verifier.ts`**: دور الناقد/المقيّم — يحكم بالأدلة (ملفات/مخرجات أدوات) لا بثقة
  المنفّذ، ويعيد `{verdict: pass|revise|fail, reason, fixes}`. مخرجات غير قابلة للتحليل
  **تفشل مفتوحة** (pass) كي لا يعطّل خللُ تحليلٍ مسارَ المهمة.
- **`src/agent/model.ts`**: سلسلة النماذج الموحّدة (المفضل ← الرئيسي ← الاحتياطي) مع تجميع التوكنات.
- **المهام البسيطة** (`trivial=true` من المخطِّط): تنفيذ مباشر بخطوة واحدة بلا نقد/تحقق نهائي.
- كل الأحداث تُبَثّ عبر SSE وتُحفظ: `plan` · `plan_step` · `critique` · `revise` · `replan` ·
  `verify`، والواجهة تعرض بطاقة خطة + أسطر الناقد/المراجعة/التحقق.

## 2) التعلّم من النقد (Actor-Critic memory)
- كل حكم غير `pass` يُغذّى إلى: تتبّع المهمة (يصل إلى مراجعة التعلّم الخلفية `reflect.ts`)
  ويُسجَّل في `data/learning.log` بصيغة `orchestrator/<scope>: <verdict> — <reason>`.

## 3) الإعدادات الجديدة (`config.json`)
```json
"orchestrator": { "enabled": true, "plannerModel": "", "verifierModel": "",
                  "maxPlanSteps": 8, "maxStepsPerWorker": 24,
                  "maxRevisionsPerStep": 1, "maxReplans": 1, "verifyFinal": true }
```

## التحقق
- `npm run check:orchestrator` → 49/49 PASS (بدون Ollama): تحليل الخطة/الأحكام، حلقة المراجعة،
  إعادة التخطيط، الفشل المفتوح، فشل الـworker، الأحداث، والتوكنات المجمّعة.
- تشغيل حقيقي مع `glm-5.3-flash:cloud`: خطة خطوتين ← كتابة/قراءة ملف فعلياً ← نقد `pass` بالأدلة
  ← تحقق نهائي `pass` (17.9 ثانية، 9 خطوات، والملف محقَّق على القرص).
- `npm run verify` ✓ (يتضمن check:orchestrator ضمن السلسلة).





