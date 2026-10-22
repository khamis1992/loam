/** Parse tabular clipboard text, including quoted tabs/newlines and doubled quotes. */
export function clipboardRows(text){
 if(typeof text!=='string'||text.length>5000000)throw Error('حجم البيانات المنسوخة أكبر من الحد المدعوم.');
 const rows=[];let row=[],field='',quoted=false,closed=false;
 const push=()=>{if(field.length>10000||row.length>=100)throw Error('تجاوز اللصق حد طول الخلية أو عدد الأعمدة.');row.push(field);field='';closed=false;};
 const end=()=>{push();if(rows.length>=2000)throw Error('تجاوز اللصق حد 2000 صف.');rows.push(row);row=[];};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='\t'){push();continue;}
  if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;end();continue;}
  if(closed)throw Error('تنسيق بيانات الحافظة غير صالح.');
  if(c==='"'&&field===''){quoted=true;continue;}field+=c;
 }
 if(quoted)throw Error('النص المنسوخ يحتوي على اقتباس غير مغلق.');
 if(field!==''||row.length||!rows.length||closed)end();
 const width=Math.max(...rows.map(r=>r.length));return rows.map(r=>[...r,...Array(width-r.length).fill('')]);
}
const index=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
/** Paste into visible cells only. Validate everything before changing the worksheet. */
export function pasteSheetRange(sheet,start,text){
 const values=clipboardRows(text),visible=(from,count,hidden,limit)=>{const out=[];if(!Number.isInteger(from)||from<0)throw Error('موضع اللصق غير صالح.');for(let n=from;n<limit&&out.length<count;n++)if(!hidden?.[n])out.push(n);if(out.length!==count)throw Error('يتجاوز اللصق حدود الورقة: 2000 صف و100 عمود.');return out;};
 const rows=visible(start[0],values.length,sheet.hiddenRows,2000),cols=visible(start[1],values[0].length,sheet.hiddenColumns,100);
 for(const range of sheet.merges||[]){const m=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);if(!m)continue;const left=index(m[1]),right=index(m[3]),top=+m[2]-1,bottom=+m[4]-1;if(rows.some(r=>r>=top&&r<=bottom)&&cols.some(c=>c>=left&&c<=right)&&!(rows.length===1&&cols.length===1&&rows[0]===top&&cols[0]===left))throw Error('يتقاطع نطاق اللصق مع خلايا مدمجة. اختر نطاقًا غير مدمج.');}
 const cells=sheet.cells.map(row=>[...row]);for(let r=0;r<rows.length;r++){while(cells.length<=rows[r])cells.push([]);const row=cells[rows[r]];for(let c=0;c<cols.length;c++){while(row.length<=cols[c])row.push('');row[cols[c]]=values[r][c];}}
 sheet.cells=cells;return {rows:rows.length,columns:cols.length,first:[rows[0],cols[0]]};
}
