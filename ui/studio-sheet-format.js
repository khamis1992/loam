const column=n=>{let s='';do{s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)-1;}while(n>=0);return s;};
export function sheetLayoutTools(sheet,cell){return `<div class="office-sheet-format" role="group" aria-label="تخطيط الخلية"><label>المحاذاة الأفقية <select data-sheet-horizontal><option value="general">تلقائي</option><option value="left">يسار</option><option value="center">توسيط</option><option value="right">يمين</option><option value="justify">ضبط</option></select></label><label>ارتفاع الصف (نقطة) <input data-sheet-dimension="rowHeights" aria-label="ارتفاع الصف" type="number" min="1" max="409" step="0.5" value="${Number(sheet.rowHeights?.[cell[0]]||20)}"></label><label>عرض العمود <input data-sheet-dimension="columnWidths" aria-label="عرض العمود" type="number" min="1" max="255" step="0.5" value="${Number(sheet.columnWidths?.[cell[1]]||12)}"></label></div>`;}
export function setSheetDimension(sheet,cell,key,value){
 if(!['rowHeights','columnWidths'].includes(key)||!Number.isFinite(value)||value<1||value>(key==='rowHeights'?409:255))throw Error('أدخل مقاسًا صالحًا؛ لم يُطبّق التغيير.');
 const index=cell[key==='rowHeights'?0:1],fallback=key==='rowHeights'?20:12;
 sheet[key]||=[];while(sheet[key].length<=index)sheet[key].push(fallback);sheet[key][index]=value;
}
export function formatSheetValue(value,style){
 if(value===''||!Number.isFinite(Number(value)))return value;const n=Number(value),format=style?.numberFormat;
 if(format==='0.0%')return (n*100).toFixed(1)+'%';
 if(format==='yyyy-mm-dd'&&n>=1&&n<=2958465){if(Math.floor(n)===60)return '1900-02-29';return new Date(Date.UTC(1899,11,n<60?31:30)+Math.floor(n)*86400000).toISOString().slice(0,10);}
 if(format==='#,##0.00'||format==='#,##0')return n.toLocaleString('en-US',{minimumFractionDigits:format.endsWith('.00')?2:0,maximumFractionDigits:format.endsWith('.00')?2:0});
 return value;
}
export function sheetFormatTools(imported,format={}){const color=(key,fallback)=>/^#[a-f0-9]{6}$/i.test(format[key]||'')?format[key]:fallback;return `<div class="office-sheet-format" role="group" aria-label="تنسيق الخلية"><button type="button" data-sheet-format="bold" ${imported?'disabled':''}>غامق</button><button type="button" data-sheet-format="italic" ${imported?'disabled':''}>مائل</button><button type="button" data-sheet-format="wrapText" aria-pressed="${!!format.wrapText}">التفاف النص</button><select aria-label="المحاذاة العمودية" data-sheet-alignment><option value="top" ${format.verticalAlignment==='top'?'selected':''}>أعلى</option><option value="middle" ${format.verticalAlignment==='middle'?'selected':''}>وسط</option><option value="bottom" ${!format.verticalAlignment||format.verticalAlignment==='bottom'?'selected':''}>أسفل</option></select><label>لون النص <input type="color" data-sheet-color="color" value="${color('color','#182332')}" ${imported?'disabled':''}></label><label>التعبئة <input type="color" data-sheet-color="background" value="${color('background','#ffffff')}" ${imported?'disabled':''}></label><select aria-label="تنسيق الرقم" data-sheet-number ${imported?'disabled':''}><option value="General">عام</option><option value="#,##0.00">رقم عشري</option><option value="0.0%">نسبة مئوية</option><option value="#,##0">رقم مفصول</option><option value="yyyy-mm-dd">تاريخ</option></select><button type="button" data-sheet-format="professional" ${imported?'disabled title="القالب متاح للأوراق الجديدة حاليًا"':''}>تنسيق جدول احترافي</button></div>`.replace(`value="${format.numberFormat||'General'}">`,`value="${format.numberFormat||'General'}" selected>`);}
export function sheetFormatAction(sheet,cell,key,value){
 sheet.styles||={};const address=column(cell[1])+(cell[0]+1),style=sheet.styles[address]||={};
 if(key==='professional'){
  const width=Math.max(0,...sheet.cells.map(r=>r.length));
  sheet.cells.forEach((row,r)=>row.forEach((text,c)=>{sheet.styles[column(c)+(r+1)]={...sheet.styles[column(c)+(r+1)],fontFamily:'Arial',fontSize:11,bold:r===0,color:r===0?'#FFFFFF':'#182332',background:r===0?'#173F43':r%2?'#EEF5F4':'#FFFFFF'};}));
  sheet.columnWidths=Array.from({length:width},(_,c)=>Math.max(16,Math.min(42,Math.max(...sheet.cells.map(r=>String(r[c]||'').length))+3)));sheet.rowHeights=sheet.cells.map((_,r)=>r===0?30:24);return;
 }
 if(key==='bold'||key==='italic'||key==='wrapText')style[key]=!style[key];else style[key]=value;
}
