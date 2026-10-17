# تصميم: manus-code agent runtime

التاريخ: 2026-10-15
الحالة: معتمد من المستخدم، بانتظار مراجعة المواصفة المكتوبة.

## 1. الخلفية والهدف

`manus-code` اليوم إضافة Manus على شكل خادم MCP عبر stdio (`runtime/server.mjs`، 1826 سطراً، 19 أداة برمجة + نظام مهارات + مجلس داخلي). ينقصه **قلب نظام الوكلاء**: حلقة وكيل، طبقة نماذج، جلسات، واستضافة MCP.

الهدف: توسيع `manus-code` إلى **runtime وكلاء كامل** يعمل محلياً بلا اعتماديات خارجية (Node builtins فقط)، مع CLI وخادم محلي متوافق مع OpenAI، بحيث تُستهلك الأدوات الحالية كخادم MCP فرعي دون أي تعديل على `runtime/server.mjs`.

### قرارات المستخدم
1. **الشكل:** CLI + خادم HTTP محلي، مشروع متعدد الملفات.
2. **المزوّد:** متعدد المزوّدين بواجهة OpenAI-compatible (`baseUrl` + `apiKey` + `model`).
3. **الأدوات:** عميل MCP يشغّل `runtime/server.mjs` كخادم فرعي (ويقبل خوادم MCP خارجية إضافية).
4. **الموافقات:** أتمتة كاملة (YOLO). لا طبقة موافقات. يبقى مفتاح الإيقاف الموجود `MANUS_CODE_SHELL=off` فعالاً.

## 2. المقاربة المختارة

**حلقة وكيل كعميل MCP.** الـruntime يشغّل خادم/خوادم MCP عبر stdio، يقرأ `tools/list`، يحوّلها إلى مخططات دوال OpenAI، ثم يدير دورة: نداء النموذج ← تنفيذ `tool_calls` ← إلحاق النتائج ← تكرار.

البدائل المرفوضة:
- استخراج الأدوات إلى وحدة مشتركة: يكسر مبدأ «الملف الواحد» للإضافة ويستلزم إعادة هيكلة مخاطرة.
- منصّة كاملة (قاعدة بيانات/تنسيق وكلاء/واجهة): هندسة زائدة خارج النطاق الحالي.

المبرر: نفس معمارية التطبيقات المرجعية (مضيف MCP)، أقل كود جديد، وقابلية إضافة أي خادم MCP خارجي مجاناً.

## 3. البنية

```
manus-code/
├── runtime/
│   ├── server.mjs            # خادم MCP الحالي — بدون تغيير
│   └── agent/                # جديد
│       ├── cli.mjs           # مدخل CLI (REPL + one-shot)
│       ├── http.mjs          # مدخل خادم HTTP/SSE
│       ├── config.mjs        # الإعدادات (مزوّدون + خوادم MCP)
│       ├── providers.mjs     # طبقة OpenAI-compatible (بث + tool_calls)
│       ├── mcp.mjs           # عميل MCP عبر stdio (JSON-RPC 2.0)
│       ├── tools.mjs         # دمج الخوادم → مخططات دوال + توزيع
│       ├── loop.mjs          # حلقة الوكيل
│       └── sessions.mjs      # استمرار الجلسات (JSONL)
└── tools/
    └── agent.test.mjs        # اختبارات بلا شبكة
```

## 4. الوحدات وعقودها

### 4.1 `config.mjs`
- `loadConfig()` → يحلّ الإعدادات من متغيّرات البيئة ثم `~/.manus-code/agent.json` (الملف يتقدّم).
- الشكل:
  ```json
  {
    "defaultProvider": "openrouter",
    "providers": {
      "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "", "model": "" }
    },
    "mcpServers": [
      { "name": "code", "command": "node", "args": ["runtime/server.mjs"], "cwd": "<addon-root>", "env": {} }
    ],
    "limits": { "maxIterations": 40, "toolTimeoutMs": 60000, "maxOutputChars": 200000 }
  }
  ```
- متغيّرات البيئة المدعومة: `MANUS_AGENT_PROVIDER`, `MANUS_AGENT_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MANUS_AGENT_MAX_ITERATIONS`, `MANUS_AGENT_WORKSPACE`.
- إن لم يُحدَّد `mcpServers`، يُضاف خادم `code` الافتراضي تلقائياً مع `cwd` = جذر الإضافة (يُحسب من موقع `config.mjs`، أي المجلد الأب لـ`runtime/`). مساحة عمل الأدوات تُمرَّر عبر متغيّر البيئة `MANUS_CODE_WORKSPACE`.

