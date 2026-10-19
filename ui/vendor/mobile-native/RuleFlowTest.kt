package app.loam.generated

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.json.JSONObject
import org.json.JSONArray

/** Exercises the validator used by the compiled Compose forms, not a test reimplementation. */
@RunWith(AndroidJUnit4::class) class RuleFlowTest{
 private fun schema()=JSONObject("""{"id":"bookings","fields":[
 {"id":"name","type":"text","required":true},{"id":"amount","type":"number","min":0,"max":100,"integer":true},
 {"id":"start","type":"date"},{"id":"end","type":"date"},{"id":"slot","type":"select","options":["AM","PM"]},{"id":"active","type":"boolean"}],
 "rules":[{"id":"dates","type":"compare","field":"end","otherField":"start","operator":"gte","message":"النهاية تسبق البداية"},
 {"id":"unique_slot","type":"unique","fields":["start","slot"],"when":{"field":"active","equals":true},"message":"الفترة محجوزة"}]}""")
 private fun values()=JSONObject("""{"name":"حجز سارة","amount":0,"start":"2026-11-01","end":"2026-11-01","slot":"AM","active":true}""")
 private fun state(values:JSONObject?=null,deleted:Boolean=false):JSONObject{
  val rows=JSONArray();if(values!=null){val row=JSONObject().put("id","first").put("values",values);if(deleted)row.put("deletedAt","2026-10-18");rows.put(row)}
  return JSONObject().put("collections",JSONObject().put("bookings",rows))
 }
 @Test fun numericBoundsAndInteger(){
  for(bad in listOf(-1,101,1.5,"0x1p2","Infinity"))assertTrue("invalid $bad",validateValues(schema(),values().put("amount",bad),state()).second.containsKey("amount"))
  for(valid in listOf(0,100))assertTrue(validateValues(schema(),values().put("amount",valid),state()).second.isEmpty())
 }
 @Test fun orderedDates(){
  assertTrue(validateValues(schema(),values(),state()).second.isEmpty())
  assertEquals("النهاية تسبق البداية",validateValues(schema(),values().put("end","2026-10-31"),state()).second["end"])
  val strict=schema();strict.getJSONArray("rules").getJSONObject(0).put("operator","gt");assertTrue(validateValues(strict,values(),state()).second.containsKey("end"))
  assertTrue(validateValues(schema(),values().put("start","2026-02-30"),state()).second.containsKey("start"))
 }
 @Test fun compositeUniqueAndSelfEdit(){
  val existing=state(values());assertEquals("الفترة محجوزة",validateValues(schema(),values(),existing).second["start"])
  assertTrue(validateValues(schema(),values(),existing,"first").second.isEmpty())
  assertTrue(validateValues(schema(),values().put("slot","PM"),existing).second.isEmpty())
 }
 @Test fun cancelledAndDeletedReleaseSlot(){
  assertTrue(validateValues(schema(),values().put("active",false),state(values())).second.isEmpty())
  assertTrue(validateValues(schema(),values(),state(values().put("active",false))).second.isEmpty())
  assertTrue(validateValues(schema(),values(),state(values(),true)).second.isEmpty())
  // Restoring an old record is checked against other live rows, excluding only itself.
  assertEquals("الفترة محجوزة",validateValues(schema(),values(),state(values()),"deleted_record").second["start"])
 }
 @Test fun falseConditionAndCaseInsensitiveText(){
  val s=schema();s.put("rules",JSONArray("""[{"id":"unique_name","type":"unique","fields":["name"],"when":{"field":"active","equals":false},"message":"تكرار"}]"""))
  val existing=state(values().put("name","COPY-A").put("active",false))
  assertEquals("تكرار",validateValues(s,values().put("name"," copy-a ").put("active",false),existing).second["name"])
  assertTrue(validateValues(s,values().put("name","COPY-A"),existing).second.isEmpty())
 }
}
