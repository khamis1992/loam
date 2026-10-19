import type {MobileProject} from '../mobile/store.js';

/** Stable offline acceptance fixture; --project can exercise an actual model result. */
export const recordsFixture:MobileProject={
 version:1,revision:1,title:'مساحة الإنجاز',accent:'#0D9488',direction:'rtl',designSystem:{version:1,profile:'productivity'},
 collections:[
  {id:'projects',title:'المشاريع',singular:'مشروع',titleField:'name',fields:[{id:'name',label:'عنوان المشروع',type:'text',required:true}]},
  {id:'tasks',title:'المهام',singular:'مهمة',titleField:'name',fields:[
   {id:'name',label:'عنوان المهمة',type:'text',required:true},
   {id:'hours',label:'الساعات',type:'number'},
   {id:'due',label:'الموعد',type:'date'},
   {id:'done',label:'أُنجزت المهمة',type:'boolean'},
   {id:'priority',label:'الأولوية',type:'select',options:['منخفضة','متوسطة','عالية']},
   {id:'project',label:'المشروع',type:'relation',collectionId:'projects'},
  ]},
 ],
 screens:[
  {id:'projects_home',title:'المشاريع',kind:'primary',blocks:[{id:'projects_list',type:'collection',text:'المشاريع',collectionId:'projects'}]},
  {id:'tasks_home',title:'المهام',kind:'primary',blocks:[{id:'tasks_list',type:'collection',text:'المهام',collectionId:'tasks'}]},
 ],
};
