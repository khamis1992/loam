# manus-update-feed — قناة تحديث خاصة لتطبيقك (manus-local)

حزمة تجعل **manus-local** يُحدّث نفسه من قناتك، عبر `electron-updater` + `electron-builder`
(قناة `generic`: مجلد ثابت يخدم `latest.yml` + المُثبِّت).

## ما طُبّق فعلاً على `C:\Users\khamis\Desktop\manus-local`
- أُضيفت تبعيتان: `electron-updater` (تشغيل) و`electron-builder` (بناء/حزم).
- `electron-builder.yml` جديد: `appId: im.manus.local`، `asar: false` (لأن تطبيقك يشغّل `dist/server.cjs` ويقرأ `ui/` و`skills/` كملفات حقيقية)، `npmRebuild: false` (حفاظاً على modules المبنية لـ Electron الحالي).
- `electron/updater.cjs` جديد: يضبط القناة، يفحص عند الإقلاع وكل 4 ساعات، ينزّل تلقائياً، ويثبّت عند الخروج.
- `electron/main.cjs`: تهيئة المُحدِّث + عناصر قائمة «التحقق من التحديثات…» و«تثبيت التحديث وإعادة التشغيل» (في قائمة التطبيق وقائمة الصينية).
- `package.json`: سكربتان `dist` و`dist:publish`.

**النتيجة المتحقَّقة:** `release\manus-local-Setup-0.1.0.exe` + `release\latest.yml` + `blockmap`، وتحت `release\win-unpacked\resources\app-update.yml` (قناة generic) و`electron-updater@6.8.9` مضمّن.

## الخطوة الوحيدة المتبقّية: ضع رابط قناتك
القناة الفعّالة وقت التشغيل تُضبط في `electron/updater.cjs`:

```js
const DEFAULT_FEED_URL = "https://updates.example.com/manus-local/";
```
بدّلها بعنوانك (وينتهي بـ `/`). أو تجاوزها دون إعادة بناء عبر متغير البيئة `MANUS_LOCAL_UPDATE_URL`.

ولإبقاء `app-update.yml` متطابقاً، غيّر أيضاً `publish.url` في `electron-builder.yml`.

## إصدار تحديث
```powershell
# 1) ارفع رقم الإصدار في package.json (مثلاً 0.1.1)
# 2) ابنِ
npm run dist                 # أو: npm run dist:publish
# 3) ارفع ملفات release إلى قناتك
#    latest.yml + manus-local-Setup-<ver>.exe + .blockmap
```
- **اختبار محلي:** `npm run feed:serve -- release 8788` ثم اجعل الرابط `http://<جهازك>:8788/`.
- **إنتاج:** أي استضافة ثابتة (S3/nginx/Vercel) على نفس الملفات.
- التطبيق يكتشف التحديث عند الإقلاع أو خلال ≤4 ساعات، ينزّله، ثم يسأل «إعادة التشغيل الآن / لاحقاً».

## اختبار مسار التحديث دون حزم
```powershell
$env:MANUS_LOCAL_DEV_UPDATE="1"
npm run desktop
```
(يفعّل `forceDevUpdateConfig` فتُختبر القناة حتى في نسخة غير محزَّمة.)

## التحقق
```powershell
npm run feed:verify                                  # اختبار القناة (مُثبِّت وهمي)
npm run feed:verify:release -- release               # تحقّق من إصدارك الحقيقي (sha512/الحجم/blockmap)
```

## ملاحظات
- **التوقيع:** غير مطلوب لعمل `electron-updater` (يتحقق من sha512)، لكن بدونه يظهر تحذير SmartScreen. أضف شهادة لاحقاً في `electron-builder.yml`.
- **الحجم:** `asar:false` يكبّر الحزمة (المُثبِّت الحالي ~136MB لأن node_modules كاملة). إن أردت تصغيرها لاحقاً ننتقل إلى `asar:true` + `asarUnpack` لـ `dist/` و`ui/` و`skills/`.
- **المسارات:** `config.json` يستخدم مسارات مطلقة نحو مجلد التطوير؛ النسخة المثبَّتة ستقرأ نفسها. إن أردت مسارات مستقلة لكل نسخة، أخبرني وأعدّلها لتُحسب من `MANUS_LOCAL_ROOT`.
- **النشر التلقائي على GitHub:** `.github/workflows/release.yml` جاهز (عام + `releases/latest/download/`).
