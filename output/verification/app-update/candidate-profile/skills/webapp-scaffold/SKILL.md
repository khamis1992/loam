---
name: webapp-scaffold
description: استخدم هذه المهارة عند إنشاء موقع أو تطبيق ويب أو صفحة HTML جديدة من الصفر بمعايير تصميم Lovable الاحترافية.
---

# موقع/تطبيق ويب احترافي من الصفر (معايير Lovable Studio)

## القواعد الإلزامية
1. لا تفترض محتوى المشروع: ابدأ بـ `file_list` على مساحة العمل، وأنشئ مجلداً واضح الاسم `workspace/<project-name>/`.
2. **نظام التصميم الدلالي بفضاء `oklch()` (ممنوع الألوان الخام العشوائية)**:
   - عرّف في `:root` و`.dark` متغيرات لونية متناغمة بفضاء `oklch()`:
     `--background`, `--foreground`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--brand-alt`, `--surface-warm`, `--overlay`, `--border`, `--ring`, `--radius: 1rem`.
   - استخدم خلفيات دافئة/ناعمة (`oklch(96.5% 0.012 80)`) وحبراً داكناً متناغماً (`oklch(22% 0.025 50)`) بدلاً من `#ffffff` و`#000000`.
3. **التزاوج الطباعي التحريري (`--font-display` + `--font-sans`)**:
   - حمّل خطوط Google Fonts مناسبة للمجال (`Fraunces` + `Manrope` للإنجليزية، و`Readex Pro` + `Tajawal` للعربية مع `dir="rtl" lang="ar"`).
   - التزم بالهرمية الرباعية: سطر علوي متباعد الأحرف (`Eyebrow`) + عنوان رئيسي كبير مع عبارة مائلة ملونة (`<em class="text-accent">`) + أرقام ومؤشرات بـ`--font-display` + تسميات حقول مصغرة.
4. **التخطيط غير المتماثل والتفاعلية الحية**:
   - ترويسة زجاجية لاصقة (`backdrop-filter: blur(14px)`).
   - شبكة استوديو غير متماثلة (`1.4fr 1fr`) أو شبكة Bento ببطاقات `border-radius: 1.5rem` وحركات `cubic-bezier(0.22, 1, 0.36, 1)`.
   - أضف تفاعلية حقيقية (تخصيص حي، مؤشرات تتحدث فوراً، أزرار `Tweak` و`Add`، ودرج جانبي منزلق للملخص).
5. **التحقق الإلزامي قبل التسليم (Self-Check & Auto-Heal)**:
   - شغّل `preview_serve` ثم افتح الصفحة بـ `browser_open` والتقط `browser_screenshot`.
   - تحقق برمجياً عبر `browser_eval` من عدم وجود شاشة فارغة أو أخطاء JS، وأصلح أي خلل قبل تسليم النتيجة.
