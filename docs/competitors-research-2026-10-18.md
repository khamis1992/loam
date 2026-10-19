# Loam — مراجعة الخدمات وبحث المنافسين

تاريخ الإعداد: 2026-10-18. هذا التقرير جزءان: الأول مراجعة داخلية لخدمات Loam كما هي في الكود فعليًا (الإصدار 0.5.22)، والثاني بحث سوقي عن المنافسين — كل جهة تقدم أي خدمة من خدماتنا تُعد منافسًا مباشرًا أو غير مباشر. مصادر البحث موثقة بالروابط في نهاية كل قسم.

---

## الجزء الأول — خدمات نظامنا

Loam مساحة عمل ذكاء اصطناعي **محلية** (تطبيق سطح مكتب Electron لنظام Windows + خادم Node على 127.0.0.1) **عربية أولًا** (واجهة RTL)، تعمل عبر نماذج محلية (Ollama) أو سحابية، وتنفّذ مهام حقيقية على جهاز المستخدم مع عزل لكل مهمة، واستئناف بعد الانقطاع، وذاكرة دلالية، ومكتبة مهارات، وحلقة تحسين ذاتي.

### الأنماط السبعة (مفروضة من الخادم لكل مهمة)

| النمط | الغرض | الأدوات التنفيذية الأساسية |
|---|---|---|
| استكشف | أسئلة وقراءة دون تعديل | قراءة/بحث/رموز كود فقط |
| ابحث | بحث ويب بالمصادر وحفظ تقرير | web_search + web_fetch + كتابة |
| ابنِ | تطوير مشاريع | ملفات + أوامر تنفيذ + اختبارات + معاينة حية |
| اكتب | تحرير مستندات وعروض | loam_document + loam_studio |
| حلّل | جداول وCSV | loam_dataset + loam_studio |
| صمّم | تصميم متجه ومشاهد 3D | loam_canvas + loam_creative + معاينة |
| أنجز | أتمتة متصفح بالأدلة | أدوات browser_* كاملة مع تسجيل فيديو للأدلة |

### الاستوديوهات الخمسة

1. **استوديو الموبايل**: من وصف/نموذج شاشات → تطبيق ويب مستقل + كود Android أصلي (Kotlin/Jetpack Compose بدون WebView) + كود Expo/React Native + **بناء APK فعلي محليًا عبر Gradle** (تم التحقق بالتثبيت على محاكي Pixel 7). حتى 100 شاشة، سجلات ومجموعات وتخزين محلي. لا يوجد بناء iOS ولا نشر للمتاجر بعد.
2. **استوديو المكتب/Live**: محرر حي بجانب المحادثة للمستندات والعروض والجداول؛ استيراد DOCX/PPTX/XLSX حقيقي وتحرير وتصدير يحافظ على الأنماط الأصلية (ترقيع OOXML)؛ معاينة Word أصلية مع تحرير بالمؤشر. مُتحقق في Word/Excel/PowerPoint الفعلية.
3. **الاستوديو الإبداعي**: محرر مشاهد 3D (WebGL + GLB + مواد + حركة + تصدير PNG/GLB)، محرر صور، **مونتاج فيديو متعدد المسارات بدقة الإطارات** (إطارات مفاتيح، انتقالات، ترجمات SRT، تصدير MP4 عبر FFmpeg محلي مع طابور تصدير يستأنف بعد إعادة التشغيل)، مولّد بوسترات SVG.
4. **استوديو السرب**: خط شركة برمجيات من 7 مراحل (متطلبات ← معمارية+مخاطر ← تنفيذ ← بوابة مراجعة كود REVIEW_PASS/ISSUES ← بوابة QA تشغّل أوامر اختبار حقيقية ← تسليم) مع حلقة إصلاح ذاتي محدودة.
5. **استوديو الأمن**: تقييم أمني موثّق لأهداف مصرح بها: فحوص HTTP/TLS والكوكيز والملفات المكشوفة وCORS، فحص مصدر أبيض الصندوق (AST لحقن SQL/NoSQL ومسارات وأسرار)، اختبارات متصفح حقيقية (Playwright) تشمل مصفوفة صلاحيات متعددة الحسابات وسبل دخول مجهول، تدقيق حزم npm مقابل OSV (تُرسل الأسماء والإصدارات فقط)، تقارير Markdown عربية + تصدير SARIF.

