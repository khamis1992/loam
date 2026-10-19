package app.loam.generated

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.After
import org.junit.Assert.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID

/** Uses the production CollectionView and isolated test preferences. */
class CollectionSyncTest{
 @get:Rule val compose=createComposeRule()
 private val prefs=InstrumentationRegistry.getInstrumentation().targetContext.getSharedPreferences("sync-test-"+UUID.randomUUID(),Context.MODE_PRIVATE)
 private fun schema()=JSONObject("""{"id":"projects","title":"المشاريع","singular":"مشروع","titleField":"name","subtitleField":"code","fields":[{"id":"name","label":"الاسم","type":"text","required":true},{"id":"code","label":"الرمز","type":"text"}]}""")
 private fun row(id:String,name:String,code:String)=JSONObject().put("id",id).put("createdAt","2026-10-18T00:00:00Z").put("updatedAt","2026-10-18T00:00:00Z").put("values",JSONObject().put("name",name).put("code",code))
 private fun store(rows:List<JSONObject>){prefs.edit().putString("records",JSONObject().put("version",1).put("revision",1).put("collections",JSONObject().put("projects",JSONArray(rows))).toString()).commit()}
 @After fun cleanup(){prefs.edit().clear().commit()}
 private fun node(pane:String,tag:String)=compose.onNode(hasTestTag(tag) and hasAnyAncestor(hasTestTag(pane)))
 @Test fun siblingViewsRefreshAndStaleDraftSurvives(){
  val s=schema();store(listOf(row("one","original","A-01")))
  compose.setContent{MaterialTheme{Row(Modifier.fillMaxSize()){
   Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).testTag("left")){CollectionView(s,listOf(s),prefs)}
   Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).testTag("right")){CollectionView(s,listOf(s),prefs)}
  }}}
  node("right","record_edit").performScrollTo().performClick();node("right","field_name").performTextReplacement("my draft")
  node("left","record_edit").performScrollTo().performClick();node("left","field_name").performTextReplacement("new saved name")
  node("left","record_save").performScrollTo().performClick()
  node("right","field_name").assertTextContains("my draft")
  node("right","record_save").performScrollTo().performClick()
  node("right","record_notice").assertTextContains("تغيّر السجل في جلسة أخرى؛ أعد فتحه")
  node("right","field_name").assertTextContains("my draft")
  node("right","record_back").performScrollTo().performClick()
  compose.onNode(hasText("new saved name") and hasAnyAncestor(hasTestTag("right"))).assertExists()
  // Another mounted list immediately sees a new save.
  node("left","record_add").performScrollTo().performClick();node("left","field_name").performTextReplacement("second saved")
  node("left","record_save").performScrollTo().performClick()
  compose.onNode(hasText("second saved") and hasAnyAncestor(hasTestTag("right"))).assertExists()
 }
 @Test fun relationChoicesDisambiguateAndRefreshWithoutLosingDraft(){
  val s=schema();val a=row("one","same","A-01");val b=row("two","same","B-02");store(listOf(a,b))
  val tasks=JSONObject("""{"id":"tasks","title":"المهام","singular":"مهمة","titleField":"name","fields":[{"id":"name","label":"المهمة","type":"text","required":true},{"id":"project","label":"المشروع","type":"relation","collectionId":"projects"}]}""")
  compose.setContent{MaterialTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){CollectionView(tasks,listOf(s,tasks),prefs)}}}
  compose.onNodeWithTag("record_add").performClick();compose.onNodeWithTag("field_name").performTextReplacement("draft")
  compose.onNodeWithTag("field_project").performClick()
  compose.onNodeWithText("same — الرمز: A-01").assertExists();compose.onNodeWithText("same — الرمز: B-02").performClick()
  b.getJSONObject("values").put("name","renamed")
  compose.runOnIdle{store(listOf(a,b))}
  compose.onNodeWithTag("field_name").assertTextContains("draft")
  compose.onNodeWithTag("field_project").assertTextContains("renamed")
  compose.onNodeWithTag("record_save").performScrollTo().performClick()
  compose.runOnIdle{val state=JSONObject(prefs.getString("records",null)!!);val saved=state.getJSONObject("collections").getJSONArray("tasks").getJSONObject(0);assertEquals("two",saved.getJSONObject("values").getString("project"))}
 }
 @Test fun indistinguishableDetailsUseStableIdentity(){
  val s=schema();val rows=listOf(row("shared-prefix-one","same","A"),row("shared-prefix-two","same","A"))
  assertNotEquals(relationLabel(s,rows[0],rows),relationLabel(s,rows[1],rows))
  assertEquals("same — الرمز: A · #shared-prefix-one",relationLabel(s,rows[0],rows))
 }
}
