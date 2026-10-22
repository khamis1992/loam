package app.loam.generated

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import androidx.test.platform.app.InstrumentationRegistry
import android.graphics.Bitmap
import java.io.File

@RunWith(AndroidJUnit4::class)
class NativeFlowTest {
 @get:Rule val rule=createAndroidComposeRule<MainActivity>()
 @Test fun allScreensNavigationAndPersistentFields(){
  val project=JSONObject(rule.activity.assets.open("project.json").bufferedReader().use{it.readText()})
  val raw=project.getJSONArray("screens");val screens=(0 until raw.length()).map{raw.getJSONObject(it)}
  fun blocks(s:JSONObject):List<JSONObject>{val a=s.getJSONArray("blocks");return (0 until a.length()).map{a.getJSONObject(it)}}
  fun path(id:String):List<JSONObject>{val s=screens.first{it.getString("id")==id};val parent=s.optString("parentId");return if(parent.isEmpty())listOf(s) else path(parent)+s}
  fun visit(s:JSONObject){val route=path(s.getString("id"));rule.onNodeWithTag("tab_"+route.first().getString("id")).performClick();route.zipWithNext().forEach{(parent,child)->val edge=blocks(parent).first{it.optString("target")==child.getString("id")};rule.onNodeWithTag(edge.getString("id")).performScrollTo().performClick()};rule.onNodeWithTag("screen_title").assertTextEquals(s.getString("title"))}
  screens.forEach{s->visit(s);blocks(s).forEach{b->val id=b.getString("id");when(b.getString("type")){
   "input"->rule.onNodeWithTag(id).performScrollTo().performTextReplacement("native-test-"+id)
   "toggle"->{val node=rule.onNodeWithTag(id).performScrollTo();if(rule.activity.getSharedPreferences("loam-values",0).getString(id,"")!="true")node.performClick();node.assertIsOn()}
   "button"->if(b.optString("target").isNotEmpty()){val destination=screens.first{it.getString("id")==b.getString("target")};rule.onNodeWithTag(id).performScrollTo().performClick();rule.onNodeWithTag("screen_title").assertTextEquals(destination.getString("title"));if(destination.getString("id")!=s.getString("id")){if(destination.optString("parentId").isNotEmpty()){rule.onNodeWithTag("back").performScrollTo().performClick();rule.onNodeWithTag("screen_title").assertTextEquals(s.getString("title"))}else visit(s)}}else{rule.onNodeWithTag(id).performScrollTo().performClick();rule.onNodeWithTag("save_notice").performScrollTo().assertExists()}
  }}}
  rule.activityRule.scenario.recreate()
  screens.forEach{s->visit(s);blocks(s).forEach{b->when(b.getString("type")){"input"->rule.onNodeWithTag(b.getString("id")).performScrollTo().assertTextContains("native-test-"+b.getString("id"));"toggle"->rule.onNodeWithTag(b.getString("id")).performScrollTo().assertIsOn()}}}
  visit(screens.first{it.optString("kind")=="primary"});rule.waitForIdle()
  val instrumentation=InstrumentationRegistry.getInstrumentation()
  instrumentation.uiAutomation.takeScreenshot()?.let{bitmap->File(instrumentation.targetContext.filesDir,"native-proof.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}
 }
}