### قدرات مشتركة

- ~117 أداة داخلية + خوادم MCP (stdio وHTTP) مع بوابات إذن لكل مهمة.
- طرفية حقيقية (PTY) لكل مهمة، أتمتة متصفح حقيقية (Edge/Chromium) مع أدلة فيديو، تحكم بويندوز (نقر/كتابة/UIA)، التقاط وبث شاشة.
- ذاكرة دلالية بحث متجهي محلي + «دماغ» ثلاثي الطبقات (عرضي/دلالي/إجرائي) + تعلم ذاتي بموافقة بشرية + حزم تقييم + تصدير بيانات fine-tuning.
- مرافقون (وكلاء بأشخاص ونماذج وأنماط مخصصة)، مجدول مهام دورية، مشاريع، تقارير قياس عن بُعد.
- تحديث تلقائي للتطبيق المثبت، وبرامج تحقق تتجاوز 100 سكربت.

**الخلاصة**: Loam يجمع خمس ركائز لم تجتمع في منتج واحد حتى الآن: (1) تطبيق مكتب مثبّت، (2) تنفيذ حقيقي (ملفات/طرفية/متصفح/نظام)، (3) نماذج محلية عبر Ollama للخصوصية، (4) عربية أولًا، (5) ميزات مساحة عمل (عزل المهام، استئناف، ذاكرة، مهارات، أدلة).

---

## الجزء الثاني — المنافسون حسب الخدمة

### 1. منصات الوكلاء العامة السحابية (تنافس النواة: وكيل ينفذ مهام حقيقية)

| المنافس | الرابط | سحابي/محلي | السعر | يتقاطع مع | العربية |
|---|---|---|---|---|---|
| Manus 2.0 | manus.im | سحابي | مجاني ~300 رصيد/يوم؛ $20–200/شهر | كل شيء تقريبًا: بحث، متصفح، ملفات، تسليمات | جزئية عبر النماذج |
| ChatGPT Agent | chatgpt.com | سحابي | Plus $20 (~40 مهمة/شهر)، Pro $200 | متصفح، بحث، كود، مهام سطح مكتب | جيدة |
| Devin | devin.ai | سحابي | $20–200/شهر أو ~$2.25/ACU | تنفيذ كود/طرفية، مهام طويلة | لا |
| Google Mariner/Jules | jules.google | سحابي | ضمن اشتراكات Gemini | أتمتة متصفح + برمجة | جيدة |
| Perplexity Comet | perplexity.ai/comet | متصفح محلي/وكيل سحابي | مجاني؛ Plus $5؛ Pro $20 | أتمتة متصفح + بحث بالمصادر | جزئية |
| Claude (computer use + Cowork) | claude.com | نموذج سحابي | Pro $20 / Max $100–200 | تحكم بالحاسوب والمهارات — نفس مفاهيمنا | جيدة |
| Genspark Super Agent | genspark.ai | سحابي | مجاني ~100 رصيد/يوم؛ $24.99+ | مهام عامة وعروض وجداول | جزئية |

**الخلاصة**: هذه الفئة ترسّخ سوق «الوكيل الذي ينفذ». ضعفها المشترك: التنفيذ كله في سحابتهم، ولا عربية أولًا. Manus هو المرجع الذي سيقارن به كل عرض لنا.

### 2. تطبيقات وكلاء محلية/خاصة (تنافس ركيزتي الخصوصية + المحلية)

