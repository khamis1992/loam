export const colorFields=[['brightness','السطوع',0,2,1],['contrast','التباين',0,2,1],['saturation','التشبع',0,3,1],['hue','تدوير اللون',-180,180,0]];
export function validateColor(c){
 if(c.colorAdjust===undefined)return;
 const a=c.colorAdjust;if(!a||typeof a!=='object'||Array.isArray(a)||!['image','video'].includes(c.kind))throw Error('إعدادات اللون غير صالحة.');
 for(const key of Object.keys(a))if(key!=='enabled'&&!colorFields.some(f=>f[0]===key))throw Error('خاصية لون غير معروفة.');
 if(a.enabled!==undefined&&typeof a.enabled!=='boolean')throw Error('حالة اللون غير صالحة.');
 for(const [key,,min,max]of colorFields)if(a[key]!==undefined&&(typeof a[key]!=='number'||!Number.isFinite(a[key])||a[key]<min||a[key]>max))throw Error('قيمة اللون خارج الحدود.');
}
export function colorFilter(c){const a=c.colorAdjust;if(!a||a.enabled===false)return 'none';return `brightness(${a.brightness??1}) contrast(${a.contrast??1}) saturate(${a.saturation??1}) hue-rotate(${a.hue??0}deg)`;}
export function colorPanel(c){if(!['image','video'].includes(c.kind))return '';const a=c.colorAdjust||{};return `<section aria-label="تصحيح لون المقطع"><h3>لون المقطع</h3><label><input type="checkbox" data-color-enabled ${a.enabled!==false?'checked':''}>تطبيق تعديلات اللون</label>${colorFields.map(([key,label,min,max,value])=>`<label>${label}<input type="number" data-color-field="${key}" min="${min}" max="${max}" step="${key==='hue'?1:.05}" value="${a[key]??value}"></label>`).join('')}<button data-color-reset>إعادة ضبط اللون</button></section>`;}
