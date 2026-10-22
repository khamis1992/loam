package app.loam.generated

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.json.JSONArray

/** Replay independently asserted product requirements against the actual native form validator. */
@RunWith(AndroidJUnit4::class) class MobileDomainContractTest {
 @Test fun generatedProductContract() {
  val context=InstrumentationRegistry.getInstrumentation().context
  val cases=JSONArray(context.assets.open("domain-contract.json").bufferedReader().use{it.readText()})
  assertTrue("Acceptance cases required",cases.length()>0)
  for(i in 0 until cases.length()) {
   val c=cases.getJSONObject(i)
   val errors=validateValues(c.getJSONObject("schema"),c.getJSONObject("values"),c.getJSONObject("state"),if(c.has("excludeId"))c.getString("excludeId")else null).second
   assertEquals("Case $i ${c.getJSONObject("schema").getString("id")}: $errors",c.getBoolean("valid"),errors.isEmpty())
  }
 }
}