| المنافس | الرابط | النوع | السعر | ملاحظات التقاطع |
|---|---|---|---|---|
| **LM Studio Bionic** | lmstudio.ai | تطبيق وكيل محلي مستقل (Win/Mac/Linux) | مجاني محليًا؛ +$20/شهر للنماذج المستضافة | **التهديد المحلي الأول**: مستندات وعروض وكود و«تحكم بالحاسوب» بنموذج محلي — أقرب منافس فكريًا ووظيفيًا |
| Jan + Jan Agent | jan.ai | دردشة محلية مفتوحة المصدر + وكيل برمجة بمهارات وذاكرة | مجاني (AGPL) | خصوصية محلية + مهارات/ذاكرة، لكن الوكيل برمجي فقط |
| AnythingLLM | anythingllm.com | مساحات عمل RAG محلية + وكلاء محدودون | مجاني (MIT) | مفهوم «مساحات عمل» وذاكرة ووكلاء ملفات/ويب — تنفيذ أضيق منا |
| Open WebUI | openwebui.com | واجهة ذاتية الاستضافة مع MCP وأدوات | مجاني | عميل MCP ومساحات عمل لكن محورها الدردشة |
| Cherry Studio 2.0 | github.com/cherryhq | عميل سطح مكتب محلي + وكلاء داخل التطبيق + MCP | مجاني | قاعدة ضخمة غير غربية؛ نموذج «استوديو محلي متعدد اللغات» — إن أضاف عربية أولًا أو تنفيذًا حقيقيًا صار منافسًا مباشرًا |
| OpenHands | openhands.dev | منصة وكيل برمجة ذاتية الاستضافة (MIT) | مجاني | أقوى منافس محلي على التنفيذ الحقيقي (طرفية/ملفات/متصفح) لكنه للمطورين وDocker وإنجليزي |
| Cline / Roo Code / Zed | cline.bot / zed.dev | وكلاء IDE بنماذج محلية | مجاني BYOK | يلبون جزء جمهورنا المطور بدون تكلفة |
| Dify / n8n / Flowise | dify.ai / n8n.io | بنيات وكلاء ذاتية الاستضافة | مجاني ذاتي الاستضافة | أدوات بناة للمطورين لا مساحة عمل للمستخدم النهائي |
| Msty / Khoj / PrivateGPT | — | دردشة/RAG محلي فقط | مجاني | لا تنفيذ مهام — منافسة جانبية |
| Browser Use | browser-use.com | مكتبة أتمتة متصفح مفتوحة + سحابة | مجاني المحلي؛ سحابة $20 | تُسهّل على أي طرف بناء ما لدينا من أتمتة متصفح |

**الخلاصة**: لا يوجد منتج يشغل موقعنا (محلي + عربي + تنفيذ حقيقي + مساحة عمل). أقرب المنافسين: LM Studio Bionic ثم OpenHands وJan.

### 3. مولدات تطبيقات الموبايل (تنافس استوديو الموبايل)

| المنافس | الرابط | المخرجات | APK؟ | محلي/سحابي | السعر |
|---|---|---|---|---|---|
| **Google AI Studio (Android)** | ai.google.dev | **Kotlin + Jetpack Compose** (مشروع Gradle كامل) | نعم (ADB عبر WebUSB + مسار Play داخلي) | سحابي | مجاني/API |
| **Rork** | rork.com | Expo/RN (Pro) + SwiftUI أصلي (Max) | جزئي (.aab + APK تجريبي) | سحابي | $25–200+/شهر |
| **a0.dev** | a0.dev | React Native/Expo كامل + نشر للمتاجر | نعم | سحابي | مجاني؛ ~$20/شهر |
| **Replit Agent Mobile** | replit.com/mobile-apps | Expo/RN (iOS+Android) — أُطلق يناير 2026 | عبر EAS والنشر | سحابي | $25/شهر + استهلاك |
| **CatDoes** | catdoes.com | Expo/RN + Supabase مع نشر للمتاجر | نشر مدمج | سحابي | مجاني؛ $20/شهر |
| Bolt.new | bolt.new | ويب + Expo/RN | لا (يحتاج EAS) | سحابي | مجاني محدود؛ $25/شهر |
| FlutterFlow AI | flutterflow.io | Flutter/Dart (بصري + AI) | APK/AAB عبر أنابيبهم | سحابي (+CLI محلي) | مجاني؛ من $39/شهر |
| Thunkable AI | thunkable.com | iOS/Android أصلي (بلوكات + AI) | نشر مشترك بالاشتراك | سحابي | $37/شهر |
| RapidNative / Vibecode / Emergent | — | Expo/RN | متفاوت | سحابي | ~$20/شهر |
| Superapp | superapp.dev | Swift/SwiftUI أصلي (iOS فقط) | iOS فقط | سحابي | $25–100/شهر |
| Manus mobile builder | manus.im | iOS/Android عبر وكيل | استهداف المتاجر | سحابي | ~$20/شهر |
| Dyad | dyad.sh | **مولد ويب محلي فقط** (Next.js عبر Ollama) | لا | محلي | مجاني OSS |
| Baidu Miaoda / Tencent / Trae SOLO | — | ويب/H5/تطبيقات صينية | لا APK أصلي | سحابي | رخيص جدًا |

