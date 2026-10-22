package app.loam.generated

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import org.json.JSONObject

data class AppBlock(val id:String,val type:String,val text:String,val target:String?,val help:String,val placeholder:String,val collectionId:String)
data class AppScreen(val id:String,val title:String,val parent:String?,val primary:Boolean,val design:JSONObject?,val blocks:List<AppBlock>)

class MainActivity:ComponentActivity(){
 override fun onCreate(savedInstanceState:Bundle?){
  super.onCreate(savedInstanceState)
  enableEdgeToEdge()
  val project=JSONObject(assets.open("project.json").bufferedReader().use{it.readText()})
  val theme=JSONObject(assets.open("theme.json").bufferedReader().use{it.readText()})
  val source=project.getJSONArray("screens")
  val screens=(0 until source.length()).map { i ->
   val s=source.getJSONObject(i);val b=s.getJSONArray("blocks")
   AppScreen(s.getString("id"),s.getString("title"),s.optString("parentId").takeIf{it.isNotEmpty()},s.optString("kind")=="primary",s.optJSONObject("design"),(0 until b.length()).map{j->val x=b.getJSONObject(j);AppBlock(x.getString("id"),x.getString("type"),x.getString("text"),x.optString("target").takeIf{it.isNotEmpty()},x.optString("help"),x.optString("placeholder"),x.optString("collectionId"))})
  }
  val prefs=getSharedPreferences("loam-values",MODE_PRIVATE)
  val recordPrefs=getSharedPreferences("loam-records",MODE_PRIVATE)
  setContent{
   val rtl=project.optString("direction")=="rtl"
   fun color(key:String)=Color(android.graphics.Color.parseColor(theme.getString(key)))
   val colors=lightColorScheme(primary=color("primary"),onPrimary=color("on-primary"),secondary=color("primary"),onSecondary=color("on-primary"),secondaryContainer=color("secondary"),onSecondaryContainer=color("secondary-foreground"),background=color("background"),onBackground=color("foreground"),surface=color("card"),onSurface=color("card-foreground"),surfaceVariant=color("secondary"),onSurfaceVariant=color("secondary-foreground"),surfaceTint=color("primary"),outline=color("muted-foreground"),outlineVariant=color("border"))
   CompositionLocalProvider(LocalLayoutDirection provides if(rtl)LayoutDirection.Rtl else LayoutDirection.Ltr){MaterialTheme(colorScheme=colors){
    val primary=screens.filter{it.primary}.ifEmpty{listOf(screens.first())}
    var active by rememberSaveable{mutableStateOf(primary.first().id)}
    var trail by rememberSaveable{mutableStateOf(arrayListOf<String>())}
    val values=remember{mutableStateMapOf<String,String>().apply{screens.flatMap{it.blocks}.filter{it.type=="input"||it.type=="toggle"}.forEach{put(it.id,prefs.getString(it.id,"")?:"")}}}
    var notice by remember{mutableStateOf("")}
    val screen=screens.find{it.id==active}?:primary.first()
    val rawCollections=project.optJSONArray("collections")?:org.json.JSONArray();val collections=(0 until rawCollections.length()).map{rawCollections.getJSONObject(it)}
    fun rootOf(s:AppScreen):AppScreen{var current=s;val seen=mutableSetOf<String>();while(current.parent!=null&&seen.add(current.id)){current=screens.find{it.id==current.parent}?:break};return current}
    val section=rootOf(screen)
    fun go(id:String){if(id==active||screens.none{it.id==id})return;trail=if(primary.any{it.id==id})arrayListOf() else ArrayList((trail+active).takeLast(100));active=id;notice=""}
    fun back(){active=trail.lastOrNull()?:screen.parent?:primary.first().id;trail=ArrayList(trail.dropLast(1));notice=""}
    fun update(id:String,value:String){values[id]=value;prefs.edit().putString(id,value).apply()}
    BackHandler(enabled=screen.parent!=null){back()}
    Scaffold(containerColor=colors.background,bottomBar={NavigationBar(containerColor=colors.background){primary.forEach{s->NavigationBarItem(selected=s.id==section.id,onClick={go(s.id)},modifier=Modifier.testTag("tab_"+s.id),icon={ScreenIcon(s.design?.optString("icon")?:"note")},label={Text(s.title,maxLines=2)})}}}){padding->
     val scroll=key(screen.id){rememberScrollState()}
     Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(scroll).padding(16.dp).testTag("screen_"+screen.id),verticalArrangement=Arrangement.spacedBy(12.dp)){
      Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(project.getString("title"),style=MaterialTheme.typography.labelMedium);if(screen.parent!=null)TextButton(onClick={back()},modifier=Modifier.testTag("back")){Icon(Icons.AutoMirrored.Filled.ArrowBack,null);Text(if(rtl)"رجوع" else "Back")}}
      Surface(color=if(screen.primary)colors.surfaceVariant else colors.background,shape=MaterialTheme.shapes.large){Column(Modifier.fillMaxWidth().padding(if(screen.primary)16.dp else 0.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
       screen.design?.optString("eyebrow")?.takeIf{it.isNotEmpty()&&it!=screen.title}?.let{Text(it,style=MaterialTheme.typography.labelMedium)}
       Text(screen.title,style=MaterialTheme.typography.headlineMedium,modifier=Modifier.testTag("screen_title").semantics{heading()})
       screen.design?.optString("description")?.let{Text(it,style=MaterialTheme.typography.bodyMedium)}
      }}
      if(screen.primary){val toggles=screens.filter{rootOf(it).id==screen.id}.flatMap{it.blocks}.filter{it.type=="toggle"};if(toggles.isNotEmpty()){val count=toggles.count{values[it.id]=="true"};Text((if(rtl)"تقدمك في هذا القسم" else "Section progress")+" · "+count+" / "+toggles.size,style=MaterialTheme.typography.labelMedium);LinearProgressIndicator(progress={count.toFloat()/toggles.size},modifier=Modifier.fillMaxWidth().testTag("progress"))}}
      val destinations=screen.primary&&screen.blocks.isNotEmpty()&&screen.blocks.all{it.type=="button"&&it.target!=null}
      if(destinations){screen.blocks.chunked(2).forEach{row->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(10.dp)){row.forEach{b->Destination(b,screens,Modifier.weight(1f)){go(b.target!!)}};if(row.size==1)Spacer(Modifier.weight(1f))}}}
      else screen.blocks.forEach{b->when(b.type){
       "collection"->key(b.id){CollectionView(collections.first{it.getString("id")==b.collectionId},collections,recordPrefs)}
       "heading"->Text(b.text,style=MaterialTheme.typography.titleLarge,modifier=Modifier.testTag(b.id).semantics{heading()})
       "text"->Text(b.text,modifier=Modifier.testTag(b.id))
       "input"->OutlinedTextField(value=values[b.id]?:"",onValueChange={update(b.id,it)},label={Text(b.text)},placeholder={Text(b.placeholder)},supportingText={if(b.help.isNotEmpty())Text(b.help)},modifier=Modifier.fillMaxWidth().testTag(b.id))
       "toggle"->Card(Modifier.fillMaxWidth()){Row(Modifier.fillMaxWidth().padding(12.dp),horizontalArrangement=Arrangement.SpaceBetween){Column(Modifier.weight(1f)){Text(b.text);if(b.help.isNotEmpty())Text(b.help,style=MaterialTheme.typography.bodySmall)};Checkbox(checked=values[b.id]=="true",onCheckedChange={update(b.id,it.toString())},modifier=Modifier.testTag(b.id).semantics{contentDescription=b.text})}}
       "button"->if(b.target!=null)Destination(b,screens,Modifier.fillMaxWidth()){go(b.target)}else Button(onClick={val success=prefs.edit().apply{values.forEach{(k,v)->putString(k,v)}}.commit();notice=if(success){if(rtl)"تم حفظ البيانات على هذا الجهاز" else "Saved on this device"}else{if(rtl)"تعذر الحفظ" else "Could not save"}},modifier=Modifier.fillMaxWidth().heightIn(min=48.dp).testTag(b.id)){Text(b.text)}
      }}
      screen.design?.optString("guidance")?.takeIf{it.isNotEmpty()}?.let{tip->var expanded by rememberSaveable(screen.id){mutableStateOf(!screen.primary)};Surface(color=colors.surfaceVariant,shape=MaterialTheme.shapes.medium){Column(Modifier.fillMaxWidth().padding(12.dp)){TextButton(onClick={expanded=!expanded}){Text(if(rtl)"خطوة تساعدك" else "A useful next step")};if(expanded)Text(tip,style=MaterialTheme.typography.bodyMedium)}}}
      if(notice.isNotEmpty())Text(notice,modifier=Modifier.testTag("save_notice").semantics{liveRegion=LiveRegionMode.Polite})
     }
    }
   }}
  }
 }
}