### 4.2 `providers.mjs`
- `chat({ baseUrl, apiKey, model, messages, tools, stream, signal, timeoutMs })`.
- غير بثّي: يرجع `{ role: "assistant", content, tool_calls }`.
- بثّي: يقرأ SSE (`data:` أسطر) ويجمع `content` وتدريج `tool_calls` (name/arguments عبر الفهرس).
- تحويل `messages` بصيغة OpenAI كما هي (لا طبقة تحويل إضافية).
- الأخطاء: `ProviderError` بأصناف `http` / `network` / `parse` + `status`.
- إعادة محاولة واحدة عند 429/5xx مع تأخير تصاعدي (احترام `Retry-After`).

### 4.3 `mcp.mjs`
- `class McpClient`:
  - `start()` — يشغّل العملية ويهيّئ (`initialize` + `notifications/initialized`).
  - `listTools()` — يرجع `{ name, description, inputSchema }`.
  - `callTool(name, args, { signal })` — يرجع `{ text, structured, isError }`.
  - `stop()` — إغلاق نظيف.
- JSON-RPC 2.0 بأسطر JSON على stdio؛ موازنة النداءات بمعرّف؛ مهلة لكل نداء.
- عند سقوط العملية: إعادة تشغيل مرة واحدة وترميز الأدوات غير المتاحة، ثم الاستمرار.

### 4.4 `tools.mjs`
- `openToolRegistry(config, { onLog })` → `{ tools, call, close }`.
- `tools`: قائمة مسطّحة `{ wireName, name: "<server>.<tool>", description, inputSchema, schema, server, originalName }`.
- **قيد مهم:** أسماء دوال OpenAI تقبل فقط `^[a-zA-Z0-9_-]{1,64}$` — النقطة غير مسموحة. لذلك:
  - `wireName` (المُرسل للنموذج) = تعقيم الاسم المنطّق: استبدال كل ما ليس `[a-zA-Z0-9_-]` بـ`_`، أي `code.bash` → `code__bash`.
  - إن تجاوز الناتج 64 محرفاً: يُقصّ ويُلحق `_` + أول 8 محارف من SHA-256 للاسم الأصلي.
  - يُحفظ جدول `wireName → { server, originalName }`؛ النموذج يرى `wireName` فقط والـruntime يعيد ترجمته عند التنفيذ.
- `call(name, args)`: يقبل إما `wireName` أو الاسم المنطّق، ويوزّع على الخادم الصحيح؛ أخطاء الأداة تُعاد كـ`{ isError: true, text }` ولا تُسقط الجلسة.
- الاسم المنطّق للعرض والسجلات هو `<server>.<tool>` (مثال: `code.bash`, `github.search`) لتفادي التعارض بين الخوادم.

### 4.5 `loop.mjs`
- `runTurn({ provider, registry, messages, limits, onEvent, signal })` → نص المساعد النهائي.
- الإجراء: نداء النموذج → إن وُجدت `tool_calls` ينفّذها (بالتتابع) ويلحق رسائل `tool` بالمعرّفات → يعيد النداء → يتوقف عند غياب الأدوات أو بلوغ `maxIterations`.
- الأحداث: `text_delta`, `tool_call`, `tool_result`, `usage`, `done`, `error`.
- التزامن: التنفيذ متتابع في هذه المرحلة (لا تنفيذ موازٍ للأدوات) لتبسيط سجلّ الجلسة وترتيبه.

### 4.6 `sessions.mjs`
- `newSession()`, `appendEvent(sessionId, event)`, `loadSession(id)`, `listSessions()`, `saveMessages(id, messages)`.
- التخزين: `~/.manus-code/sessions/<id>.jsonl` (سطر لكل حدث: `meta`, `user`, `assistant`, `tool_call`, `tool_result`).
- الاستئناف يعيد بناء مصفوفة `messages` من الأحداث.

### 4.7 `cli.mjs`
- `node runtime/agent/cli.mjs [--provider <p>] [--model <m>] [--workspace <dir>] [--session <id>] [--new] [-p|--print "<prompt>"]`.
- `--workspace` يُمرَّر إلى خادم `code` عبر `MANUS_CODE_WORKSPACE` في بيئة العملية الفرعية (لا عبر `cwd` الخاص بالخادم).
- REPL تفاعلي: يبثّ ردّ المساعد، ويطبع كل نداء أداة كـ`→ code.bash {"command":"..."}`، ونتيجته بسطر واحد.
- أوامر: `/help`, `/model [id]`, `/provider [name]`, `/tools`, `/sessions`, `/resume <id>`, `/workspace [dir]`, `/exit`.
- `--print` ينفّذ دوراً واحداً ويطبع النتيجة (لا تفاعل) — مناسب للسكربتات.

