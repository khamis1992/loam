# كيف يعمل Claude Code — تحليل معماري وخريطة تمكين Manus

> **النطاق:** فهم معمارية Claude Code (المرجع: `github.com/anthropics/claude-code`)، ثم مقارنتها بنظام إضافات Manus المُحلَّل محلياً (Manus Studio 2.0.7)، ثم تحديد ما بُني فعلياً لجعل Manus قادراً على البرمجة وإضافة المهارات.
>
> **جهات الأدلة:**
> - `[CC-DOCS]` = وثائق Claude Code الرسمية (`code.claude.com/docs`) التي جُلبت في هذه الجلسة (صفحتا Skills و Sub-agents كاملتان).
> - `[MANUS]` = تحليلنا العكسي لـ `app.asar` وملفات `resources/` (انظر `analysis/MANUS_SYSTEM_ANALYSIS.md`)، وأدلة خام جُلبت في هذه الجلسة من الإضافات المُدارة (`manus-tasks`، `manus-storage`، `manus-triggers`).
> - `[CODE]` = ما بُني في هذه الجلسة ونُقل إلى التطبيق المحلي **manus-local** (`Desktop\manus-local`).

---

## 0. الملخّص التنفيذي

Claude Code ليس "نموذجاً" بل **نظام قواعد (harness)** حول النموذج: حلقة وكيلية واحدة، مجموعة أدوات محدّدة، نظام مهارات بملفات `SKILL.md`، وكلاء فرعيون بسياق مستقل، خطّافات دورة حياة، ودعم MCP — مع طبقة أذونات صارمة.

النقطة الجوهرية: **Manus يملك بالفعل أساساً مطابقاً**. نظام "الإضافات" في Manus هو في جوهره: خوادم MCP + مهارات `SKILL.md` بصيغة مطابقة تماماً. الفرق أن Manus يوزّع الإضافات عبر قناة مُدارة، وأدواته المضمّنة موجّهة للمهام/التخزين/المتصفح — **لا توجد إضافة برمجة**. لذلك التمكين الصحيح ليس "تقليد Claude Code من الصفر"، بل **إضافة Manus جديدة تُدخل قدرات البرمجة ونظام المهارات**، وهذا ما بُني وتحقّق منه.

---

## 1. نظرة عامة على Claude Code

`[CC-DOCS]` المستودع العام لـ Claude Code يحتوي **الوثائق والإضافات فقط**؛ التطبيق نفسه مغلق المصدر ويوزَّع ثنائياً (install.sh / winget / npm). أي "فهم كيف يعمل" يأتي من الوثائق الرسمية وسلوك النظام، لا من قراءة كوده.

المكوّنات الأساسية:

| المكوّن | الوظيفة |
|---|---|
| حلقة وكيلية | النموذج يستدعي أدوات، يقرأ النتائج، يكرّر حتى الانتهاء |
| أدوات مدمجة | Read / Write / Edit / Glob / Grep / Bash … |
| Skills | ملفات `SKILL.md` تُحمَّل عند الحاجة |
| Subagents | وكلاء بسياق مستقل وأدوات مقيّدة |
| Hooks | تنفيذ أوامر عند أحداث دورة الحياة |
| MCP | خوادم أدوات خارجية (stdio/http/sse/ws) |
| Memory | `CLAUDE.md` متعدّد المستويات |
| Plugins | حزم تجمع Skills/Agents/Hooks/MCP |
| Permissions | سماح/رفض/سؤال + أنماط صلاحيات |

---

## 2. الحلقة الوكيلية

النموذج في Claude Code **لا يكتب كوداً مباشرة**؛ بل يُصدر استدعاءات أدوات (tool calls) ضمن نمط واحد:

```
مستخدم → [system prompt + CLAUDE.md + وصف الأدوات]
        → النموذج يخطّط
        → استدعاء أداة (Read/Edit/Bash/...)
        → طبقة الأذونات تسمح/ترفض/تسأل
        → تنفيذ الأدوات في السياق المحلي
        → إرجاع النتيجة إلى السياق
        → تكرار حتى الإجابة النهائية
```

ملاحظات معمارية مهمّة:
- **الأدوات هي واجهة القدرة**: كل ما يستطيع النظام فعله معرَّف كأداة بمخطّط JSON. لا قدرة خارج هذا السطح.
- **الأذونات طبقة منفصلة**: تُقيَّم قبل التنفيذ، مستقلة عن رغبة النموذج.
- **السياق مورد نادر**: لذلك وُجدت المهارات (تحميل عند الحاجة)، الوكلاء الفرعيون (عزل السياق)، والتقليم التلقائي.