@Composable private fun Destination(block:AppBlock,screens:List<AppScreen>,modifier:Modifier,onClick:()->Unit){
 Card(onClick=onClick,modifier=modifier.heightIn(min=108.dp).testTag(block.id),colors=CardDefaults.cardColors(containerColor=MaterialTheme.colorScheme.surface)){
  Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
   Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){ScreenIcon(screens.find{it.id==block.target}?.design?.optString("icon")?:"note");Text(block.text,style=MaterialTheme.typography.titleSmall)}
   screens.find{it.id==block.target}?.design?.optString("description")?.let{Text(it,style=MaterialTheme.typography.bodySmall,maxLines=3)}
  }
 }
}

@Composable private fun ScreenIcon(name:String){
 val data=when(name){
  "book"->"M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4z M12 6v15"
  "briefcase"->"M8 6V4h8v2 M3 7h18v13H3z M3 12c6 3 12 3 18 0 M10 13h4"
  "spark"->"m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"
  "check"->"m5 12 4 4L19 6"
  "sun"->"M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2 M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0"
  "flag"->"M5 21V4 M5 4c5-4 9 4 14 0v10c-5 4-9-4-14 0"
  "target"->"M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0 M17 12a5 5 0 1 0-10 0 5 5 0 0 0 10 0 M12 10v4 M10 12h4"
  else->"M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5"
 }
 val vector=remember(name){ImageVector.Builder(defaultWidth=24.dp,defaultHeight=24.dp,viewportWidth=24f,viewportHeight=24f).addPath(pathData=PathParser().parsePathString(data).toNodes(),stroke=SolidColor(Color.Black),strokeLineWidth=1.6f,strokeLineCap=StrokeCap.Round,strokeLineJoin=StrokeJoin.Round).build()}
 Icon(vector,contentDescription=null,modifier=Modifier.size(20.dp))
}