**الخلاصة**: منذ مطلع 2026 أصبحت فئة «وصف → تطبيق موبايل حقيقي» مزدحمة (Replit وBolt وThunkable دخلتها، وGoogle تقدم المسار الوحيد المنافس لنا في Kotlin→APK). **لكن كل المنافسين سحابيون بلا استثناء، ولا أحد ينتج Kotlin+Compose وExpo معًا من نموذج واحد، ولا أحد يبني APK محليًا على جهاز المستخدم، ولا أحد عربي أولًا**. منافسونا المباشرون الأقرب: Google AI Studio ثم Rork وa0.dev وReplit.

### 4. المكتب والمستندات (تنافس استوديو المكتب)

| المنافس | الرابط | سحابي/محلي | السعر | التقاطع |
|---|---|---|---|---|
| Microsoft 365 Copilot | microsoft.com/copilot | تحرير محلي/ذكاء سحابي | $99–200/سنة؛ أعمال ~$32/مستخدم | **المرجع**: OOXML أصلي + عربية رسمية؛ لا وكيل حي بجانب المحادثة ولا AI بلا اتصال |
| Gemini for Workspace | workspace.google.com | سحابي | من $14/مستخدم | استيراد بتحويل (فقد دقة) |
| **ONLYOFFICE + LM Studio** | onlyoffice.com | **محررات محلية + AI محلي** | مجاني | **أقرب منافس بنيويًا**: أفضل دقة OOXML محلية + ذكاء على الجهاز |
| WPS AI | wps.com | هجين | Freemium | قوي في الأسواق العربية حساسة السعر؛ مشاكل RTL في العروض |
| Canva (Magic Studio) | canva.com | سحابي | Pro ~$15/شهر | عربية/RTL ممتازة وشعبية في المنطقة؛ يستورد الملفات لكن بتحويل (تصدير خاسر الدقة) |
| Gamma | gamma.app | سحابي | $9–20/شهر | عروض AI بدعم RTL رسمي |
| Claude / ChatGPT (تحرير ملفات) | claude.com / chatgpt.com | سحابي | $20+/شهر | «الوكيل ينتج/يحرر docx/xlsx/pptx» — بدون محرر حي بالمؤشر ولا ترقيع يحفظ الأنماط |
| LibreOffice | libreoffice.org | محلي مجاني | مجاني | أفضل حزمة أوفلاين عربية بدون AI (موقفهم المعلن رفض AI الافتراضي) |
| Beautiful.ai / Napkin / Zoho / Genspark Slides | — | سحابي | اشتراكات | مولدات عرض — تقاطع متوسط |

**الخلاصة**: لا أحد يجمع (تحرير OOXML محلي + ترقيع يحفظ الأنماط + محرر حي يتحكم به الوكيل + عربية أولًا). أقرب الجيران: ONLYOFFICE بمحليته، وCopilot بعراقته، وClaude/ChatGPT بعقلية «الوكيل يحرر ملفاتك».

### 5. الإبداع: فيديو وصور و3D وبوسترات (تنافس الاستوديو الإبداعي)

| المنافس | الرابط | محلي/سحابي | السعر | التقاطع |
|---|---|---|---|---|
| **CapCut** | capcut.com | تطبيق مكتب شبه محلي | مجاني؛ Pro ~$8–10/شهر | **التهديد الأول**: مونتاج خط زمني + قاعدة ضخمة في المنطقة + واجهة عربية |
| Kdenlive / Shotcut / OpenShot | kdenlive.org وآخرون | **محلي مفتوح 100%** | مجاني | يملكون قصة «تصدير MP4 دون رفع» اليوم؛ UX قديم بلا طابور تصدير مستأنف |
| DaVinci Resolve (مجاني) | blackmagicdesign.com | محلي | مجاني + $295 مرة واحدة | احترافي محلي يضع سقفًا لطموحاتنا الاحترافية |
| Descript / Veed / Clipchamp | — | سحابي (رفع إلزامي) | $6–59/شهر | تحرير بالنص/سحابي — فلسفة معاكسة لخصوصيتنا |
| Runway / Sora / Veo / Kling | — | سحابي (توليد) | اشتراكات/أرصدة | منافسة غير مباشرة (توليد لا مونتاج) |
| **Spline** | spline.design | سحابي | $9–60/شهر | أقرب منافس لمحرر 3D في المتصفح (مواد/حركة/WebGL) |
| Blender / Three.js editor | blender.org | محلي مجاني | مجاني | Blender مجموع شامل منا لكن بتعقيد احترافي |
| Womp / Bezel / Dora | — | سحابي | Freemium | تقاطع متوسط/منخفض |
| Canva / Figma AI / MS Designer / PosterMyWall | — | سحابي | Freemium–$15 | بوسترات وSVG — Canva الأقوى عربيًا (تهديد عابر لكل الاستوديوهات) |

