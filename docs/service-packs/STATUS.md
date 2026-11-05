# Service Packs status

## P0 — واجهة التطبيق الجديدة: passed

- TypeScript للخادم والواجهة: passed.
- بناء الخادم والواجهة: passed.
- اختبارات الواجهة: 1004 passed.
- اختبارات Electron: 21 passed.
- البطاقات الثلاث `anime`, `budget`, `fashion`: الصور الأصلية 250×138 وظاهرة بشكل صحيح.
- فتح هدفي Slides وBuild: passed.
- العرض: PPTX اكتمل في 19.945s.
- الفيديو: MP4 اكتمل في 2.387s.
- `StartFromFileCard`: نُسخ الملف إلى المهمة ولم يتغير الأصل.

## P1 — نواة الحزم: passed

- اختبارات النواة و`finish`: 18 passed؛ اختبارات الواجهة: 1009 passed؛ Electron: 21 passed.
- TypeScript وبناء الخادم والواجهة: passed.
- `studioGoal` و`studioOptions` يصلان إلى `SavedRun`، و`packId` محفوظ للاستئناف.
- guard يمنع الكتابة المباشرة في `manifest.json` و`.loam/packs/*/project.json`، بما فيها shell.
- `finish` يمنع `done` مع عنصر pending، ولا ينشر إلا ملفًا حقيقيًا غير فارغ مع SHA-256.
- تحقق فعلي من Create → Slides على الواجهة الجديدة وخادم معزول: `packId=loam-slides`، واكتمل PPTX في 21.192s دون أخطاء.
- نتائج التحقق: `output/verification/p1-pack-intent.json` و`output/verification/p1-pack-intent.png`.

## P2 — العروض والملف المحلي: passed

- A1: خمس شرائح عربية عن متحف الفن الإسلامي، تتضمن I. M. Pei وعام 2008، وPPTX حقيقي وبوابة منع pending: passed.
- `deck_init/author/review/organize/export/attach/notes` مسجلة؛ `deck_present` أداة مضيف فقط.
- HTML يعيد `mode_not_supported`، وImage يعيد `provider_not_configured`؛ لا fallback مضلل.
- A3: نسخة الملف لا تغير الأصل؛ edit-in-place يحفظ backup، ويمنع baseline conflict، ويكتشف `user_edit`.
- الواجهة تعرض خياري «نسخة إلى المهمة» و«تعديل في المكان» حتى 100 ملف، والافتراضي نسخة آمنة.
- اختبارات الحزمة والمسار السريع و`finish`: 24 passed؛ الواجهة: 1011 passed؛ Electron: 21 passed.
- تحقق فعلي: `manifestFinal=true` والملف يفتح في Craft؛ المدة 21.220s. نسخة الملف الأصلية لم تتغير.

## P3 — الفيديو: passed

- A7: قص MP4 حقيقي مع نص عربي وتصديره عبر FFmpeg دون Python، مع hook/middle/end frames: passed.
- A8: t2v وSTT بلا مزود يعيدان `provider_not_configured` دون تغيير الأداة.
- الإلغاء يحفظ المشروع، و`expectedRevision` يمنع التعديل المتأخر.
- فيديو العرض اكتمل في 2.377s، وMP4 يفتح في مشغل خفيف بمصادقة محلية، مدة 8s و`readyState=4`، مع Poster وDownload.
- الاستوديو المتقدم لا يبدأ إلا بطلب المستخدم؛ `artifact_published` يسبق `done`.

## P4 — البناء: passed

- A4: موقع مطعم عربي، checkpoint بصمات حقيقية دون Git، ورفض ثم قبول النشر؛ لا نشر قبل الموافقة ولا أسرار في السجل.
- `deploy_app` خارج modelTools، و`site_publish_request` ينتظر قرار المستخدم.
- الموقع الثابت من الواجهة: `packId=loam-build`, `state=final`, 44 ملفًا في checkpoint، المدة 25.964s.
- المسار السريع للمواقع الثابتة يمنع HTML الناقص والأصول الخارجية والمحتوى النائب، ويفحص mobile/desktop.
- الجوال والألعاب معلنان `Soon` ولا يتحولان إلى Website. Websites يمر بالحزمة الجديدة.
- الواجهة: 1012 passed؛ Electron: 21 passed؛ typecheck والبناءان passed.
- المرفقات أصبحت الناتج والمعاينة فقط، دون ملفات القالب وأصول التحقق الداخلية.

## P5 — الصور والصوت والتوسع: passed

- `loam-image`: SVG محلي حقيقي، وPNG/JPEG/WebP فقط عبر مزود مهيأ؛ `image_present` مضيف فقط.
- `loam-audio`: TTS وموسيقى بملفات bytes حقيقية عبر مزود مهيأ، و`provider_not_configured` عند الغياب؛ لا Piper افتراضي.
- `loam-office`, `loam-research`, `loam-schedule`: تغليف الأدوات الحالية، و`finish` يربط إثباتها الحقيقي ببوابة التسليم.
- إزالة `artifact_publish` من modelTools للحزم لمنع الالتفاف على `present`؛ النشر يتم عبر البوابة قبل `done`.
- SVG من الواجهة: `packId=loam-image`, `state=final`, ملف 432B، المدة 23.925s، مع fallback محلي صريح عند نقص النموذج المخصص.
- Office/Research/Schedule يرفضون التسليم دون ملف proof حقيقي.
- اختبار عزل قناة اختيار العناصر في preview: passed؛ الرسائل الأخرى والـpayload غير الصالح مرفوضة.
- القبول النهائي: 1014 اختبار واجهة و21 Electron، typecheck وبناء الخادم والواجهة passed.

