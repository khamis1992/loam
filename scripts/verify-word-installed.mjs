import fs from 'node:fs/promises';
const base='http://127.0.0.1:3939';
const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json();};
const {task}=await post('/api/tasks/draft',{title:'مراجعة جودة Word — عينة التنسيق',mode:'write'});
const artifact={kind:'document',title:'Loam — من الفكرة إلى مستند جاهز',content:{blocks:[
 {type:'heading',text:'ملخص تنفيذي'},
 {type:'paragraph',text:'يجمع Loam الكتابة والبحث وبناء التطبيقات وتحليل البيانات والتصميم والأتمتة في مساحة عمل واحدة. يبدأ العمل بطلب واضح، ويتطور داخل مهمة مستقلة تحتفظ بسياقها وملفاتها. يستطيع المستخدم متابعة المحتوى وتحريره، ثم تنزيل مستند Word قابل للتعديل والمشاركة.'},
 {type:'heading',text:'خدمات تتكامل حول عملك'},
 {type:'bullet',text:'الكتابة: إعداد التقارير والمقترحات والمستندات داخل محرر مباشر.'},
 {type:'bullet',text:'البحث: جمع المعلومات وصياغتها في محتوى واضح مع مراجعة المصادر.'},
 {type:'bullet',text:'البناء والتحليل: تطوير المشاريع والعمل على الجداول والبيانات.'},
 {type:'bullet',text:'التصميم والأتمتة: تجهيز المخرجات الإبداعية وتنظيم خطوات العمل المتكررة.'},
 {type:'heading',text:'رحلة العمل في أربع خطوات'},
 {type:'paragraph',text:'١. حدّد نوع المستند والجمهور والغرض منه. أرفق المادة المرجعية عند الحاجة، وبيّن ما إذا كانت مرجعًا للمحتوى أو للتصميم.\n٢. راجع المسودة في المحرر المباشر، ثم أضف توجيهاتك أو عدّل الفقرات بنفسك.\n٣. استخدم العناوين والنقاط لتنظيم المعلومات، وافحص تسلسل الأقسام ووضوح النص.\n٤. نزّل ملف Word وافتحه للمراجعة النهائية قبل مشاركته.'},
 {type:'heading',text:'الجودة تبدأ من التفاصيل'},
 {type:'paragraph',text:'يستخدم التصدير صفحات A4 وهوامش ثابتة، مع تسلسل واضح للعناوين وتباعد مريح للنصوص. تظهر هوية المستند في الترويسة، ويساعد ترقيم الصفحات على متابعة التقارير الطويلة. يبقى المحتوى نصًا أصليًا قابلًا للتحرير في Word.'},
 {type:'paragraph',text:'يجب أن تحافظ المستندات العربية على اتجاه الكتابة، وأن تتعامل بصورة سليمة مع أسماء المنتجات مثل Loam وMicrosoft Word داخل النص. تتضمن المراجعة كذلك التأكد من اتصال العنوان بالمحتوى التالي وعدم انقطاع الفقرات بصورة تعيق القراءة.'},
 {type:'heading',text:'حدود هذه العينة'},
 {type:'paragraph',text:'هذه عينة أُعدّت للتحقق من جودة التنسيق، وليست تقريرًا عن نتائج فعلية أو وعدًا بأداء محدد. لا تتضمن أرقامًا تسويقية أو أسعارًا. تعتمد جودة كل مستند على دقة المعلومات ومراجعة المحتوى إضافة إلى جودة عرضه.'},
]}};
await post('/api/studio',{taskId:task.id,artifact,expectedRevision:0});
const response=await fetch(base+'/api/studio/export?taskId='+task.id);if(!response.ok)throw Error(await response.text());
await fs.mkdir('output/word-review',{recursive:true});
await fs.writeFile('output/word-review/loam-professional-review.docx',Buffer.from(await response.arrayBuffer()));
await fs.writeFile('output/word-review/verification.json',JSON.stringify({taskId:task.id,identity:await(await fetch(base+'/api/identity')).json(),source:'Controlled Arabic layout sample exported by the installed server',artifact},null,2));
console.log(JSON.stringify({taskId:task.id,file:'output/word-review/loam-professional-review.docx'}));
