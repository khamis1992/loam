package app.loam.generated
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.json.JSONObject
import org.json.JSONArray
import android.graphics.Bitmap
import java.io.File

@RunWith(AndroidJUnit4::class) class RecordFlowTest{
 @get:Rule val rule=createAndroidComposeRule<MainActivity>()
 @get:Rule val evidence=object:TestWatcher(){override fun failed(error:Throwable,description:Description){
  val instrumentation=InstrumentationRegistry.getInstrumentation();instrumentation.uiAutomation.takeScreenshot()?.let{bitmap->File(instrumentation.targetContext.filesDir,"records-failure.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}
 }}
 private fun SemanticsNodeInteraction.replaceAndFinish(value:String){performTextReplacement(value);performImeAction();rule.waitForIdle()}
 private fun objects(a:JSONArray)=(0 until a.length()).map{a.getJSONObject(it)}
 private fun numberValue(f:JSONObject):String{var value=2.5.coerceAtLeast(f.optDouble("min",-1e12)).coerceAtMost(f.optDouble("max",1e12));if(f.optBoolean("integer"))value=kotlin.math.ceil(value).coerceAtMost(kotlin.math.floor(f.optDouble("max",1e12)));return if(f.optBoolean("integer"))value.toLong().toString()else value.toString()}
 private fun visit(c:JSONObject){
  val project=JSONObject(rule.activity.assets.open("project.json").bufferedReader().use{it.readText()});val screens=objects(project.getJSONArray("screens"))
  fun blocks(s:JSONObject)=objects(s.getJSONArray("blocks"))
  fun route(id:String):List<JSONObject>{val s=screens.first{it.getString("id")==id};val p=s.optString("parentId");return if(p.isEmpty())listOf(s)else route(p)+s}
  val screen=screens.first{s->blocks(s).any{it.optString("collectionId")==c.getString("id")}};val path=route(screen.getString("id"));rule.onNodeWithTag("tab_"+path.first().getString("id")).performClick();path.zipWithNext().forEach{(parent,child)->rule.onNodeWithTag(blocks(parent).first{it.optString("target")==child.getString("id")}.getString("id")).performScrollTo().performClick()}
 }
 @Test fun createEditSearchRelationsTrashAndPersistence(){
  val project=JSONObject(rule.activity.assets.open("project.json").bufferedReader().use{it.readText()});val schemas=objects(project.optJSONArray("collections")?:JSONArray());assumeTrue(schemas.isNotEmpty())
  val prefix="native-"+System.currentTimeMillis();val created=mutableMapOf<String,String>();val names=mutableMapOf<String,String>()
  // Schemas with required relationships must be created after their dependencies.
  val pending=schemas.toMutableList();val ordered=mutableListOf<JSONObject>()
  while(pending.isNotEmpty()){
   val next=pending.firstOrNull{c->
    objects(c.getJSONArray("fields")).filter{it.optString("type")=="relation"&&it.optBoolean("required")}.all{f->ordered.any{it.getString("id")==f.getString("collectionId")}}
   }?:error("Required relation cycle")
   ordered.add(next);pending.remove(next)
  }
  for(c in ordered){val cid=c.getString("id");val name="$prefix-$cid";visit(c);rule.onNodeWithTag("record_add").performScrollTo().performClick();rule.onNodeWithTag("record_save").performScrollTo().performClick();rule.onNodeWithTag("error_"+c.getString("titleField")).assertExists()
   for(f in objects(c.getJSONArray("fields"))){val id=f.getString("id");val node=rule.onNodeWithTag("field_"+id).performScrollTo();when(f.getString("type")){
    "text"->node.replaceAndFinish(if(id==c.getString("titleField"))name else "$prefix-$id")
    "number"->node.replaceAndFinish(numberValue(f))
    "date"->node.replaceAndFinish("2026-10-18")
    "boolean"->node.performClick()
    "select"->{node.performClick();rule.onNodeWithText(f.getJSONArray("options").getString(0),useUnmergedTree=true).performClick()}
    "relation"->{val related=names[f.getString("collectionId")];if(related!=null){node.performClick();rule.onNodeWithText(related,useUnmergedTree=true).performClick()}}
   }}
   rule.onNodeWithTag("record_save").performScrollTo().performClick();rule.waitForIdle();rule.onNodeWithTag("record_notice").assertTextContains("تم حفظ "+c.getString("singular"));rule.onNodeWithTag("record_back").assertDoesNotExist();rule.onNodeWithText(name).assertExists();names[cid]=name
   val state=JSONObject(rule.activity.getSharedPreferences("loam-records",0).getString("records","{}")!!);created[cid]=objects(state.getJSONObject("collections").getJSONArray(cid)).first{it.getJSONObject("values").getString(c.getString("titleField"))==name}.getString("id")
  }
  for(c in ordered){val cid=c.getString("id");visit(c);rule.onNodeWithTag("record_search").performScrollTo().replaceAndFinish("no-results-$prefix");rule.onNodeWithText("لا توجد نتائج مطابقة").assertExists();rule.onNodeWithTag("record_search").replaceAndFinish(prefix);rule.onNodeWithTag("record_edit").performScrollTo().performClick();val updated=names.getValue(cid)+"-updated";rule.onNodeWithTag("field_"+c.getString("titleField")).performScrollTo().replaceAndFinish(updated);rule.onNodeWithTag("record_save").performScrollTo().performClick();names[cid]=updated;rule.onNodeWithText(updated).assertExists()}
  rule.activityRule.scenario.recreate()
  for(c in ordered){val cid=c.getString("id");visit(c);rule.onNodeWithTag("record_search").performScrollTo().replaceAndFinish(prefix);rule.onNodeWithText(names.getValue(cid)).assertExists();rule.onNodeWithTag("record_edit").performScrollTo().performClick();for(f in objects(c.getJSONArray("fields"))){val node=rule.onNodeWithTag("field_"+f.getString("id")).performScrollTo();when(f.getString("type")){"number"->node.assertTextContains(numberValue(f));"date"->node.assertTextContains("2026-10-18");"boolean"->node.assertIsOn()}};rule.onNodeWithTag("record_back").performScrollTo().performClick()
   val state=JSONObject(rule.activity.getSharedPreferences("loam-records",0).getString("records","{}")!!);val referenced=schemas.any{other->objects(other.getJSONArray("fields")).any{f->f.optString("type")=="relation"&&f.optString("collectionId")==cid&&objects(state.getJSONObject("collections").optJSONArray(other.getString("id"))?:JSONArray()).any{r->!r.has("deletedAt")&&r.getJSONObject("values").optString(f.getString("id"))==created[cid]}}}
   rule.onNodeWithTag("record_delete").performScrollTo().performClick();if(referenced)rule.onNodeWithTag("record_notice").assertTextContains("هذا السجل مرتبط ببيانات أخرى. غيّر الارتباط أولًا.")else{rule.onNodeWithText(names.getValue(cid)).assertDoesNotExist();rule.onNodeWithTag("record_trash").performScrollTo().performClick();rule.onNodeWithTag("record_restore").performScrollTo().performClick();rule.onNodeWithTag("record_trash").performScrollTo().performClick();rule.onNodeWithText(names.getValue(cid)).assertExists()}
  }
  File(rule.activity.filesDir,"records-expected.json").writeText(JSONObject().put("prefix",prefix).put("ids",JSONObject(created as Map<*,*>)).put("records",JSONObject(rule.activity.getSharedPreferences("loam-records",0).getString("records","{}")!!)).toString())
  rule.onNodeWithTag("record_search").performScrollTo();rule.waitForIdle();val instrumentation=InstrumentationRegistry.getInstrumentation();instrumentation.uiAutomation.takeScreenshot()?.let{bitmap->File(instrumentation.targetContext.filesDir,"records-proof.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}
 }
 // Invoke separately after `am force-stop` to prove restoration in a new process.
 @Test fun verifyRecordsAfterColdStart(){
  val file=File(rule.activity.filesDir,"records-expected.json");assumeTrue(file.exists());val proof=JSONObject(file.readText())
  val project=JSONObject(rule.activity.assets.open("project.json").bufferedReader().use{it.readText()});val schemas=objects(project.getJSONArray("collections"))
  val state=JSONObject(rule.activity.getSharedPreferences("loam-records",0).getString("records","{}")!!)
  org.junit.Assert.assertEquals(proof.getJSONObject("records").toString(),state.toString())
  for(c in schemas){val cid=c.getString("id");val row=objects(state.getJSONObject("collections").getJSONArray(cid)).first{it.getString("id")==proof.getJSONObject("ids").getString(cid)};val values=row.getJSONObject("values")
   visit(c);rule.onNodeWithTag("record_search").performScrollTo().replaceAndFinish(proof.getString("prefix"));rule.onNodeWithText(values.getString(c.getString("titleField"))).assertExists();rule.onNodeWithTag("record_edit").performScrollTo().performClick()
   for(f in objects(c.getJSONArray("fields"))){val id=f.getString("id");val node=rule.onNodeWithTag("field_"+id).performScrollTo();when(f.getString("type")){
    "boolean"->if(values.optBoolean(id))node.assertIsOn()else node.assertIsOff()
    "relation"->{if(values.optString(id).isNotEmpty()){val linked=schemas.first{it.getString("id")==f.getString("collectionId")};val target=objects(state.getJSONObject("collections").getJSONArray(linked.getString("id"))).first{it.getString("id")==values.getString(id)};node.assertTextContains(target.getJSONObject("values").getString(linked.getString("titleField")))}}
    else->node.assertTextContains(values.optString(id))
   }}
   rule.onNodeWithTag("record_back").performScrollTo().performClick()
  }
 }
}
