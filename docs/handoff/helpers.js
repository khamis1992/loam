window.__send=(msg)=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(ta,msg);ta.dispatchEvent(new Event('input',{bubbles:true}));ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));return ta.placeholder};
window.__click=(txt)=>{const b=[...document.querySelectorAll('button,[role=tab]')].filter(b=>b.innerText.trim()===txt);b[b.length-1]?.click();return b.length};
window.__type=(sel,v)=>{const e=document.querySelector(sel);const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));return !!e};
'ok'
