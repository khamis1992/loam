---
name: rork-mobile-builder
description: استخدم هذه المهارة عند طلب بناء أو تصميم تطبيق جوال (iOS / Android / Expo React Native / SwiftUI / Kotlin Compose) مع وضع التصميم ذي الـ3 شاشات والمحاكي التفاعلي الحي ورمز QR Code لمعاينة الجوال على غرار منصة Rork.com.
---

# بناء تطبيقات الجوال الاحترافية (بمعمارية Rork.com Mobile Studio)

استخدم هذه المهارة دائماً عندما يطلب المستخدم إنشاء **تطبيق جوال / موبايل / آيفون / أندرويد / Expo / React Native / SwiftUI / Kotlin**.

## 1. المراحل الإلزامية لبناء تطبيق الجوال (منهج Rork ثلاثي المراحل)

1. **المرحلة الأولى — تحديد الهوية البصرية والمعمارية (Layout & Color Mood)**:
   - اختر الطابع اللوني المتناسق لتطبيق الجوال (مثل: `Deep midnight with neon lime` `#0A0E17` + `#B8FF01`، أو `Warm sunrise oranges on cream` `#FFF7ED` + `#FF6B2C`، أو `Soft sage and calm greens` `#ECF3EE` + `#3D7A5A`، أو `Arabic Desert Oasis` `#0D1514` + `#2DD4BF`).
   - صمّم الشاشة الرئيسية بهرمية واضحة: **عداد إنجاز/مؤشر رئيسي بارز (Hero Metric/Streak Counter)** أعلى القائمة التفاعلية، وزر إضافة سفلي واضح، وشريط تبويب سفلي (`Bottom Tab Bar`) بثلاثة تبويبات (`اليوم/الرئيسية`، `الإحصائيات`، `حسابي`).

2. **المرحلة الثانية — وضع التصميم ثلاثي الشاشات (`Design Mode — 3 Mobile Screens`)**:
   - ابنِ 3 شاشات جوال متكاملة داخل إطارات هاتف حقيقية (`393×852` مع شريط الحالة العلوي `9:41` ومؤشر البطارية `100` وشريط التنقل السفلي):
     1. **شاشة اليوم / القائمة الرئيسية (`Today / Home`)**: العداد الرئيسي + قائمة المهام/العناصر القابلة للنقر والتأشير الحي + زر `+ إضافة`.
     2. **شاشة النافذة المنبثقة السفلية (`New Item Bottom Sheet Modal`)**: حقل الاسم + شبكة اختيار الأيقونة (8 أيقونات) + أزرار أيام التكرار (`M T W T F S S`) + زر الحفظ.
     3. **شاشة الإحصائيات (`Stats / Analytics`)**: مخطط أعمدة الإنجاز الأسبوعي (`This week %`) + شبكة النشاط الشهري (31 يوماً) + قائمة أطول سلاسل الإنجاز (`Top Streaks`).

3. **المرحلة الثالثة — الكود متعدد المنصات + المحاكي التفاعلي + رمز QR للجوال (`Build & Live Simulator`)**:
   - أنشئ مجلد المشروع داخل `workspace/<project-id>/` شاملاً:
     - ملفات **Expo Router / React Native** (`package.json`, `app.json`, `eas.json`, `app/_layout.tsx`, `app/(tabs)/index.tsx`, `app/(tabs)/stats.tsx`, `app/modal.tsx`).
     - ملفات **iOS SwiftUI** (`ios/App.swift`, `ios/ContentView.swift`) و**Android Kotlin Compose** (`android/app/src/main/java/.../MainActivity.kt`).
     - واجهة المحاكي التفاعلي الحي (`index.html`) والنسخة المستقلة للجوال (`mobile.html` + `manifest.json`) مع بطاقة **`Test on your phone` (QR Code + `exp://`)**.
   - شغّل `preview_serve` على مجلد المشروع، ثم افتح المعاينة بـ `browser_open` والتقط `browser_screenshot` للتحقق من عمل الشاشات الثلاث والمحاكي التفاعلي بدون أي أخطاء.