**الخلاصة**: في الفيديو المحلي ننافس Kdenlive/CapCut، وفي 3D ننافس Spline/Blender. ميزتنا: طابور التصدير المستأنف + ترجمات + كله داخل نفس مساحة العمل الذكية، بدون رفع أي ملف للسحابة.

### 6. الأمن واختبار الاختراق (تنافس استوديو الأمن)

| المنافس | الرابط | محلي/سحابي | السعر | التقاطع |
|---|---|---|---|---|
| **PentAGI** | github.com/vxcontrol/pentagi | **محلي مفتوح** (Docker) | مجاني | أقرب منافس محلي شامل: وكلاء اختراق متعددون ذاتيو الاستضافة — بلا صندوق أبيض ولا SARIF ولا عربية |
| **PentestGPT / HackerAI** | pentestgpt.com | محلي CLI / سحابي | مجاني/اشتراك | وكيل اختراق ذاتي (86.5% على مجموعة XBOW) — بلا فحص مصدر ولا تقارير عربية |
| OWASP ZAP | zaproxy.org | **محلي مجاني** | مجاني | خط الأساس الداشتي المجاني (ترويسات/CORS/ملفات مكشوفة) |
| XBOW | xbow.com | سحابي | $4K–35K+ | معيار القدرة (تصدر HackerOne) — سحابي وغالي |
| Burp Suite + Burp AT | portswigger.net | سطح مكتب (AI سحابي) | $449+/سنة | معيار المحترفين + وكيل ذاتي في بيتا |
| TestSprite | testsprite.com | سحابي | $19–69/شهر | **المنافس العربي الوحيد** (صفحة اختبار اختراق AI بالعربية) — يهاجم موقعنا «العربي» من الجهة السحابية |
| Femtosec (دبي) | femtosec.io | سحابي | من $999/اختبار | اختراق ذاتي موجّه للشرق الأوسط |
| Snyk (Code+Open Source+Probely) | snyk.io | سحابي | من $59/مطور | يجمع SAST+SCA+DAST سحابيًا — يقابل نصفينا الأبيض والاعتمادي |
| Semgrep / CodeQL / Trivy / OSV-Scanner | — | محرك محلي مجاني + سحابة | مجاني/$30 لكل مطور | OSV-Scanner نفسه مجاني محلي — يجب أن نتفوق بالتجربة والعربية والتقرير لا بالحداثة |
| Horizon3 / Detectify / Intruder / Astra / Synack / Pentera | — | سحابي | من $99/شهر إلى عقود مؤسسية | أطراف خارجية/مؤسسية — منافسة غير مباشرة |

**الخلاصة**: كل اللاعبين التجاريين الجديين سحابيون؛ المحليون (ZAP/PentAGI/PentestGPT) لا يجمعون صندوقًا أبيض + مصفوفة صلاحيات متصفح + تدقيق حزم + تقارير عربية + SARIF. أزمة سلسلة التوريد في npm (مارس 2026) تقوّي طرحنا: «لا يخرج من جهازك إلا اسم الحزمة وإصدارها».

### 7. سرب تطوير البرمجيات متعدد الوكلاء (تنافس استوديو السرب)

| المنافس | الرابط | محلي/سحابي | السعر | التقاطع |
|---|---|---|---|---|
| **MetaGPT** | github.com/FoundationAgents/MetaGPT | محلي مفتوح | مجاني | الجد المفاهيمي المباشر: شركة برمجيات بأدوار — اختباراته محاكاة لا أوامر حقيقية |
| ChatDev | github.com/OpenBMB/ChatDev | محلي مفتوح | مجاني | شركة افتراضية بسلاسل محادثة — نفس الفجوة |
| OpenHands | openhands.dev | محلي (MIT) | مجاني | الأقوى على «الأوامر الحقيقية» لكنه منصة عامة بلا خط مراحل موجه |
| Microsoft Agent Framework (AutoGen+SK) | learn.microsoft.com | مفتوح محلي/أzure | مجاني | ركيزة التنسيق الافتراضية التي يمكن للعميل بناء خطنا عليها بنفسه |
| CrewAI | crewai.com | OSS + سحابة | مجاني؛ سحابة من $25 | أطقم أدوار عامة بلا بوابات دورة حياة |
| Devin / Factory.ai | devin.ai / factory.com | سحابي | $20–200/شهر؛ ~$2.25/ACU | مقارنة الميزانية السحابية — بلا خط أدوار وبوابات |

