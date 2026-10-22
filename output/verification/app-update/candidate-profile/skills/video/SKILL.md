---
name: video
description: استخدمها عند طلب مونتاج/صنع فيديو أو تسلسل متحرك.
---

# فيديو ورسوم متحركة

## القواعد
1. **تحقق من الإمكانات أولاً**: `shell_run { command: "where ffmpeg" }`
2. **إن توفّر ffmpeg**: أنشئ المقطع من صور/صوت (image2 → mp4) داخل `workspace/video/`:
   - `ffmpeg -framerate 30 -i frames/%04d.png -c:v libx264 -pix_fmt yuv420p out.mp4`
3. **إن لم يتوفر**: أنشئ **رسوم متحركة HTML/CSS/Canvas** (storyboard متحرك) واعرضها بـ `preview_serve`،
   ووثّق قائمة المشاهد (scenes) والمدد وملفات الصور المطلوبة.
4. لا تعد بمونتاج ثقيل بلا أدوات؛ اشرح البديل واطلب تثبيت ffmpeg إن لزم.
5. التحقق: افتح المعاينة (أو شغّل ffmpeg وتحقق من وجود الملف وحجمه > 0).
