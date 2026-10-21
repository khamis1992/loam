---
name: lovable-builder
description: استخدم هذه المهارة لبناء تطبيقات ويب وواجهات مستخدم احترافية بمعايير Lovable.dev (نظام ألوان oklch الدلالي، تزاوج الخطوط التحريرية، التخطيط غير المتماثل، وسم data-tsd-source، والفحص البصري الذاتي).
---

# بناء التطبيقات والواجهات الاحترافية بمعايير Lovable (`lovable-builder`)

## القواعد الإلزامية لجودة التصميم (وكالة تصميم 10/10)

1. **منع الألوان الخام واستخدام متغيرات `oklch()` الدلالية في `:root` و`.dark`**:
   - **يُمنع** استخدام `#ffffff` أو `#000000` أو ألوان افتراضية فاقعة مباشرة على العناصر.
   - عرّف دائماً في `:root` لوحة دلالية متناغمة بفضاء `oklch`:
     - `--background`: خلفية دافئة/ناعمة (مثل `oklch(96.5% 0.012 80)` أو `oklch(97.5% 0.008 145)`).
     - `--foreground`: حبر داكن متناغم (`oklch(22% 0.025 50)`).
     - `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`.
     - رموز مخصصة لمجال التطبيق (`--brand-alt` / `--matcha`, `--surface-warm` / `--crema`, `--overlay`).
2. **التزاوج الطباعي التحريري (`--font-display` + `--font-sans`)**:
   - للإنجليزية: زاوج بين خط عرض تحريري (`Fraunces` أو `Playfair Display` أو `Space Grotesk`) وخط نصي هندسي (`Manrope` أو `Plus Jakarta Sans`).
   - للعربية (`dir="rtl"`): زاوج بين `Readex Pro` أو `Amiri` للعناوين والأرقام الكبرى (`--font-display`) وبين `Tajawal` للنصوص (`--font-sans`).
   - طبّق هرمية طباعية من 4 مستويات:
     1. **سطر علوي (Eyebrow)**: `font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.25em; color: var(--brand-alt)`.
     2. **عنوان بطل (Hero Headline)**: `font-family: var(--font-display); font-size: clamp(2.5rem, 5vw, 4.25rem); line-height: 1.08` مع عبارة مائلة ملونة `<em style="color:var(--accent)">...</em>`.
     3. **أرقام ومؤشرات كبرى**: `font-family: var(--font-display); font-size: 1.875rem`.
     4. **تسميات الحقول الفرعية**: `font-size: 0.75rem; letter-spacing: 0.1em; color: var(--muted-foreground)`.
3. **التخطيط غير المتماثل (Asymmetric Studio / Bento Grid) + عنصر بصري حي**:
   - ترويسة زجاجية لاصقة (`position: sticky; top: 0; backdrop-filter: blur(14px)`).
   - شبكة استوديو غير متماثلة (`grid-template-columns: 1.4fr 1fr`): لوحة التخصيص/التحكم ببطاقة `border-radius: 1.5rem; padding: 2rem` + بطاقة معاينة ومؤشرات حية لاصقة (`position: sticky; top: 6rem`).
   - عنصر بصري تفاعلي حي (مؤشرات تقدم / رسم تفاعلي) يتحرك بنعومة `cubic-bezier(0.22, 1, 0.36, 1)` فور تغيير أي خيار.
   - درج جانبي منزلق (`Slide-over Drawer`) لعرض الملخص أو السلة مع طبقة خلفية ضبابية (`--overlay`).
4. **وسم العناصر (`data-tsd-source`) + بيانات SEO وOpenGraph + الفحص البصري**:
   - أضف `<title>`, `<meta name="description">`, `og:title`, `og:description`, `twitter:card`.
   - بعد البناء: شغّل `preview_serve` وافتح الصفحة بالمتصفح والتقط `browser_screenshot` وتأكد من خلو `console` من أي خطأ ومن جمالية التباين والمحاذاة.