**الخلاصة**: ميزتنا الحاسمة هنا **إنفاذ البوابات** (مراجعة تنتهي بـ REVIEW_PASS/ISSUES + QA يجب أن يشغّل npm test/pytest/tsc فعلًا) مع حلقة إصلاح ذاتي، محليًا وبعربية. MetaGPT/ChatDev يحاكون؛ OpenHands ينفذ لكن بلا خط معتمد.

### 8. ذاكرة الوكلاء والتحسين الذاتي (تنافس الذاكرة/الدماغ/التعلم)

| المنافس | الرابط | محلي/سحابي | التقاطع |
|---|---|---|---|
| **Mem0** | mem0.ai | OSS ذاتي الاستضافة + سحابة | أقرب تداخل وظيفي: ذاكرة دلالية+عرضية مع معايير قياس |
| Letta (MemGPT) | letta.com | OSS + سحابة | عامل يدير ذاكرته بنفسه + «حساب وقت النوم» (أقرب تشابه لتحسينا الذاتي) |
| Zep / Graphiti | getzep.com | OSS (يحتاج قاعدة بيانات رسومية) | ذاكرة رسم معرفي زمني |
| Cognee | cognee.ai | OSS + مدار | ذاكرة + خط تقييمات |
| LangMem / Supermemory / Oracle Agent Memory | — | SDK مجاني / سحابة | بدائل طبقة الذاكرة |

**الخلاصة**: لا يوجد نظام ذاكرة **عربي أولًا محليًا**، ولا منافس تجاري لمكتبة مهارات بإحصاءات أداء + تحسين بموافقة بشرية + تصدير fine-tuning. هذه منطقة بيضاء لنا.

### 9. المنافسون في الساحة العربية

| المنافس | الرابط | نوعه | التقاطع |
|---|---|---|---|
| Fanar 2.0 (قطر) | fanar.qa | منصة محادثة عربية سيادية سحابية | يرسم سقف توقعات جودة العربية — لا ينفذ مهام |
| ALLaM (سدايا، السعودية) | sdaia.gov.sa | مساعد محادثة وطني سحابي (أوزان 7B مفتوحة تعمل على Ollama) | منافسة على ولاء «العربية»؛ مورّد نموذج لنا أكثر منه منافس منتج |
| **Cycles Saudi** | أُطلق أكتوبر 2026 | 4 وكلاء عربيين منفذين للمهام (عام/قانون سعودي/تسويق/تداول) سحابيًا | **أقرب منافس عربي على قيمة «الوكيل المنفذ»** — سحابي ورأسي فقط |
| TestSprite | testsprite.com | اختبار اختراق AI بصفحة عربية | يهاجم استوديو الأمن لدى الجمهور العربي |
| Mudawin / Velents Agent.sa | — | مساعد اجتماعات عربي / وكيل أعمال | منافسة جانبية |

**الخلاصة**: الساحة العربية إما دردشة سحابية (Fanar/ALLaM) أو وكلاء سحابيون حديثو الإطلاق (Cycles). لا يوجد أي مساحة عمل وكيلة محلية عربية — موقعنا فارغ تمامًا في هذه الخانة، والمنافسة ستكون على من يصل أولًا.

---

## الجزء الثالث — الترتيب الاستراتيجي

### أبرز 10 تهديدات مباشرة (مرتبة)

