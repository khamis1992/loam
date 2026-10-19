package app.loam.generated

import android.content.SharedPreferences
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.Instant
import java.util.UUID
import java.util.Locale

private fun objects(array:JSONArray)= (0 until array.length()).map{array.getJSONObject(it)}
private fun records(state:JSONObject,id:String)=objects(state.getJSONObject("collections").optJSONArray(id)?:JSONArray())
private fun readRecords(prefs:SharedPreferences):JSONObject{val state=JSONObject(prefs.getString("records","{\"version\":1,\"revision\":0,\"collections\":{}}")!!);require(state.getInt("version")==1&&state.getLong("revision")>=0);val all=state.getJSONObject("collections");for(key in all.keys()){val rows=objects(all.getJSONArray(key));require(rows.map{it.getString("id")}.toSet().size==rows.size);for(row in rows){row.getString("createdAt");row.getString("updatedAt");if(row.has("deletedAt"))row.getString("deletedAt");val values=row.getJSONObject("values");for(field in values.keys()){val value=values.get(field);require(value is String||value is Number||value is Boolean)}}};return state}
private fun label(schema:JSONObject,row:JSONObject)=row.getJSONObject("values").optString(schema.getString("titleField"),schema.getString("singular"))
fun relationLabel(schema:JSONObject,row:JSONObject,rows:List<JSONObject>):String{
 val title=label(schema,row);val peers=rows.filter{!it.has("deletedAt")&&label(schema,it)==title}
 if(peers.size<2)return title
 val fields=objects(schema.getJSONArray("fields")).filter{it.getString("id")!=schema.getString("titleField")&&it.getString("type")!in listOf("relation","boolean")}.sortedBy{if(it.getString("id")==schema.optString("subtitleField"))0 else 1}
 fun detail(r:JSONObject):String{val values=r.getJSONObject("values");return fields.filter{values.has(it.getString("id"))&&values.optString(it.getString("id"))!=""}.take(2).joinToString(" · "){it.getString("label")+": "+values.optString(it.getString("id")).take(70)}}
 val context=detail(row);val text=title+if(context.isNotEmpty())" — "+context else ""
 return if(peers.count{detail(it)==context}>1)text+" · #"+row.getString("id") else text
}
fun validateValues(schema:JSONObject,values:JSONObject,state:JSONObject,excludeId:String?=null):Pair<JSONObject,Map<String,String>>{
 val clean=JSONObject();val errors=mutableMapOf<String,String>()
 for(f in objects(schema.getJSONArray("fields"))){val id=f.getString("id");val type=f.getString("type");val value=values.optString(id,"").trim()
  if(type=="boolean"){clean.put(id,values.optBoolean(id,false));continue}
  if(value.isEmpty()){if(f.optBoolean("required"))errors[id]="هذا الحقل مطلوب" else clean.put(id,"");continue}
  when(type){
   "number"->{val n=value.toDoubleOrNull();if(!Regex("[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?").matches(value)||n==null||!n.isFinite()||kotlin.math.abs(n)>1e12)errors[id]="أدخل رقمًا صالحًا" else if(f.optBoolean("integer")&&n%1.0!=0.0)errors[id]="أدخل عددًا صحيحًا" else if(f.has("min")&&n<f.getDouble("min"))errors[id]="أقل قيمة مسموحة: "+f.get("min") else if(f.has("max")&&n>f.getDouble("max"))errors[id]="أكبر قيمة مسموحة: "+f.get("max") else clean.put(id,n)}
   "date"->{try{if(!Regex("\\d{4}-\\d{2}-\\d{2}").matches(value)||LocalDate.parse(value).toString()!=value)throw Exception();clean.put(id,value)}catch(e:Exception){errors[id]="أدخل تاريخًا صالحًا"}}
   "select"->{val options=f.getJSONArray("options");if((0 until options.length()).none{options.getString(it)==value})errors[id]="اختر قيمة من القائمة" else clean.put(id,value)}
   "relation"->{if(records(state,f.getString("collectionId")).none{it.getString("id")==value&&!it.has("deletedAt")})errors[id]="السجل المرتبط غير متاح" else clean.put(id,value)}
   else->{if(value.length>2000)errors[id]="الحد الأقصى 2000 حرف" else clean.put(id,value)}
  }
 }
 fun empty(v:JSONObject,id:String)=!v.has(id)||v.isNull(id)||v.optString(id)==""
 fun matches(rule:JSONObject,v:JSONObject):Boolean{val condition=rule.optJSONObject("when")?:return true;return v.opt(condition.getString("field"))==condition.get("equals")}
 val fields=objects(schema.getJSONArray("fields"))
 for(rule in objects(schema.optJSONArray("rules")?:JSONArray())){
  if(rule.getString("type")=="compare"){
   val left=rule.getString("field");val right=rule.getString("otherField")
   if(!errors.containsKey(left)&&!errors.containsKey(right)&&!empty(clean,left)&&!empty(clean,right)){
    val order=if(fields.first{it.getString("id")==left}.getString("type")=="number")clean.getDouble(left).compareTo(clean.getDouble(right))else clean.getString(left).compareTo(clean.getString(right))
    if(if(rule.getString("operator")=="gt")order<=0 else order<0)errors[left]=rule.getString("message")
   }
  }else{
   val ids=rule.getJSONArray("fields");val keys=(0 until ids.length()).map{ids.getString(it)}
   fun equal(id:String,a:JSONObject,b:JSONObject):Boolean{val field=fields.first{it.getString("id")==id};return if(field.getString("type")=="number")a.optDouble(id)==b.optDouble(id)else if(field.getString("type")=="boolean")a.optBoolean(id)==b.optBoolean(id)else a.optString(id).trim().lowercase(Locale.ROOT)==b.optString(id).trim().lowercase(Locale.ROOT)}
   if(matches(rule,clean)&&keys.none{errors.containsKey(it)||empty(clean,it)}&&records(state,schema.getString("id")).any{row->val v=row.getJSONObject("values");row.getString("id")!=excludeId&&!row.has("deletedAt")&&matches(rule,v)&&keys.all{!empty(v,it)&&equal(it,clean,v)}})errors[keys.first()]=rule.getString("message")
  }
 }
 return clean to errors
}