## إغلاق الفجوات والعقود المتقدمة: passed

- manifests تُحمّل فعليًا من `packs/*/pack.json` وتتضمن `skills`, `wraps`, `ownedTools`, `wrappedTools`, `legacyRoutes:"keep"` و`gate.timeoutMs`.
- النموذج لا يرى الأدوات القديمة المكررة؛ سجل المسارات السريعة المضيفة يحتفظ بها داخليًا دون كسرها.
- `pack validation → .loam/verify.json → artifact_published → done` موحد في `finish` والمسارات السريعة. فشل gate لا ينشر ولا ينهي.
- `withPackTimeout` يعيد `code:"timeout", retry:false` مرة واحدة دون loop.
- A1: خمس شرائح مع RTL وI. M. Pei و2008. A2: `missing:["3"]`. A3: PPTX مع backup وbaseline conflict. A10: timeout حقيقي.
- A13: `qwen36-uncensored-hauhau:latest` أكمل A1/A3/A5 بنسبة **18/18 = 100%** دون cloud fallback؛ الدليل `output/verification/hauhau-packs.json`.
- A14: 88 اختبارًا للحزم والبحث والجدولة و`finish` ناجحًا. الواجهة: **1025 passed**؛ Electron: 21 passed.
- القبول الحقيقي: عرض في 20.918s، فيديو في 2.418s، موقع في 25.859s، SVG في 20.220s. روابط `loam-resource://` ظاهرة للمستخدم وتفتح الناتج.
- إصلاح تحديث الحالة بعد unmount في `InstructionHistory`؛ إعادة كامل الواجهة والبناء: **1025 passed دون teardown error**.

## P6 — clean-room: superseded

- كانت أصول Manus والفيديو والنصوص المنسوخة قد استُبدلت بأصول Loam وصياغات أصلية، ثم طلب المستخدم لاحقًا استعادة الصور الأصلية المستخدمة قبل تغيير الهوية.
- القوالب التفاعلية (Budget/Focus/Habits/Kanban) ما زالت تستخدم بيانات Loam المحلية فقط.

## استعادة الصور الأصلية: passed

- استُعيدت الصور الأصلية للبطاقات الرئيسية وBuild وCreate ومعارض الفيديو والألعاب والمواقع والأزياء والصور الترويجية والجانبية، من لقطات الاستخراج وملفات الوسائط المحفوظة في `output/verification/restored-sources/`.
- بقي اسم `loam studio` وشعار Loam دون تغيير، ولم تتغير وظائف القوالب التفاعلية.
- بقي `anime-preview.mp4` وصورة الغلاف `anime-preview.png` من أصول Loam المولدة عبر Higgsfield ليتطابقا مع الفيديو العامل؛ لم يُستبدل الفيديو لأن طلب الاستعادة خاص بالصور.
- ما زال دعم `video/mp4` وByte Range في `app://` وإصلاح `BrowserContent` عبر `AbortController` محتفظًا بهما.
- تمت مراجعة الصفحة الرئيسية وBuild ومعاينة الأزياء داخل تطبيق سطح المكتب، وبناء الإنتاج ناجح. الاختبارات السابقة: **1027 اختبار واجهة** و**21 اختبار Electron**.

## P7 — الجوال والألعاب: passed

- `loam-mobile`: `mobile_present` مضيف فقط؛ يتحقق من revision والتنقل والمشروع ويصدر `mobile.json` الحقيقي دون ادعاء APK أو Expo.
- `loam-game`: `game_present` مضيف فقط؛ يتحقق من Canvas وحلقة اللعبة والمدخلات والتقاط الأخطاء و`index.html`.
- الخياران مفعّلان في الواجهة مع بقاء Websites في حزمة مستقلة. اختبارا الحزمتين ناجحان.

## P8 — HTML slides وImage slides: passed

- HTML: تصدير HTML حقيقي مع escaping و`dir=rtl` والتحقق من عدد الشرائح والتقديم.
- Image slides: `provider_not_configured` عند غياب المزود، وPNG حقيقي لكل شريحة عند وجود `UiAssetGenerator`.
- اختبارات `src/packs/__tests__/slidesFormats.test.ts` ناجحة.

## P9 — القوالب والمقدم: passed

- `/api/studio-templates` يخدم القوالب والتطبيقات التفاعلية من بيانات Loam، مع fallback للبيانات المحلية عند تعذر الاتصال.
- `TemplateGallery` و`/app/templates` يستخدمان الـAPI بدل الاعتماد على static data فقط.
- Present يفتح نافذة منفصلة، مع fullscreen داخل اللوحة عند حجب النوافذ.

## التحقق النهائي للموجة

- TypeScript للخادم والواجهة: passed.
- حزم الاختبارات الجديدة والحالية: 24 passed.
- الواجهة: **1027 passed**؛ Electron: **21 passed**؛ بناء الإنتاج: passed.
- لم تُحفظ أي تعديلات Git ولم يُنشأ commit أو فرع أو نشر خارجي.

## قيود موثقة

- A11: أصبح A13 ناجحًا بـ18/18.
- توليد الصور النقطية والفيديو النصي والموسيقى وTTS وSTT يحتاج مزودًا خارجيًا مهيأ؛ لم تُختبر خدمة سحابية مدفوعة.
- الجوال يبقى screen-based ولا يدّعي APK أو Expo أو signed store build.
