---
name: website
description: استخدمها عند طلب بناء موقع أو صفحة ويب أو تطبيق ويب بتصميم احترافي بمستوى Lovable.dev.
---

# موقع/تطبيق ويب احترافي (معايير Lovable Studio)

## القواعد
1. تحقق أولاً بـ `file_list` على مساحة العمل، ثم أنشئ مجلداً باسم المشروع.
2. **نظام التصميم الدلالي (`oklch()` Semantic Tokens)**:
   - استخدم متغيرات `:root` و`.dark` بفضاء `oklch()` (`--background`, `--foreground`, `--card`, `--primary`, `--accent`, `--muted`, `--brand-alt`, `--border`, `--radius: 1rem`).
   - زاوج بين خط عرض تحريري (`--font-display`: `Fraunces` / `Playfair Display` / `Space Grotesk` / `Readex Pro`) وخط نصي (`--font-sans`: `Manrope` / `Plus Jakarta Sans` / `Tajawal`).
3. **الهيكل البصري والتفاعلي**:
   - ترويسة زجاجية لاصقة + قسم بطل (`Hero`) بوسم علوي (`Eyebrow`) وعنوان كبير مع عبارة مائلة ملونة (`<em class="text-accent">`).
   - تخطيط غير متماثل (`1.4fr 1fr`) أو بطاقات Bento بحواف دائرية سخية (`1.5rem`) ومؤشرات بصرية حية تتحرك بـ `cubic-bezier(0.22, 1, 0.36, 1)`.
   - دعم كامل للعربية (`dir="rtl" lang="ar"`) عند الطلب، وبيانات SEO/OpenGraph كاملة في `<head>`.
4. **التحقق الإلزامي**: `preview_serve {dir:"<project>"}` ثم `browser_open` + `browser_screenshot` + `browser_eval` للتأكد من عمل التفاعلات وخلو الصفحة من الأخطاء.