@Composable fun CollectionView(schema:JSONObject,schemas:List<JSONObject>,prefs:SharedPreferences){
 val focus=LocalFocusManager.current;val keyboard=LocalSoftwareKeyboardController.current
 val collectionId=schema.getString("id");val singular=schema.getString("singular");val fields=objects(schema.getJSONArray("fields"))
 var tick by remember{mutableIntStateOf(0)};var query by rememberSaveable(collectionId){mutableStateOf("")};var trash by rememberSaveable(collectionId){mutableStateOf(false)};var filter by rememberSaveable(collectionId){mutableStateOf("")}
 DisposableEffect(prefs){val listener=SharedPreferences.OnSharedPreferenceChangeListener{_,key->if(key=="records"||key==null)tick++};prefs.registerOnSharedPreferenceChangeListener(listener);onDispose{prefs.unregisterOnSharedPreferenceChangeListener(listener)}}
 var editing by rememberSaveable(collectionId){mutableStateOf<String?>(null)};var draft by rememberSaveable(collectionId){mutableStateOf("{}")};var originalStamp by rememberSaveable(collectionId){mutableStateOf("")}
 var errors by remember{mutableStateOf(mapOf<String,String>())};var message by remember{mutableStateOf("")};var failure by remember{mutableStateOf("")}
 val parsed=remember(tick,prefs){runCatching{readRecords(prefs)}}
 if(parsed.isFailure){Text("تعذر قراءة البيانات المحفوظة؛ لم تُستبدل بياناتك.",color=MaterialTheme.colorScheme.error);return}
 val state=parsed.getOrThrow();val rows=records(state,collectionId)
 fun perform(action:String,id:String?=null,expectedStamp:String?=null){try{
  failure="";val latest=readRecords(prefs);val all=records(latest,collectionId).toMutableList();val row=all.find{it.getString("id")==id};val clock=Instant.now();val previous=row?.let{Instant.parse(it.getString("updatedAt"))};val now=(if(previous!=null&&!clock.isAfter(previous))previous.plusNanos(1) else clock).toString()
  if(row!=null&&expectedStamp!=null&&row.getString("updatedAt")!=expectedStamp)throw Exception("تغيّر السجل في جلسة أخرى؛ أعد فتحه")
  when(action){
   "save"->{if(id!=null&&(row==null||row.has("deletedAt")))throw Exception("السجل لم يعد متاحًا؛ أعد فتح القائمة");if(row!=null&&row.getString("updatedAt")!=originalStamp)throw Exception("تغيّر السجل في جلسة أخرى؛ أعد فتحه")
    val result=validateValues(schema,JSONObject(draft),latest,id);errors=result.second;if(errors.isNotEmpty())return
    if(row!=null){val v=row.getJSONObject("values");result.first.keys().forEach{k->v.put(k,result.first.get(k))};row.put("updatedAt",now)}else{if(all.size>=1000)throw Exception("وصلت هذه المجموعة إلى حد 1000 سجل");all.add(JSONObject().put("id",UUID.randomUUID().toString()).put("values",result.first).put("createdAt",now).put("updatedAt",now))}
   }
   "delete"->{if(row==null||row.has("deletedAt"))throw Exception("السجل غير موجود");for(c in schemas)for(f in objects(c.getJSONArray("fields")))if(f.optString("type")=="relation"&&f.optString("collectionId")==collectionId&&records(latest,c.getString("id")).any{!it.has("deletedAt")&&it.getJSONObject("values").optString(f.getString("id"))==id})throw Exception("هذا السجل مرتبط ببيانات أخرى. غيّر الارتباط أولًا.");row.put("deletedAt",now).put("updatedAt",now)}
   "restore"->{if(row==null||!row.has("deletedAt"))throw Exception("لا يوجد حذف يمكن التراجع عنه");val checked=validateValues(schema,row.getJSONObject("values"),latest,id);if(checked.second.isNotEmpty())throw Exception("تعذرت الاستعادة: "+checked.second.values.first());row.remove("deletedAt");row.put("updatedAt",now)}
  }
  latest.getJSONObject("collections").put(collectionId,JSONArray(all));latest.put("revision",latest.getLong("revision")+1)
  if(!prefs.edit().putString("records",latest.toString()).commit())throw Exception("تعذر حفظ البيانات على الجهاز")
  tick++;editing=null;message=when(action){"save"->"تم حفظ $singular";"delete"->"نُقل السجل إلى المحذوفات؛ يمكنك استعادته.";else->"تمت استعادة $singular"}
 }catch(e:Exception){failure=e.message?:"تعذر حفظ البيانات"}}
 Column(Modifier.fillMaxWidth().testTag("collection_"+collectionId),verticalArrangement=Arrangement.spacedBy(12.dp)){
  if(message.isNotEmpty()||failure.isNotEmpty())Text(failure.ifEmpty{message},color=if(failure.isNotEmpty())MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,modifier=Modifier.testTag("record_notice").semantics{liveRegion=LiveRegionMode.Polite})
  if(editing!=null){
   TextButton(onClick={editing=null;errors=emptyMap()},modifier=Modifier.testTag("record_back")){Text("عودة إلى القائمة")}
   Text((if(editing=="")"إضافة " else "تعديل ")+singular,style=MaterialTheme.typography.titleLarge)
   val values=JSONObject(draft)
   for(f in fields){val id=f.getString("id");val fieldLabel=f.getString("label");val type=f.getString("type")
    fun update(value:Any){values.put(id,value);draft=values.toString()}
    when(type){
     "boolean"->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(fieldLabel,modifier=Modifier.weight(1f));Checkbox(checked=values.optBoolean(id,false),onCheckedChange={update(it)},modifier=Modifier.testTag("field_"+id).semantics{contentDescription=fieldLabel})}
     "select","relation"->{var expanded by remember{mutableStateOf(false)};val choices=if(type=="select"){val a=f.getJSONArray("options");(0 until a.length()).map{a.getString(it) to a.getString(it)}}else{val linked=schemas.first{it.getString("id")==f.getString("collectionId")};val related=records(state,f.getString("collectionId"));related.filter{!it.has("deletedAt")}.map{it.getString("id") to relationLabel(linked,it,related)}}
      Text(fieldLabel+(if(f.optBoolean("required"))" *" else ""));Box{OutlinedButton(onClick={expanded=true},modifier=Modifier.fillMaxWidth().testTag("field_"+id)){Text(choices.find{it.first==values.optString(id)}?.second?:"اختر…")};DropdownMenu(expanded=expanded,onDismissRequest={expanded=false}){DropdownMenuItem(text={Text("بدون اختيار")},onClick={update("");expanded=false});choices.forEach{(value,text)->DropdownMenuItem(text={Text(text)},onClick={update(value);expanded=false})}}}
     }
     else->OutlinedTextField(value=values.optString(id,""),onValueChange={if(it.length<=2000)update(it)},label={Text(fieldLabel+(if(f.optBoolean("required"))" *" else ""))},placeholder={if(type=="date")Text("YYYY-MM-DD")},singleLine=type!="text"||id==schema.getString("titleField"),isError=errors.containsKey(id),keyboardOptions=KeyboardOptions(keyboardType=if(type=="number")KeyboardType.Decimal else KeyboardType.Text,imeAction=ImeAction.Done),keyboardActions=KeyboardActions(onDone={focus.clearFocus();keyboard?.hide()}),modifier=Modifier.fillMaxWidth().testTag("field_"+id))
    };errors[id]?.let{Text(it,color=MaterialTheme.colorScheme.error,modifier=Modifier.testTag("error_"+id))}
   }
   Button(onClick={perform("save",editing?.takeIf{it.isNotEmpty()})},modifier=Modifier.fillMaxWidth().testTag("record_save")){Text("حفظ $singular")}
  }else{
   Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(schema.getString("title")+" · "+rows.count{!it.has("deletedAt")},style=MaterialTheme.typography.titleMedium,modifier=Modifier.weight(1f));Button(onClick={editing="";draft="{}";errors=emptyMap();failure="";message=""},modifier=Modifier.testTag("record_add")){Text("إضافة $singular")}}
   OutlinedTextField(value=query,onValueChange={query=it},label={Text("ابحث في "+schema.getString("title"))},singleLine=true,keyboardOptions=KeyboardOptions(imeAction=ImeAction.Search),keyboardActions=KeyboardActions(onSearch={focus.clearFocus();keyboard?.hide()}),modifier=Modifier.fillMaxWidth().testTag("record_search"))
   val filterField=fields.firstOrNull{it.getString("type")=="select"};if(filterField!=null){var expanded by remember{mutableStateOf(false)};Box{OutlinedButton(onClick={expanded=true},modifier=Modifier.testTag("record_filter")){Text(filter.ifEmpty{"كل "+filterField.getString("label")})};DropdownMenu(expanded=expanded,onDismissRequest={expanded=false}){DropdownMenuItem(text={Text("الكل")},onClick={filter="";expanded=false});val choices=filterField.getJSONArray("options");(0 until choices.length()).forEach{i->val v=choices.getString(i);DropdownMenuItem(text={Text(v)},onClick={filter=v;expanded=false})}}}}
   TextButton(onClick={trash=!trash},modifier=Modifier.testTag("record_trash")){Text(if(trash)"عرض السجلات" else "المحذوفات ("+rows.count{it.has("deletedAt")}+")")}
   fun display(f:JSONObject,v:JSONObject):String{val id=f.getString("id");return when(f.getString("type")){"boolean"->if(v.optBoolean(id))"نعم" else "لا";"relation"->{val linked=schemas.first{it.getString("id")==f.getString("collectionId")};val related=records(state,linked.getString("id"));related.find{it.getString("id")==v.optString(id)}?.let{relationLabel(linked,it,related)}?:"غير محدد"};else->v.optString(id,"")}}
   val visible=rows.filter{it.has("deletedAt")==trash}.filter{row->val v=row.getJSONObject("values");(filter.isEmpty()||v.optString(filterField?.optString("id")?:"")==filter)&&fields.any{display(it,v).contains(query,ignoreCase=true)}}.sortedByDescending{it.getString("updatedAt")}
   if(visible.isEmpty())Text(if(query.isNotEmpty()||filter.isNotEmpty())"لا توجد نتائج مطابقة" else if(trash)"المحذوفات فارغة" else "ابدأ بإضافة $singular؛ ستظهر سجلاتك هنا.")
   for(row in visible){Card(Modifier.fillMaxWidth().testTag("record_"+row.getString("id"))){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text(label(schema,row),style=MaterialTheme.typography.titleMedium);val v=row.getJSONObject("values");for(f in fields.filter{it.getString("id")!=schema.getString("titleField")}.take(4))if(v.has(f.getString("id")))Text(f.getString("label")+" · "+display(f,v),style=MaterialTheme.typography.bodyMedium)
     Row{if(trash)TextButton(onClick={perform("restore",row.getString("id"),row.getString("updatedAt"))},modifier=Modifier.testTag("record_restore")){Text("استعادة $singular")}else{TextButton(onClick={editing=row.getString("id");draft=v.toString();originalStamp=row.getString("updatedAt");errors=emptyMap();failure="";message=""},modifier=Modifier.testTag("record_edit")){Text("تعديل $singular")};TextButton(onClick={perform("delete",row.getString("id"),row.getString("updatedAt"))},modifier=Modifier.testTag("record_delete")){Text("حذف $singular")}}}
   }}}
  }
 }
}
