export function sourceChartTools(slide,esc){return (slide.sourceCharts||[]).map((chart,i)=>`<details class="office-chart-controls"><summary>المخطط الأصلي ${i+1} · ${esc(chart.title||'البيانات')}</summary><p>تُحفظ البيانات في المخطط وجدوله المضمّن. يبقى التصميم ومقياس المحاور الأصليان، وتتجدد المعاينة بعد الحفظ.</p><div class="document-table-scroll"><table><thead><tr><th>الفئة</th>${chart.series.map((s,j)=>`<th><input aria-label="اسم السلسلة الأصلية ${j+1}" maxlength="500" data-source-chart="${i}" data-source-chart-prop="name" data-series="${j}" value="${esc(s.name)}"></th>`).join('')}</tr></thead><tbody>${chart.labels.map((label,k)=>`<tr><td><input aria-label="الفئة الأصلية ${k+1}" maxlength="500" data-source-chart="${i}" data-source-chart-prop="label" data-category="${k}" value="${esc(label)}"></td>${chart.series.map((s,j)=>`<td><input type="number" step="any" required min="-1000000000000" max="1000000000000" aria-label="قيمة أصلية ${k+1} سلسلة ${j+1}" data-source-chart="${i}" data-source-chart-prop="value" data-category="${k}" data-series="${j}" value="${s.values[k]}"></td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`).join('');}
export function sourceChartInput(field,slide){
 if(!field.matches('[data-source-chart]'))return false;
 const chart=slide.sourceCharts?.[Number(field.dataset.sourceChart)],key=field.dataset.sourceChartProp,j=Number(field.dataset.series),k=Number(field.dataset.category);
 if(!chart)return false;
 const previous=key==='value'?chart.series[j]?.values[k]:key==='label'?chart.labels[k]:chart.series[j]?.name;
 if(!field.checkValidity()||key==='value'&&!field.value.trim()){field.value=previous;throw Error('أدخل قيمة صالحة لبيانات المخطط.');}
 if(key==='value')chart.series[j].values[k]=Number(field.value);else if(key==='label')chart.labels[k]=field.value;else if(key==='name')chart.series[j].name=field.value;else return false;
 return true;
}