1. **LM Studio Bionic** — التطبيق الوكيل المحلي الوحيد واسع التوزيع (مستندات/كود/تحكم بالحاسوب، مجاني محليًا). يطابق فلسفتنا؛ ينقصه العربية والأدلة والعزل والذاكرة الدلالية، لكنه سيحدد توقعات الفئة.
2. **Manus** — المرجع الفئوي العام؛ مقارنة كل عرض تسويقي لنا ستكون معه. حشوتنا: الخصوصية/المحلية والعربية.
3. **Google AI Studio (Android builder)** — المسار الوحيد المنافس «وصف → Kotlin/Compose → APK»؛ يتفوق بنشر Play، ونتفوق بالمحلية وExpo المزدوج والعربية.
4. **OpenHands** — أقوى منصة تنفيذ حقيقية محلية مجانية؛ إن أضافت واجهة مستهلك أو تعريبًا صارت منافسًا كاملًا.
5. **ChatGPT Agent** — قوة توزيع ساحقة؛ 40 مهمة/شهر بـ$20 «كافية» لمن لا يقدّر الخصوصية.
6. **Cherry Studio 2.0** — عميل محلي ضخم التثبيتات خارج الغرب مع وكلاء وMCP؛ لو انقلب للتنفيذ الحقيقي أو العربية أولًا هاجمنا مباشرة.
7. **ONLYOFFICE (+AI محلي)** — أقرب جار لاستوديو المكتب: OOXML محلي + ذكاء على الجهاز.
8. **CapCut** — الأداة الافتراضية للمونتاج لدى جمهورنا العربي؛ مقارنة استوديو الإبداع ستكون معه دائمًا.
9. **Cycles Saudi + TestSprite** — يحتكرون سردية «الوكيل العربي» سحابيًا إن لم نرسّخ أنفسنا أولًا.
10. **PentAGI / PentestGPT** — المنافسان المحليان المفتوحان لاستوديو الأمن، مع OWASP ZAP كخط أساس مجاني.

### موقفنا الذي لا يشغله أحد (خمسة أعمدة معًا)

تطبيق مثبّت + تنفيذ حقيقي (ملفات/طرفية/متصفح/نظام) + نماذج محلية للخصوصية + عربية أولًا (وكلاء أمتنا العربية ALLaM/Fanar Star/Jais تعمل على Ollama اليوم) + مساحة عمل حقيقية (عزل مهام، استئناف، ذاكرة، مهارات، أدلة). أقرب المنافسين يجمع عمودين على الأكثر:

- LM Studio Bionic: محلي + تنفيذ (بلا عربية ولا مساحة عمل كاملة).
- Manus: تنفيذ + مساحة عمل (سحابي بلا خصوصية ولا عربية أولًا).
- Google AI Studio: مخرجات موبايل ممتازة (سحابي بلا خصوصية ولا عربية).
- Cycles: عربي منفذ (سحابي بلا محلية ولا مساحات استوديو).

### فجوات يجب إغلاقها (الموجودة عند المنافسين وغائبة عنا)

1. **iOS وبناء/نشر المتاجر** للموبايل (Rork/Replit/a0/Google ينشرون).
2. **خدمات خلفية حقيقية للتطبيقات المولدة** (auth/مدفوعات/مزامنة) — CatDoes وa0 يوفرونها عبر Supabase/Convex.
3. **توليد وسائط بالذكاء الاصطناعي** (صور/فيديو) في الاستوديو الإبداعي — كل السوق يتوقعه، وخارطة طريقنا تؤجل صراحة.
4. **تغطية سحابية اختيارية سهلة** لمن يريد نماذج أقوى (نحن عبر Ollama فقط).

### توصيات سريعة

- رسالة التموضع: «Manus لكن على جهازك، وبالعربية» ضد التهديد السحابي؛ و«عربي أولًا + أدلة + عزل» ضد Bionic.
- أسرع مكاسب تنافسية: دعم نماذج ALLaM/Fanar Star/Jais المحلية ضمن إعدادات موصى بها، وصفحات هبوط عربية لكل استوديو (المنافسون بلا وجود عربي حقيقي).
- في الأمن: تبنّي سردية أزمة سلسلة التوريد 2026 (خصوصية فحص الاعتمادات محليًا) — لا أحد من السحابيين يستطيع منافستنا عليها.

---

## أهم المصادر

