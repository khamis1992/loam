---
name: browser-fast
description: استخدمها في أي مهمة متصفح متعددة الخطوات (بحث، حجز، تعبئة نماذج، تنقل).
---

# المتصفح السريع (مساحة أفعال مفهرسة)

المعمارية مستوحاة من browser-use/jev-ultrafast: **جدول عناصر مرقّم** + **عملية واحدة لكل خطوة**، بلا لقطات شاشة.

## الحلقة
1. `browser_open {url}` لفتح الصفحة (يعيد `pageId`).
2. `browser_table {pageId}` → جدول مرقّم: `[n] role "الاسم" · "القيمة"   ops:CLICK,TYPE_TEXT`
3. اختر **عملية + رقم** فقط، ونفّذ:
   `browser_act {pageId, op:"CLICK", index:7, snapshotId:<من الجدول>}`
   `browser_act {pageId, op:"TYPE_TEXT", index:3, text:"زيوريخ", snapshotId:...}`
   `browser_act {pageId, op:"SELECT", index:5, text:"Economy", snapshotId:...}`
   `browser_act {pageId, op:"SCROLL_DOWN"}` (بلا فهرس)
4. **أعد الملاحظة بعد كل فعل** (`browser_table`) — الفهرس يتغير بعد أي تغيير في الصفحة، والمراجع القديمة تُرفض (`stale`).
5. عند اكتمال الهدف: `op:"DONE"` ثم **تحقّق مستقلاً** (أعد `browser_table` أو `browser_eval`) قبل أن تعلن النجاح.
6. إذا مُنعت: `op:"BLOCKED"` واشرح السبب (تسجيل دخول، CAPTCHA، عنصر غير موجود).

## القواعد
- **لا تخمّن محددات CSS** ولا إحداثيات؛ استخدم الفهرس.
- لا تكرّر نفس الفعل بعد خطأ — أعد الملاحظة واختر استراتيجية مختلفة.
- `SELECT` للقوائم `<select>` الأصلية فقط؛ للقوائم المخصصة: `CLICK` على الحقل ثم `CLICK` على الخيار من الجدول الجديد.
- `TYPE_TEXT` يكتب في الحقل ويحدّث الأحداث، ثم ينتظر 150ms لتظهر قوائم الاقتراحات.
- إن رجع `stale observation` فمعناه أن الصفحة تغيّرت: نفّذ `browser_table` أولاً.
- لا تستخدم `browser_eval` إلا للتحقق أو للحالات الخاصة.