---

## 3. الأدوات المدمجة (سطح القدرة)

`[CC-DOCS]` من مرجع الأدوات والصفحات المجلوبة تظهر هذه العائلات:

- **ملفات:** `Read`, `Write`, `Edit`, `NotebookEdit`
- **بحث:** `Glob`, `Grep` (+ `LSP` للرموز والأنواع)
- **تنفيذ:** `Bash`, `PowerShell`, `Monitor`, `TaskStop`
- **ويب:** `WebFetch`, `WebSearch`
- **تفويض/تنسيق:** `Agent` (كان اسمه `Task`) لتفويض وكلاء فرعيين، `TodoWrite`
- **إضافات:** `Skill` لتحميل مهارة، `ToolSearch` لاكتشاف أدوات إضافية، `Workflow` لمهام ديناميكية
- **تفاعل/إنهاء:** `AskUserQuestion`, `EndConversation`, `EnterPlanMode`/`ExitPlanMode`, `ScheduleWakeup`
- **عزل:** `EnterWorktree`/`ExitWorktree`

أسماء أدوات MCP منسوبة بالبادئة `mcp__<server>__<tool>`.

---

## 4. الوكلاء الفرعيون (Subagents)

`[CC-DOCS]` الوكيل الفرعي = **ملف Markdown بترويسة YAML**، يمنحه الوالد مهمة فيشتغل بـ**نافذة سياق مستقلة** ويُرجع الخلاصة فقط:

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep      # قائمة سماح
disallowedTools: Write, Edit # أو قائمة منع
model: sonnet
permissionMode: default
---

