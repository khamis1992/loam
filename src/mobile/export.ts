import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { UI_DIR } from '../config.js';
import {resolveMobileDesign,readableInk} from '../../ui/mobile-design.js';
import type { MobileProject } from './store.js';

export function mobileHtml(project: MobileProject, key: string, screen?: string): string {
  const safe = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  const modules=['mobile-design-profiles.js','mobile-design.js','mobile-data.js','mobile-record-store.js','mobile-records.js','mobile-runtime.js'];
  const runtime=modules.map(file=>fs.readFileSync(path.join(UI_DIR,file),'utf8').replace(/^import .*;$/gm,'').replace(/^export \{.*\};$/gm,'').replace(/export (const|function|async function) /g,'$1 ')).join('\n');
  const css = ['mobile-app.css','mobile-design.css','mobile-records.css'].map(file=>fs.readFileSync(path.join(UI_DIR,file),'utf8')).join('\n');
  const boot=`
let liveProject=window.__loamProject||${safe(project)},liveKey=window.__loamStorageKey||${safe(key)},liveScreen=${safe(screen||'')},liveTrail=[];
window.__loamRender=context=>{
 if(context.project)liveProject=context.project;
 if(context.storageKey&&context.storageKey!==liveKey){liveKey=context.storageKey;liveTrail=[];}
 if(context.screen!==undefined&&context.screen!==liveScreen){liveScreen=context.screen;liveTrail=[];}
 mountMobile(document.getElementById('mobile-app'),liveProject,liveKey,liveScreen,{
  edit:!!context.edit,selected:context.blockId,trail:liveTrail,services:context.services,
  onSelect:id=>parent.postMessage({channel:'loam-mobile-sandbox',type:'select',id},'*'),
  onScreen:(id,trail)=>{liveScreen=id;liveTrail=trail;parent.postMessage({channel:'loam-mobile-sandbox',type:'screen',id},'*');}
 });
};
window.__loamRender(window.__loamContext||{});
`;
  return `<!doctype html><html lang="${project.direction === 'rtl' ? 'ar' : 'en'}" dir="${project.direction}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${project.title.replace(/[<>&"']/g,'')}</title><style>${css}</style><body><div id="mobile-app"></div><script>${runtime}\n${boot}</script></body></html>`;
}
export async function exportMobile(project: MobileProject, storageKey: string): Promise<Buffer> {
  const zip = new JSZip();
  const { androidFiles } = await import('./android/generate.js');
  for (const [name, content] of Object.entries(androidFiles(project, storageKey).files)) zip.file('android/' + name, content);
  const design=resolveMobileDesign(project);
  zip.file('design-system.json',JSON.stringify(design,null,2));
  zip.file('design-provenance.json',fs.readFileSync(path.join(UI_DIR,'vendor/mobile-design/provenance.json')));
  zip.file('UI-UX-PRO-MAX-LICENSE.txt',fs.readFileSync(path.join(UI_DIR,'vendor/mobile-design/UI-UX-PRO-MAX-LICENSE.txt')));
  zip.file('expo/design-system.json',JSON.stringify({...design?.tokens||{background:'#f4f7f8',foreground:'#172b35',secondary:'#e8efdf',muted:'#f0eddf',border:'#9fb1bb','muted-foreground':'#52685f',card:'#ffffff'},radius:design?parseFloat(design.radius)*16:16,primary:project.accent,'on-primary':readableInk(project.accent)},null,2));
  zip.file('index.html', mobileHtml(project, 'loam-mobile-export-' + storageKey));
  zip.file('mobile.json', JSON.stringify(project, null, 2));
  zip.file('expo/package.json', JSON.stringify({ name: 'loam-mobile-app', version: '1.0.0', private: true, main: 'index.js', scripts: { start: 'expo start', android: 'expo run:android', ios: 'expo run:ios' }, dependencies: { expo: '~53.0.0', react: '19.0.0', 'react-native': '0.79.7', '@react-native-async-storage/async-storage': '2.1.2' } }, null, 2));
  zip.file('expo/index.js', "import { registerRootComponent } from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n");
  zip.file('expo/app.json', JSON.stringify({ expo: { name: project.title, slug: 'loam-mobile-app', version: '1.0.0', orientation: 'portrait' } }, null, 2));
  zip.file('expo/project.json', JSON.stringify(project, null, 2));
  zip.file('expo/Records.jsx',fs.readFileSync(path.join(UI_DIR,'vendor/mobile-native/Records.jsx'),'utf8'));
  zip.file('expo/mobile-data.js',fs.readFileSync(path.join(UI_DIR,'mobile-data.js'),'utf8'));
  zip.file('expo/App.js', `import React, {useState,useEffect,useRef} from 'react';
import {SafeAreaView,ScrollView,View,Text,TextInput,Switch,Pressable,Alert,BackHandler} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import project from './project.json';
import Records from './Records';
import theme from './design-system.json';
export default function App(){
 const primary=project.screens.filter(s=>s.kind==='primary');
 const [trail,setTrail]=useState([]),[active,setActive]=useState(primary[0].id),[values,setValues]=useState({}),[ready,setReady]=useState(false),writes=useRef(Promise.resolve());
 useEffect(()=>{AsyncStorage.getItem('app-values').then(v=>{if(v){const p=JSON.parse(v);if(p&&typeof p==='object'&&!Array.isArray(p))setValues(p);}}).catch(()=>Alert.alert('Storage unavailable')).finally(()=>setReady(true));},[]);
 const update=(id,value)=>setValues(old=>({...old,[id]:value}));
 useEffect(()=>{if(ready){writes.current=writes.current.catch(()=>{}).then(()=>AsyncStorage.setItem('app-values',JSON.stringify(values)));void writes.current.catch(()=>Alert.alert('Could not save data'));}},[values,ready]);
 const go=id=>{if(id===active)return;setTrail(old=>primary.some(s=>s.id===id)?[]:[...old,active].slice(-100));setActive(id);};
 const back=()=>{setActive(trail.at(-1)||project.screens.find(s=>s.id===active).parentId||primary[0].id);setTrail(old=>old.slice(0,-1));};
 useEffect(()=>{const sub=BackHandler.addEventListener('hardwareBackPress',()=>{if(!project.screens.find(s=>s.id===active).parentId)return false;back();return true;});return()=>sub.remove();},[active,trail]);
 let section=project.screens.find(s=>s.id===active);while(section.parentId)section=project.screens.find(s=>s.id===section.parentId);
 const screen=project.screens.find(s=>s.id===active),text={color:theme.foreground,textAlign:project.direction==='rtl'?'right':'left'},button={padding:14,minHeight:48,borderWidth:1,borderColor:theme.border,backgroundColor:theme.card,borderRadius:theme.radius,marginVertical:8};
 const sectionId=id=>{let s=project.screens.find(x=>x.id===id);while(s.parentId)s=project.screens.find(x=>x.id===s.parentId);return s.id;};
 const ticks=project.screens.filter(s=>sectionId(s.id)===section.id).flatMap(s=>s.blocks).filter(b=>b.type==='toggle'),completed=ticks.filter(b=>values[b.id]===true).length;
 if(!ready)return <SafeAreaView><Text>Loading…</Text></SafeAreaView>;
 return <SafeAreaView style={{flex:1,backgroundColor:theme.background}}><ScrollView contentContainerStyle={{padding:22}}><Text style={text}>{project.title}</Text>{screen.parentId&&<Pressable accessibilityRole="button" style={button} onPress={back}><Text style={text}>{project.direction==='rtl'?'رجوع':'Back'}</Text></Pressable>}<View style={{padding:screen.design?20:0,marginVertical:18,borderRadius:theme.radius,backgroundColor:screen.design?theme.secondary:'transparent'}}>{screen.design&&<Text style={[text,{fontSize:12}]}>{screen.design.eyebrow}</Text>}<Text style={[text,{fontSize:28,marginVertical:10,fontWeight:'700'}]}>{screen.title}</Text>{screen.design&&<Text style={[text,{fontSize:14,lineHeight:24}]}>{screen.design.description}</Text>}</View>{screen.design&&screen.kind==='primary'&&ticks.length>0&&<View style={{marginBottom:16}}><Text style={text}>{project.direction==='rtl'?'تقدمك في هذا القسم':'Section progress'} · {completed} / {ticks.length}</Text><View accessibilityRole="progressbar" accessibilityValue={{min:0,max:ticks.length,now:completed}} style={{height:6,backgroundColor:theme.border,borderRadius:6,marginTop:8}}><View style={{height:6,width:(completed/ticks.length*100)+'%',backgroundColor:project.accent,borderRadius:6}}/></View></View>}{screen.blocks.map(b=><View key={b.id} style={{marginVertical:8}}>{b.type==='button'?<Pressable accessibilityRole="button" style={[button,{backgroundColor:b.target?theme.card:theme.primary}]} onPress={()=>b.target?go(b.target):writes.current.then(()=>Alert.alert('Saved locally')).catch(()=>Alert.alert('Could not save data'))}><Text style={[text,{fontWeight:'600',color:b.target?theme.foreground:theme['on-primary']}]}>{b.text}</Text>{b.target&&project.screens.find(s=>s.id===b.target)?.design&&<Text style={[text,{fontSize:12,lineHeight:22,marginTop:6}]}>{project.screens.find(s=>s.id===b.target).design.description}</Text>}</Pressable>:b.type==='collection'?<Records key={b.id} project={project} collectionId={b.collectionId} theme={theme}/>:b.type==='input'?<><Text style={text}>{b.text}</Text><TextInput accessibilityLabel={b.text} accessibilityHint={b.help} placeholder={b.placeholder} placeholderTextColor={theme['muted-foreground']} value={typeof values[b.id]==='string'?values[b.id]:''} onChangeText={v=>update(b.id,v)} style={[text,{padding:12,borderWidth:1,borderColor:theme['muted-foreground'],borderRadius:10}]}/></>:b.type==='toggle'?<><Text style={text}>{b.text}</Text><Switch accessibilityLabel={b.text} value={values[b.id]===true} onValueChange={v=>update(b.id,v)}/></>:<Text style={[text,{fontSize:b.type==='heading'?22:16,lineHeight:28}]}>{b.text}</Text>}{b.help&&<Text style={[text,{fontSize:12,lineHeight:22,marginTop:6}]}>{b.help}</Text>}</View>)}{screen.design&&<View style={{padding:16,backgroundColor:theme.muted,borderRadius:theme.radius,marginVertical:14}}><Text style={[text,{fontWeight:'600',marginBottom:8}]}>{project.direction==='rtl'?'خطوة تساعدك':'A useful next step'}</Text><Text style={[text,{lineHeight:24}]}>{screen.design.guidance}</Text></View>}</ScrollView><View style={{flexDirection:'row',borderTopWidth:1,borderColor:theme['muted-foreground']}}>{primary.map(s=><Pressable key={s.id} style={[button,{flex:1,padding:8,backgroundColor:s.id===section.id?theme.primary:theme.background,borderColor:'transparent'}]} accessibilityRole="button" accessibilityState={{selected:s.id===section.id}} onPress={()=>go(s.id)}><Text style={[text,{color:s.id===section.id?theme['on-primary']:theme.foreground}]}>{s.title}</Text></Pressable>)}</View></SafeAreaView>;
}
`);
  zip.file('README.md', '# Mobile application source\n\nOpen index.html in a browser for the working web version. Inputs and toggles save on this device only. No backend, authentication, payments or cloud sync is implied.\n\n## Android Kotlin/Compose\nThe android/ folder contains the native Android app, shared design tokens and instrumentation tests. Open its README for Gradle commands. Mobile Studio can build a debug APK with the local Android toolchain; this ZIP itself contains source, not an APK.\n\n## Expo source\nThe expo/ folder contains React Native source targeting Expo SDK 53 (React 19 / RN 0.79). Requires Node, dependency installation and Android Studio or Xcode for native builds. Run npm install, npx expo install --fix, npx expo-doctor, then npm run android or npm run ios. SDK compatibility: https://expo.dev/changelog/sdk-53 . Review and upgrade this baseline before production distribution.\n\nNo APK, IPA, signing, store submission or native-device verification has been performed by this export. Configure your unique package identifiers, icons, privacy policy, production services and test on physical devices before release.\n');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
