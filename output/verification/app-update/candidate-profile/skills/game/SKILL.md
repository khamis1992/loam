---
name: game
description: استخدمها عند طلب صنع لعبة بسيطة أو نموذج أولي للألعاب.
---

# لعبة ويب بسيطة

## القواعد
1. HTML5 + Canvas 2D + JavaScript خالص (بلا مكتبات).
2. ملف واحد `index.html` إن أمكن، أو `index.html` + `game.js`.
3. أساسيات: حلقة لعبة (requestAnimationFrame)، حالة (state)، مدخلات (لوحة مفاتيح/لمس)، تصادم، نقاط، إعادة تشغيل.
4. اجعلها تلعب فوراً: من 30-60 ثانية تجربة، صعوبة متدرجة.
5. **التحقق**: `preview_serve` ثم افتح المتصفح وتحقق من عدم وجود أخطاء:
   `browser_open` + `browser_eval { expression: "window.__errors ? window.__errors.join(';') : 'no-errors'" }`
   (أضف في اللعبة: `window.__errors=[];window.onerror=e=>window.__errors.push(String(e))`).
6. وثّق أزرار التحكم أعلى الصفحة.