أنت مراجع كود. حلّل وقدّم ملاحظات دقيقة.
```

- **منافذ** (بالأولوية): إعدادات المؤسسة > `--agents` CLI > `.claude/agents/` (المشروع) > `~/.claude/agents/` (المستخدم) > `agents/` داخل إضافة (Plugin).
- **حقول مهمّة:** `tools`/`disallowedTools`، `model`، `permissionMode`، `maxTurns`، `skills` (تحميل مهارات مسبقاً)، `mcpServers`، `hooks`، `memory`، `isolation: worktree`، `omitClaudeMd`.
- **وكلاء مدمجون:** `Explore` (قراءة فقط)، `Plan` (بحث للتخطيط)، `general-purpose`، وغيرهم.
- **حدّ العمق:** الوكلاء الفرعيون لا يتفرّعون بلا نهاية (الأداة `Agent` تُزال عند حدّ العمق).

الفائدة المعمارية: **ميزانية سياق فعّالة** — البحث الضجيجي يبقى خارج المحادثة الرئيسية.

---

## 5. المهارات (Skills) — جوهر التشابه مع Manus

`[CC-DOCS]` المهارة تتبع **معيار Agent Skills المفتوح** (`agentskills.io`)، وتضيف Claude Code عليها ميزات.

### 5.1 الشكل

مجلد يحوي `SKILL.md`: ترويسة YAML ثم Markdown. الجسم يُحمَّل **فقط عند الاستخدام**؛ لذلك المراجع الطويلة شبه مجّانية حتى تُطلب.

### 5.2 الترويسة (Frontmatter)

| الحقل | المعنى |
|---|---|
| `name` | اسم الأمر؛ افتراضياً اسم المجلد |
| `description` | **متى** تُستخدم — يُستخدم للاستدعاء التلقائي؛ يُقتطع العرض عند 1,536 حرفاً |
| `when_to_use` | عبارات/أمثلة إضافية للاستدعاء |
| `allowed-tools` / `disallowed-tools` | صلاحيات مؤقّتة أثناء تفعيل المهارة |
| `disable-model-invocation` | منع الاستدعاء التلقائي (تشغيل يدوي فقط) |
| `user-invocable` | إظهار/إخفاء في قائمة `/` |
| `model` / `effort` | تجاوز النموذج/مستوى الجهد |
| `context: fork` + `agent` + `background` | تشغيل المهارة في وكيل فرعي |
| `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility` | إضافات |

> خارج Claude Code (claude.ai / Skills API) يُسمح فقط بـ: `name, description, license, compatibility, metadata, allowed-tools` — وإلا يفشل التحزيم بخطأ صريح.

### 5.3 المواقع

المؤسسة (managed settings) → المستخدم `~/.claude/skills` → المشروع `.claude/skills` → المتداخلة (subdir) → `--add-dir` → الإضافة (`plugin-name:skill-name`) → المتزامنة من claude.ai. الأوامر القديمة في `.claude/commands/*.md` ما زالت تعمل وتم دمجها في المهارات.

### 5.4 الكشف التدريجي (Progressive disclosure)

1. الفهرس يعرض `name` + `description` فقط (سقف ~1536 حرفاً).
2. عند التفعيل يُحمَّل الجسم الكامل.
3. ملفات `references/` تُحمَّل عند الطلب.

هذا **بالضبط** ما يوفّره نظام مهارات `manus-local`: `skill_list` يعرض الاسم والوصف فقط، و`skill_view` يقرأ الجسم الكامل عند الطلب.

---

## 6. الخطّافات (Hooks)

`[CC-DOCS]` نقطة تمديد لتنفيذ أوامر عند أحداث دورة الحياة (قبل/بعد استدعاء أداة، عند بدء/انتهاء وكيل، إلخ)، وتُعرَّف في الإعدادات أو في ترويسة مهارة/وكيل. تُستخدم للفرض (منع أوامر خطرة)، التنسيق الآلي، والتسجيل.

---

## 7. MCP (بروتوكول السياق)

`[CC-DOCS]` خوادم أدوات خارجية بأنواع `stdio/http/sse/ws`، تُعرَّف في `.mcp.json` أو إعدادات المستخدم، وأدواتها تظهر باسم `mcp__<server>__<tool>`. يمكن حصر خادم داخل وكيل فرعي فقط (`mcpServers` في ترويسة الوكيل) لتوفير السياق.

**الملاحظة المحورية:** في Manus، الإضافة **كلها** هي خادم MCP. أي أن Manus بنى نظام تمديده فوق نفس البروتوكول.

---

## 8. الذاكرة والإعدادات والإضافات

- **CLAUDE.md**: سلّم مستويات — managed > user `~/.claude/CLAUDE.md` > project `./CLAUDE.md` > local `./CLAUDE.local.md`، مع قواعد مرتّبة بالمسارات (path-specific).
- **الإعدادات**: `settings.json` (+ managed/local)، مع `permissions.allow/deny/ask` وأنماط صلاحيات (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`).
- **Plugins**: حزمة تحوي Skills + Agents + Hooks + MCP + أوامر، تُوزَّع عبر marketplace.

---

## 9. كيف يعمل نظام إضافات Manus فعلياً

`[MANUS]` أدلة خام جُلبت في هذه الجلسة (فكّ ضغط ثلاث إضافات مُدارة).

### 9.1 شكل الإضافة المُدارة/المُحدَّثة (`updateMode: "hot"`)

```json
{
  "schemaVersion": 1,
  "addonId": "manus-tasks",
  "version": "0.0.15",
  "target": "windows-amd64",
  "updateMode": "hot",
  "mcpServers": [
    {
      "name": "manus-tasks",
      "description": "… Read the … skill first.",
      "modelVisibleTools": ["get_access", "create_task", "…"],
      "hostCallableTools": [],
      "subjectTokenTools": [],
      "transport": {
        "type": "stdio",
        "runtime": "manus-js/v1",
        "entrypoint": "runtime/server.mjs",
        "args": []
      }
    }
  ],
  "skills": [{ "name": "manus-tasks", "path": "skills/manus-tasks/SKILL.md" }]
}
```

- **`runtime: manus-js/v1`** = يُشغَّل `entrypoint` على Node (نستنتج ذلك من `import readline from "node:readline"` في `manus-tasks/runtime/server.mjs`).
- **أسماء الأدوات للوكيل** = `"<server>.<tool>"` (مثل `triggers.create_trigger`, `handoff.receive`).
- **المهارات** تُعلَن في `skills[]` كـ `SKILL.md` — **نفس صيغة Claude Code بالضبط** (ترويسة `name`+`description` ثم Markdown؛ رأيناها في `manus-tasks`، `manus-storage`، `manus-triggers`).
- **`addon-meta.json`** يضيف `host_permissions` و`resources` (قوالب URI من نوع `manus-resource://`).

### 9.2 الشكل المحلي (native helper)

```json
{ "schemaVersion":1, "addonId":"manus-computer-use", "version":"1.0.25",
  "platforms": { "win32-x64": { "helper":"helper/win32-x64/ManusComputerUseHelper.exe",
    "mcp": { "server":"computer-use", "transport":"stdio", "args":["--stdio"] } } } }
```

`[MANUS]` `addonHost.js` يتحقّق: كل منصة لها `helper` **أو** `sharedHelperAddonId` (لا كليهما)، ويتحقّق من توقيع helper على Windows (PE32+ + بصمة sha256) وعلى macOS (codesign + Team ID). لذلك **الإضافة المحلية تتطلّب helper أصلياً موقّعاً**، بينما الإضافة المُدارة (JS) لا.

### 9.3 التشغيل

`[MANUS]` المشغّل (`manus-computer-operator`) يقرأ `mcp_servers.json` ويستدعي أدوات الإضافات، والمضيف يعرض وصف الخادم للموديل. المهارات يوزّعها المضيف من `skills[]`.

**الخلاصة:** Manus = نظام MCP + Skills. القدرة المفقودة الوحيدة هي **مجموعة أدوات البرمجة**.

---

## 10. خريطة المفاهيم: Claude Code ↔ Manus

| مفهوم Claude Code `[CC-DOCS]` | المكافئ في Manus `[MANUS]` | ملاحظة |
|---|---|---|
| MCP server | إضافة (addon) = خادم MCP | تطابق تام في البروتوكول |
| أداة `Read`/`Write`/`Bash`… | أدوات إضافات (`triggers.*`, …) | Manus يفتقد عائلة البرمجة |
| Skill (`SKILL.md`) | مهارة إضافة (`skills[]`) | **نفس الصيغة** |
| Subagent (ملف `agents/`) | `create_task` / workflow / subagents | Manus يُنشئ مهام مستقلة لا وكيلاً داخل الجلسة بنفس الدلالة |
| Plugin (Skills+Agents+Hooks+MCP) | إضافة مُدارة (MCP+Skills) | Manus لا يجمع hooks/agents في حزمة واحدة |
| Hooks | — | لا مكافئ مؤكّد في Manus |
| Memory `CLAUDE.md` | تعليمات المشروع/الجلسة + مهارات | مكافئ قريب |
| Permissions (allow/deny/ask) | `host_permissions` + سياسة المضيف | Manus أخشن |
| `mcp__srv__tool` | `<server>.<tool>` | فرق في التسمية فقط |
| Slash commands | — | لا مكافئ مؤكّد |

---

## 11. الفجوة وما بُني لسدّها (`manus-local`) `[CODE]`

**تصحيح المسار:** الهدف النهائي للتطوير هو **تطبيقك المحلي `manus-local`** (Electron + خادم وكيل محلي + MCP + مهارات)، لا تطبيق Manus المغلق. لذلك لم تُشحن إضافة بصيغة Manus؛ بل نُقلت الخدمة إلى مشروعك مباشرة.

بُني/عُدِّل داخل `manus-local`:

| ملف | الدور | المكافئ في Claude Code |
|---|---|---|
| `src/tools/skillsRegistry.ts` | كتالوج aitmpl.com: تعداد بطلب API واحد + تخزين 6 ساعات + تنزيل مهارة | Plugin marketplace |
| `src/tools/skills.ts` | أدوات الوكيل: `skill_list`, `skill_view`, `skill_create`, `skill_patch`, `skill_delete` + **`skill_search`, `skill_install`** | أداة Skill |
| `src/server/http.ts` | نقاط النهاية `/api/skills*` (قائمة/كتالوج/قراءة/إنشاء/تعديل/حذف/تثبيت) | — |
| `src/server/pending.ts` | بوابة موافقة الكتابة تشمل `skill_install` | Permissions |
| `ui/skills.html` + `ui/skills.js` | واجهة إدارة المهارات (بحث/تثبيت/إنشاء/تعديل/إزالة) | واجهة الـ marketplace |
| `ui/index.html` + `electron/main.cjs` | رابط «المهارات» + عنصر القائمة/الصينية | — |

**ما يغطّيه:** أدوات البرمجة موجودة أصلاً في مشروعك (`src/tools/files.ts`, `shell.ts`)؛ وما أُضيف هو طبقة **المهارات + كتالوج aitmpl + واجهتها**، مع **كشف تدريجي** مطابق لدلالة `Skill` + `SKILL.md`.

**ما لا يغطّيه (بحدود صريحة):**
- الوكلاء الفرعيون (Subagents) وHooks: لا مكافئ في بنية `manus-local` الحالية (توسيع مستقبلي).
- لم تكن هناك حاجة لتعديل تطبيق Manus المغلق إطلاقاً.

> الإضافة القديمة بصيغة Manus (`manus.im/manus-code`) كانت مبنية على فرضية خاطئة (أن «نظامنا» = تطبيق Manus) وقد **حُذفت**.

---

## 12. كيف تضيف مهارة (عملياً)

**من الواجهة (الأسهل):** شغّل التطبيق (`start-desktop.bat` أو `npm run desktop`) → **المهارات** في الشريط الجانبي، أو من الصينية/قائمة «ملف» (Ctrl+5). ثم:
- **إنشاء:** املأ الاسم/الوصف/النص واضغط «حفظ».
- **تعديل:** زر «تعديل» بجانب أي مهارة مثبّتة (تُقرأ الحقول ثم تُحفظ في مكانها).
- **تثبيت من الكتالوج:** ابحث (مثل `pdf`, `react`) واضغط «تثبيت».
- **إزالة:** زر «إزالة».

**يدوياً:** ضع `skills/<name>/SKILL.md` بترويسة `name` و`description`.

**من الوكيل:** `skill_list` ثم `skill_view`/`skill_create`/`skill_patch`، أو `skill_search` ثم `skill_install`.

### 12.1 من كتالوج aitmpl.com — عبر واجهة أو وكيل

`[CODE]` تكامل مع كتالوج **aitmpl.com / `davila7/claude-code-templates`** (915 مهارة وقت التحقق) تحت `cli-tool/components/skills/<category>/<name>/SKILL.md`.

**الكفاءة (قرار هندسي):** تعداد الكتالوج كامل يتم **بطلب API واحد** (`git trees … recursive=1`) لا بـ 915 طلباً، ويُخزَّن 6 ساعات في `data/skills-catalog.json`؛ والأوصاف تُجلب من `raw.githubusercontent` (لا تُحتسب على حد GitHub API). عيّن `GITHUB_TOKEN` لرفع الحد.

**مساران للإضافة:**
- **واجهة:** صفحة `/skills.html` داخل التطبيق → بحث/تثبيت/إزالة.
- **وكيل:** `skill_search` ثم `skill_install` — تمرّ عبر بوابة الموافقة إن كان `selfImprove.writeApproval` مفعّلاً.

**التوافق:** CLI الخارجي (`npx claude-code-templates@latest --skill <cat>/<name> --yes`) يثبّت في `.claude/skills`؛ ولأن `manus-local` يقرأ `skills/` في المشروع، انسخ المجلد هناك ليظهر في `skill_list`.

**الأمن:** الخادم محلي على `127.0.0.1`، والتثبيت **كتابة ملفات فقط** داخل `skills/` دون أي تنفيذ، مع رفض المسارات الخارجة في المعرّفات.

**التحقق:** اختبار تشغيلي فعلي على الخادم المبني → **10/10** (تشغيل، قائمة، خدمة `/skills.html`، إنشاء، قراءة، تعديل في المكان، بحث الكتالوج، تثبيت `document-processing/pdf-fill-studio`، ظهورها في القائمة، ثم حذف).

---

## 13. حدود ومجهولات

- `[CC-DOCS]` Claude Code مغلق المصدر؛ التحليل من وثائق رسمية وسلوك، لا من كود.
- `[MANUS]` تحليل نظام إضافات Manus بقي **مرجعاً معمارياً** لكيفية بناء MCP + SKILL.md، لا هدفاً للتطوير.
- `[CODE]` التحقق من الأنواع (`npm run typecheck`) نظيف + اختبار تشغيلي 10/10 داخل `manus-local`.
- الوكلاء الفرعيون (Subagents) وHooks: مفاهيم غير منفّذة في `manus-local` بعد (توسيع مستقبلي).
- مهارات الطرف الثالث من الكتالوج تعليمات غير موثوقة: راجع `SKILL.md` قبل الاعتماد عليه.

## 14. المصادر

- `[CC-DOCS]` `code.claude.com/docs/en/skills`, `/docs/en/sub-agents` (مجلوبة كاملة في هذه الجلسة)، ومستودع `github.com/anthropics/claude-code`.
- **كتالوج aitmpl.com:** `github.com/davila7/claude-code-templates` (المهارات تحت `cli-tool/components/skills`) + `docs.aitmpl.com`. الوصول للكتالوج مُتحقَّق منه من الجهاز (200 OK، 915 مهارة).
- `[MANUS]` `analysis/MANUS_SYSTEM_ANALYSIS.md`, `analysis/agents/*`، وأدلة خام من `resources/managed-addons/{manus-tasks,manus-storage,manus-triggers}` و`resources/addons/{manus-computer-use,skill-recorder}`.
- `[CODE]` `Desktop\manus-local` — الملفات: `src/tools/skillsRegistry.ts`, `src/tools/skills.ts`, `src/server/http.ts`, `src/server/pending.ts`, `ui/skills.html`, `ui/skills.js`. مُتحقَّق منها بـ `npm run typecheck` + اختبار تشغيلي 10/10.