### 4.8 `http.mjs`
- `node runtime/agent/http.mjs [--port 4318] [--host 127.0.0.1]` — يرتبط بـloopback افتراضياً.
- المسارات:
  - `GET /health` → `{ ok, provider, model, tools, sessions }`.
  - `GET /v1/models` → قائمة المزوّدين المُهيّئين.
  - `POST /v1/chat/completions` → **متوافق مع OpenAI**؛ يدعم `stream: true` عبر SSE (`text/event-stream`).
  - `GET /v1/sessions`, `GET /v1/sessions/:id`.
- بلا مصادقة على loopback؛ إن حُدّد `--host` غير محلي يُشترط `MANUS_AGENT_TOKEN`.

## 5. تدفّق البيانات

```
المستخدم (CLI أو HTTP)
  → config.loadConfig()
  → tools.openToolRegistry()  ── spawn ──► خوادم MCP (code + خارجية)
  → loop.runTurn()
        ↺ providers.chat(messages, tools)
        ↺ registry.call("<server>.<tool>", args) عند وجود tool_calls
  → بثّ الأحداث للمستخدم
  → sessions.appendEvent(...) لكل دور
```

## 6. معالجة الأخطاء

| الحالة | السلوك |
|---|---|
| خطأ أداة (`isError`) | يُلحق كنص نتيجة للـtool؛ النموذج يقرر المتابعة. لا يُسقط الجلسة. |
| خطأ مزوّد HTTP 429/5xx | إعادة محاولة واحدة بتأخير تصاعدي (احترام `Retry-After`)، ثم `ProviderError` للسطح. |
| انقطاع شبكة | `ProviderError(network)` مع رسالة واضحة. |
| سقوط خادم MCP | إعادة تشغيل مرة واحدة؛ إن فشلت تُعلَّم أدواته غير متاحة وتستمر الجلسة. |
| تجاوز سقف التكرار | يتوقف ويُلحق ملاحظة `max iterations reached`. |
| استجابة نموذج مشوّهة | تُصنَّف `parse` وتُعاد مرة واحدة، ثم تُسجَّل وتُنهى الجولة. |

## 7. الاختبار

`tools/agent.test.mjs` — بلا شبكة ولا اعتماديات:
1. **خادم OpenAI مزيّف** على `127.0.0.1` (node:http) يردّ سيناريو مُبرمَجاً: أولاً `tool_call`، ثم جواباً نهائياً.
2. **خادم MCP حقيقي** = `runtime/server.mjs` في مساحة عمل مؤقتة.
3. الحالات:
   - `openToolRegistry` يُظهر 19 أداة باسم `code.*`.
   - `runTurn` ينفّذ دورة `code.write` ← `code.read` ويعيد الجواب النهائي.
   - خطأ أداة (`code.read` على ملف غير موجود) لا يُسقط الجلسة.
   - `sessions` يكتب ويستأنف ملف JSONL.
   - `http.mjs` يبثّ SSE في `POST /v1/chat/completions`.
   - تجاوز `maxIterations` يتوقف بأمان.
4. إبقاء `tools/smoke.mjs`, `tools/council.test.mjs`, `tools/verify-registry.mjs` خضراء كما هي.

## 8. الأمان

- لا طبقة موافقات (قرار المستخدم = YOLO). الضوابط المتبقية: كل مسارات الأدوات مقيّدة بجذر مساحة العمل عبر `resolveInside` في `server.mjs`، و`MANUS_CODE_SHELL=off` يعطّل `code.bash`.
- الخادم المحلي على loopback افتراضياً؛ أي ربط خارجي يتطلّب توكن.
- الأسرار في `~/.manus-code/agent.json` (يُنصح بصلاحيات ملف مقيّدة) أو متغيّرات بيئة؛ لا تُسجَّل في ملفات الجلسات.

## 9. خارج النطاق (YAGNI)

واجهة رسومية، تنسيق وكلاء متعدد، تنفيذ أدوات متوازٍ، RAG/قواعد بيانات، Voice/VNC، طبقة موافقات، تحديثات تلقائية.

## 10. معايير النجاح

1. `node runtime/agent/cli.mjs -p "اكتب ملف hello.js ثم اقرأه"` ينجز الدورة بأداة حقيقية وينهي بنجاح.
2. `node runtime/agent/http.mjs` ثم `POST /v1/chat/completions` بـ`stream:true` يبثّ SSE.
3. `npm test` يبقى أخضر بعد إضافة `agent.test.mjs`.
4. `runtime/server.mjs` لم يتغيّر (نفس تجزئة الملف) — عقد الإضافة محفوظ.
