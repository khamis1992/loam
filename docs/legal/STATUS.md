# Loam Legal Qatar — حالة التنفيذ

## الفرع وخط الأساس

- الفرع: `feature/loam-legal-qatar`.
- نقطة البداية النهائية: `origin/main` عند `5227df4300338547d8f5f942d38b67c6d77622a1`؛ وهي أيضاً مرجع مواصفة `law.md`.
- مساحة العمل: `C:/Users/khamis/Desktop/manus-local-legal-stable`.
- لم يبدأ التطوير من الفرع المتسخ `red-team-capability`.
- الفرع الأول من `main` المحلي `545d3fe` أعيدت تسميته إلى `feature/loam-legal-qatar-broken-base` واحتُفظ به للدليل؛ لم تُستخدم إصلاحاته أو ملفاته في فرع التنفيذ.
- سبب تغيير خط الأساس: `main` المحلي يحتوي أخطاء تركيب في `runtime.ts` ومراجع CodeGraph غير موجودة في الـcommit، بينما `origin/main` هو المرجع الذي تحققت منه مواصفة القانون.
- بيئة التنفيذ الحالية: Node `v25.2.1`, npm `11.6.2`; خط الأساس يعلن Node `>=22.13.0` ولا يحتوي `.nvmrc`.

## حالة المراحل

| المرحلة | الحالة | الدليل / العائق |
|---|---|---|
| 0. الفرع وخط الأساس | مكتملة تقنياً | `5227df4`: typecheck ناجح، 143/143 للمكونات المجاورة، الويب والبناء ناجحان؛ الاعتمادات المهنية الخارجية موثقة أدناه |
| 1. النواة والأمن والتخزين | مكتملة تقنياً | typecheck و125/125؛ تشفير tasks/runs/inputs/events، نسخ واستعادة، migrations، audit anchor، إغلاق memory/learning |
| 2. المصادر القانونية والبحث والتحقق | مكتملة تقنياً | 129/129؛ coverage/snapshots وربطها بالاعتماد، `/verify` والبنية، Recall@5=1 على 3 حالات اصطناعية؛ المصادر الحقيقية شرط خارجي |
| 3. المستندات والأدلة | مكتملة تقنياً | 133/133؛ vault وevidence anchors وtimeline/contradictions وOCR عربي/إنجليزي وPDF raster ونسخ الملفات الأصلية |
| 4. الاستدلال المشترك | مكتملة تقنياً | 137/137؛ structured outputs وClaimSupport وadversarial review وpipeline checkpoints |
| 5. العقود | مكتملة تقنياً | 142/142؛ موقف العميل والتفاوض والتحليل السياقي وOOXML الأصلي عبر API |
| 6. الدفاع | مكتملة تقنياً | 144/144؛ CaseTheory والبحث والمذكرة والخصم وبوابتا الاستراتيجية والمحامي |
| 7. الردود | مكتملة تقنياً | 145/145؛ الادعاء–رد–دليل والصياغة والمراجعة والاستئناف |
| 8. تحليل المستندات | مكتملة تقنياً | 146/146؛ التقرير بالمواضع والنواقص والتناقضات والاعتماد |
| 9. الواجهة والمراجعة والتصدير | جارية | Legal Workspace وApprovalArtifact وWord وE2E |
| 10. التقييم والتجهيز للدمج | لم تبدأ | — |

## سجل الأوامر والنتائج

| الأمر | النتيجة |
|---|---|
| `git worktree add -b feature/loam-legal-qatar ... main` | أثبت أن `main` المحلي غير صالح كخط أساس؛ نُقل الفرع إلى `feature/loam-legal-qatar-broken-base` |
| `git worktree add -b feature/loam-legal-qatar ... origin/main` | نجح؛ HEAD `5227df4` |
| `npm ci` على الفرع الأول | فشل سابق: `EUSAGE` لعدم تزامن package-lock مع package.json |
| `npm install --no-package-lock` و`npm --prefix packages/web install --no-package-lock` | نجحا على الفرع المستقر دون تعديل ملفات القفل |
| `npm run typecheck` على `5227df4` | نجح |
| 12 ملف اختبار للمكونات المجاورة على `5227df4` | 143/143 ناجحة |
| فحص واختبارات وبناء الويب على `5227df4` | نجح typecheck وVitest و`next build` |
| `npm run typecheck` و`npm run test:legal` بعد المرحلة 1 | نجحا؛ 125/125، بما فيها transcript canary وbackup/restore وmodel blocking |
| اختبارات التوافق مع التخزين والاستئناف | نجحت؛ autoResume/retryLast/seqReplay/storeCompat وcatalog/promptwire |
| `npm run check:legal` بعد المرحلة 2 | نجح؛ 129/129 وtypecheck للواجهة |
| `npm run eval:legal` | Recall@5=1 وMRR=0.8333 على 3 حالات اصطناعية؛ ليس تقييماً لمصادر قانونية حقيقية |
| `npm run check:legal` بعد المرحلة 3 | نجح؛ 133/133، بما فيها رفع المستند عبر API وOCR لجملة عربية ونص إنجليزي وأرقام |
| `npm run check:legal` بعد المرحلة 4 | نجح؛ 137/137، بما فيها structured output والاستدلال والـpipeline |
| `npm run check:legal` بعد المرحلة 5 | نجح؛ 142/142، بما فيها التحليل السياقي والعقد وredline عبر API |
| `npm run check:legal` بعد المرحلة 6 | نجح؛ 144/144، بما فيها نظرية الدفاع والصياغة والاستراتيجية والاستئناف |
| `npm run check:legal` بعد المرحلة 7 | نجح؛ 145/145، بما فيها الرد القانوني ومصفوفة الادعاءات |
| `npm run check:legal` بعد المرحلة 8 | نجح؛ 146/146، بما فيها تحليل المستندات والتناقضات والاعتماد |
| بيئة الفرع الأول | npm أبلغ 14 ثغرة (9 متوسطة و5 عالية) وتحذير engine لـ`nanoid` على Node 25؛ تسجل كbaseline ولا يطبق `audit fix --force` |

## قرارات خارجية مطلوبة قبل الاعتماد النهائي

- اعتماد محامٍ قطري للقوالب والـplaybooks ومجموعة التقييم.
- توفير مصادر رسمية موثقة وحقوق استخدامها وتحديثها.
- اختبار نهائي على Windows/Electron/Word/OCR وبيانات منزوعة الهوية.

## قواعد التنفيذ

- لا merge في `main` ولا push.
- لا بيانات عميل أو أسرار في المستودع.
- لا انتقال باعتبار مرحلة مكتملة دون أدلة اختباراتها.
