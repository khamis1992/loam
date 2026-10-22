// App-owned navigation avoids leaving Loam or traversing an embedded frame's history.
export function createNavigation(){
 const bar=document.createElement('nav');bar.className='journey-nav';bar.setAttribute('aria-label','مسار الصفحة');
 bar.innerHTML='<button type="button" data-journey-back aria-label="العودة"><loam-icon name="back"></loam-icon><span>عودة</span></button><a href="#/home">الرئيسية</a><span data-journey-parent></span><span data-journey-current aria-current="page"></span>';
 document.querySelector('.topbar').after(bar);
 const trail=[];
 const parent=hash=>hash.startsWith('#/tasks/')?['#/tasks','المهام']:hash.startsWith('#/services/')?['#/services','الخدمات والإعدادات']:['#/home','الرئيسية'];
 const update=title=>{
  const hash=location.hash||'#/home';
  if(trail.at(-1)!==hash){const previous=trail.lastIndexOf(hash);if(previous>=0)trail.splice(previous+1);else trail.push(hash);if(trail.length>60)trail.shift();}
  bar.hidden=hash==='#/home'||hash==='#/';
  const [href,label]=parent(hash),slot=bar.querySelector('[data-journey-parent]');slot.replaceChildren();
  if(href!=='#/home'){const link=document.createElement('a');link.href=href;link.textContent=label;slot.append(link);}
  bar.querySelector('[data-journey-current]').textContent=title;
  const back=bar.querySelector('button');back.title=trail.length>1?'العودة إلى الصفحة السابقة':'العودة إلى '+label;
 };
 bar.querySelector('button').onclick=()=>{update(bar.querySelector('[data-journey-current]').textContent);const hash=location.hash||'#/home';let target;if(trail.length>1){trail.pop();target=trail.at(-1);}else{target=parent(hash)[0];trail.length=0;}location.hash=target;};
 return update;
}
