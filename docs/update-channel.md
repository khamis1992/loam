# قناة التحديث التلقائي — Loam

أولوية مصدر التغذية (الأعلى أولًا):
1. `LOAM_UPDATE_FEED_URL` (أو الاسمان الأقدمان `LOAM_UPDATE_URL`/`MANUS_LOCAL_UPDATE_URL`).
2. إعدادات المستخدم: `updateFeedUrl` أو `githubRepo` (Settings → Updater).
3. `LOAM_GITHUB_REPO`/`MANUS_GITHUB_REPO` من البيئة.
4. القناة المحلية للاختبار المحلي (تمرَّر من main أثناء التطوير).
5. **الافتراضي للتطبيقات المثبّتة: `https://github.com/khamis1992/loam/releases/latest/download/`**.

## النشر

- **من CI**: دفع tag مثل `v0.5.32` يشغّل `.github/workflows/release.yml` (بناء + فحص + رفع latest.yml والمثبّت وblockmap إلى GitHub Release).
- **محليًا (توقيع بشهادة الجهاز)**: `npm run dist` ثم `npm run publish:release [v<الإصدار>]` — يتحقق من تطابق إصدار latest.yml مع package.json ثم يرفع عبر `gh` (المصادقة مطلوبة). `--dry-run` للمعاينة.

القناة المحلية تقبل نمطي تسمية المثبّت: `Loam-Setup-*` و`manus-local-Setup-*` (مع blockmap وlatest.yml فقط — لا شيء آخر يُقدَّم).
