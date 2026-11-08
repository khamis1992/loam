import { createHash } from 'node:crypto';
import { desktopPreviewScript } from '../desktop/previewPage.js';
import { visibleBriefHtml } from '../planProvenance.js';
import { widgetPortableLabel } from './autostartPolicy.js';

export const WIDGET_PREVIEW_SECONDS = 300;

const WIDGET_DRAG_CSS = '#drag{-webkit-app-region:drag;app-region:drag;min-height:32px}#note,#export,#autostart,#autostart-toggle,#countdown{-webkit-app-region:no-drag;app-region:no-drag}';

function widgetContentSecurityPolicy(): string {
  const hash = createHash('sha256').update(WIDGET_DRAG_CSS).digest('base64');
  return `default-src 'none'; script-src 'self'; style-src 'self' 'sha256-${hash}'; img-src 'self' data:`;
}

export function widgetPreviewHtml(brief = ''): string {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${widgetContentSecurityPolicy()}"><title>ويدجت</title><style>${WIDGET_DRAG_CSS}</style><header id="drag"><h1>ملاحظة محلية</h1></header>${visibleBriefHtml(brief)}<p id="autostart"><input id="autostart-toggle" type="checkbox" disabled> بدء هذا الويدجت مع دخول Windows غير متاح في النسخة المحمولة حتى يُثبَّت بمسار ثابت.</p><p id="portable-export">${widgetPortableLabel()}</p><p id="countdown" aria-label="عد تنازلي">300</p><textarea id="note" aria-label="ملاحظة"></textarea><p id="empty">لا توجد ملاحظة بعد</p><p id="save-error" hidden></p><textarea id="export" hidden aria-label="نسخة النص"></textarea><script src="./preview.js"></script></html>`;
}

export function widgetPreviewScript(): string {
  return `${desktopPreviewScript()}
const countdown=document.querySelector('#countdown');
const duration=${WIDGET_PREVIEW_SECONDS};
const started=Date.now();
let timer=null;
function renderCountdown(){
  if(timer===null) return;
  const left=Math.max(0,duration-Math.floor((Date.now()-started)/1000));
  countdown.textContent=String(left);
  if(left===0) stopCountdown();
}
function stopCountdown(){
  if(timer===null) return;
  clearInterval(timer);
  timer=null;
}
timer=setInterval(renderCountdown,1000);
renderCountdown();
window.addEventListener('pagehide',stopCountdown,{once:true});
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='hidden') stopCountdown();
});
`;
}
