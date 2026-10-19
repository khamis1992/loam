import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {UI_DIR} from '../../config.js';
import type {MobileProject} from '../store.js';
import {resolveMobileDesign,readableInk} from '../../../ui/mobile-design.js';

export const ANDROID_TOOLCHAIN={gradle:'8.14.3',agp:'8.13.0',kotlin:'2.2.20',compose:'2025.09.00',activity:'1.11.0',compileSdk:36,minSdk:26};
const resourceString=(text:string)=>'"'+text.replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\t/g,'\\t').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,"\\'").replace(/"/g,'\\"')+'"';
export function androidFiles(project:MobileProject,identity:string):{applicationId:string;files:Record<string,string>;sourceHash:string}{
 const applicationId='app.loam.mobile.p'+createHash('sha256').update(identity).digest('hex').slice(0,16);
 const design=resolveMobileDesign(project);
 const theme=design?.tokens||{background:'#f7f9f8',foreground:'#203c34',card:'#ffffff','card-foreground':'#203c34',primary:project.accent,'on-primary':readableInk(project.accent),secondary:'#e6efea','secondary-foreground':'#203c34',muted:'#edf2ef','muted-foreground':'#52685f',border:'#cbd6cb'};
 const files:Record<string,string>={
  'settings.gradle':`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = 'LoamMobile'\ninclude ':app'\n`,
  'build.gradle':`plugins {\n id 'com.android.application' version '${ANDROID_TOOLCHAIN.agp}' apply false\n id 'org.jetbrains.kotlin.android' version '${ANDROID_TOOLCHAIN.kotlin}' apply false\n id 'org.jetbrains.kotlin.plugin.compose' version '${ANDROID_TOOLCHAIN.kotlin}' apply false\n}\n`,
  'gradle.properties':'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nkotlin.code.style=official\nkotlin.compiler.execution.strategy=in-process\n',
  'app/build.gradle':`plugins { id 'com.android.application'; id 'org.jetbrains.kotlin.android'; id 'org.jetbrains.kotlin.plugin.compose' }\nandroid {\n namespace 'app.loam.generated'\n compileSdk ${ANDROID_TOOLCHAIN.compileSdk}\n defaultConfig { applicationId '${applicationId}'; minSdk ${ANDROID_TOOLCHAIN.minSdk}; targetSdk ${ANDROID_TOOLCHAIN.compileSdk}; versionCode ${project.revision}; versionName '1.0.${project.revision}'; testInstrumentationRunner 'androidx.test.runner.AndroidJUnitRunner' }\n buildFeatures { compose true }\n compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }\n kotlinOptions { jvmTarget = '17' }\n}\ndependencies {\n implementation platform('androidx.compose:compose-bom:${ANDROID_TOOLCHAIN.compose}')\n implementation 'androidx.activity:activity-compose:${ANDROID_TOOLCHAIN.activity}'\n implementation 'androidx.compose.material3:material3'\n implementation 'androidx.compose.material:material-icons-core'\n androidTestImplementation platform('androidx.compose:compose-bom:${ANDROID_TOOLCHAIN.compose}')\n androidTestImplementation 'androidx.compose.ui:ui-test-junit4'\n androidTestImplementation 'androidx.test.ext:junit:1.3.0'\n androidTestImplementation 'androidx.test:runner:1.7.0'\n debugImplementation 'androidx.compose.ui:ui-test-manifest'\n}\n`,
  'app/src/main/AndroidManifest.xml':'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="@string/app_name" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:supportsRtl="true" android:allowBackup="false"><activity android:name=".MainActivity" android:exported="true" android:windowSoftInputMode="adjustResize"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>',
  'app/src/main/res/values/strings.xml':'<resources><string name="app_name" formatted="false">'+resourceString(project.title)+'</string></resources>',
  'app/src/main/assets/project.json':JSON.stringify(project,null,2),
  'app/src/main/assets/theme.json':JSON.stringify(theme,null,2),
  'app/src/main/java/app/loam/generated/MainActivity.kt':fs.readFileSync(path.join(UI_DIR,'vendor/mobile-native/MainActivity.kt'),'utf8'),
  'app/src/main/java/app/loam/generated/Collections.kt':fs.readFileSync(path.join(UI_DIR,'vendor/mobile-native/Collections.kt'),'utf8'),
  'app/src/androidTest/java/app/loam/generated/NativeFlowTest.kt':fs.readFileSync(path.join(UI_DIR,'vendor/mobile-native/NativeFlowTest.kt'),'utf8'),
  'app/src/androidTest/java/app/loam/generated/RecordFlowTest.kt':fs.readFileSync(path.join(UI_DIR,'vendor/mobile-native/RecordFlowTest.kt'),'utf8'),
  'app/src/androidTest/java/app/loam/generated/RuleFlowTest.kt':fs.readFileSync(path.join(UI_DIR,'vendor/mobile-native/RuleFlowTest.kt'),'utf8'),
  'app/src/androidTest/java/app/loam/generated/CollectionSyncTest.kt':fs.readFileSync(path.join(UI_DIR,'vendor/mobile-native/CollectionSyncTest.kt'),'utf8'),
  '.gitignore':'.gradle/\n**/build/\nlocal.properties\n*.keystore\n',
  'README.md':`# ${project.title}\n\nNative Android application generated from Loam revision ${project.revision}. Kotlin + Jetpack Compose; no WebView.\n\nRequires JDK 17+, Gradle ${ANDROID_TOOLCHAIN.gradle}, Android SDK ${ANDROID_TOOLCHAIN.compileSdk}. Set ANDROID_HOME or sdk.dir in local.properties. Run gradle :app:assembleDebug. Run gradle :app:connectedDebugAndroidTest on an emulator for navigation/persistence tests.\n\nApplication ID: ${applicationId}. User values are stored on the device with stable block IDs. This is a debug build, not a Play Store release. Signing, release configuration, native APIs, services and store submission are separate steps.\n`,
 };
 const sourceHash=createHash('sha256').update(JSON.stringify(files)).digest('hex');
 files['loam-build.json']=JSON.stringify({applicationId,revision:project.revision,sourceHash,toolchain:ANDROID_TOOLCHAIN},null,2);
 return {applicationId,files,sourceHash};
}
