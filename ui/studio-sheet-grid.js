import {borderCss} from './studio-sheet-borders.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colIndex=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
export function generalAlignment(value){const text=String(value??'');return text.trim()!==''&&Number.isFinite(Number(text))||/^[^A-Za-z\u0590-\u08ff]*[\u0590-\u08ff]/.test(text)?'right':'left';}
export function alignGridCell(field,value){if(field?.parentElement?.dataset.autoAlign==='true')field.parentElement.style.textAlign=generalAlignment(value);}
export function updateGridCell(field,value){
 if(!field)return;
 if(field.tagName==='INPUT'&&value.includes('\n')){const multiline=document.createElement('textarea');for(const attr of field.attributes)if(attr.name!=='value')multiline.setAttribute(attr.name,attr.value);multiline.rows=1;multiline.style.whiteSpace='pre-wrap';field.replaceWith(multiline);field=multiline;}
 field.value=value;
}
/** Visible coordinates and logical cell coordinates remain distinct for merged ranges. */
export function sheetGrid(sheet,{column,formula,format,style}){
 const width=Math.min(100,Math.max(6,...sheet.cells.map(row=>row.length))),height=sheet.cells.length;
 const rows=Array.from({length:height},(_,i)=>i).filter(i=>!sheet.hiddenRows?.[i]);
 const columns=Array.from({length:width},(_,i)=>i).filter(i=>!sheet.hiddenColumns?.[i]);
 const merged=new Map();let area=0;
 for(const range of sheet.merges||[]){
  const m=/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);if(!m)continue;
  const left=colIndex(m[1]),right=colIndex(m[3]),top=+m[2]-1,bottom=+m[4]-1;
  if(left<0||right>=100||top<0||bottom>=2000||left>right||top>bottom)continue;
  area+=(right-left+1)*(bottom-top+1);if(area>200000)break;
  const visibleRows=rows.filter(r=>r>=top&&r<=bottom),visibleCols=columns.filter(c=>c>=left&&c<=right);
  if(!visibleRows.length||!visibleCols.length)continue;
  const anchor={row:top,col:left,rowSpan:visibleRows.length,colSpan:visibleCols.length};
  for(const r of visibleRows)for(const c of visibleCols)merged.set(`${r},${c}`,r===visibleRows[0]&&c===visibleCols[0]?anchor:false);
 }
 const colWidth=c=>Math.max(70,Number(sheet.columnWidths?.[c]||12)*7);
 const body=rows.map(r=>`<tr style="${sheet.rowHeights?.[r]?'height:'+Number(sheet.rowHeights[r])+'pt':''}"><th scope="row">${r+1}</th>${columns.map(c=>{
  const merge=merged.get(`${r},${c}`);if(merge===false)return '';
  const row=merge?.row??r,col=merge?.col??c,address=column(col)+(row+1),cellStyle=sheet.styles?.[address];
  const resolved=formula(sheet.cells,row,col),value=format(resolved,cellStyle),multiline=cellStyle?.wrapText||String(value).includes('\n');
  const attrs=`data-cell="${row},${col}" aria-label="${address}" ${merge?'aria-description="خلية مدمجة"':''} ${String(sheet.cells[row]?.[col]||'').startsWith('=')?'class="has-formula"':''}`;
  const vertical=['top','middle','bottom'].includes(cellStyle?.verticalAlignment)?cellStyle.verticalAlignment:'bottom';
  const field=multiline?`<textarea rows="1" style="${esc(style(cellStyle))};white-space:${cellStyle?.wrapText?'pre-wrap':'pre'}" ${attrs}>${esc(value)}</textarea>`:`<input style="${esc(style(cellStyle))}" ${attrs} value="${esc(value)}">`;
  return `<td data-auto-align="${!cellStyle?.alignment||cellStyle.alignment==='general'}" ${merge?`rowspan="${merge.rowSpan}" colspan="${merge.colSpan}"`:''} style="text-align:${generalAlignment(resolved)};${esc(style(cellStyle))};vertical-align:${vertical};${borderCss(cellStyle)}">${field}</td>`;
 }).join('')}</tr>`).join('');
 const hiddenRows=height-rows.length,hiddenCols=width-columns.length;
 return `${hiddenRows||hiddenCols?`<p class="office-hidden-dimensions">يحافظ العرض على إخفاء ${hiddenRows} صف و${hiddenCols} عمود كما في الملف؛ اللصق يتخطى الخلايا المخفية.</p>`:''}<div class="office-grid-scroll"><table class="office-grid" dir="ltr" aria-label="جدول البيانات"><colgroup><col style="width:42px">${columns.map(c=>`<col style="width:${colWidth(c)}px">`).join('')}</colgroup><thead><tr><th></th>${columns.map(c=>`<th scope="col">${column(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