- [Manus التسعير](https://www.nocode.mba/articles/manus-ai-pricing) · [ChatGPT Agent](https://help.openai.com/en/articles/11752874-chatgpt-agent) · [Devin](https://devin.ai/pricing) · [Perplexity Comet](https://www.perplexity.ai/comet) · [Claude computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [LM Studio Bionic](https://lmstudio.ai/blog/introducing-lm-studio-bionic) · [Bionic pricing](https://lmstudio.ai/pricing) · [Jan](https://jan.ai) · [AnythingLLM](https://anythingllm.com) · [Open WebUI MCP](https://docs.openwebui.com/features/extensibility/mcp) · [Cherry Studio](https://github.com/cherryhq/cherry-studio) · [OpenHands](https://www.openhands.dev) · [Cline](https://cline.bot) · [Zed local AI](https://zed.dev/blog/local-ai-in-zed) · [Browser Use](https://browser-use.com)
- [Google AI Studio Android](https://ai.google.dev/gemini-api/docs/aistudio-android) · [مدونة Android](https://developer.android.com/blog/posts/build-native-android-apps-in-google-ai-studio) · [Rork FAQ](https://rork.com/faq) · [مراجعة Rork 2026](https://www.nocode.mba/articles/rork-ai-review-2026) · [a0.dev](https://a0.dev) · [Replit Mobile](https://docs.replit.com/features/artifact-types/building-mobile-apps) · [CatDoes](https://catdoes.com/blog/best-ai-app-builder) · [Bolt + Expo](https://expo.dev/blog/bolt-expo-integration-announcement) · [FlutterFlow AI](https://flutterflow.io/ai) · [Thunkable AI](https://www.prnewswire.com/news-releases/from-idea-to-app-store-thunkable-ai-enables-anyone-with-a-dream-and-device-to-build-no-technical-skills-required-302729617.html) · [Dyad](https://www.dyad.sh) · [Lovable والموبايل](https://lovable.dev/guides/native-mobile-app-vs-web-app)
- [Copilot للغات](https://support.microsoft.com/en-us/microsoft-365-copilot/supported-languages-for-microsoft-365-copilot) · [Copilot للأعمال](https://www.microsoft.com/en-us/copilot/pricing/business) · [Gemini Workspace](https://workspace.google.com/pricing) · [Gamma RTL](https://help.gamma.app/en/articles/11016519-does-gamma-support-right-to-left-languages) · [ONLYOFFICE AI 2026](https://www.onlyoffice.com/blog/2026/10/onlyoffice-ai-tools) · [Claude وتحرير الملفات](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude) · [Canva AI 2026](https://fast.io/resources/canva-ai-review-2026)
- [CapCut vs Descript](https://www.ngram.com/blog/capcut-vs-descript) · [Kdenlive vs OpenShot](https://bundl.run/compare/kdenlive-vs-openshot) · [Spline pricing](https://spline.design/pricing) · [أدوات RTL](https://www.elarislabs.ai/blogs/best-ai-ad-tools-arabic-rtl-2026)
- [XBOW](https://xbow.com/blog/top-1-how-xbow-did-it) · [PentestGPT](https://github.com/greydgl/pentestgpt) · [PentAGI](https://github.com/vxcontrol/pentagi) · [HexStrike](https://github.com/0x4m4/hexstrike-ai) · [OWASP ZAP](https://www.zaproxy.org) · [Burp AT](https://portswigger.net/burp/burp-at) · [TestSprite بالعربية](https://www.testsprite.com/use-cases/ar/ai-penetration-testing-tool) · [Femtosec](https://femtosec.io) · [a16z اختراق الجيل القادم](https://a16z.com/next-gen-pentesting-ai-empowers-the-good-guys) · [Red Hat RHSB-2026-001](https://access.redhat.com/security/vulnerabilities/RHSB-2026-001)
- [MetaGPT](https://github.com/foundationagents/metagpt) · [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview) · [CrewAI pricing](https://crewai.com/pricing) · [بدائل Devin](https://www.openhands.dev/blog/devin-ai-alternatives)
- [Mem0](https://mem0.ai) · [Letta](https://letta.com) · [Zep/Graphiti](https://github.com/getzep/graphiti) · [ذاكرة الوكلاء مفتوحة المصدر 2026](https://hindsight.vectorize.io/blog/2026/08/11/open-source-agent-memory-systems)
- [Fanar](https://www.fanar.qa/en) · [ALLaM أوزان مفتوحة](https://huggingface.co/humain-ai/ALLaM-7B-Instruct-preview) · [Cycles Saudi](https://www.middleeastainews.com/p/saudi-startup-launches-four-ai-agents) · [نماذج عربية محلية 2026](https://www.promptquorum.com/local-llms/best-arabic-local-llms-2026)
