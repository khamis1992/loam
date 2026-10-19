/** Expand in place: moving the editor would reload its Word iframe and lose a caret draft. */
export function workspaceView(root){
 let expanded=false,hidden=[];
 const label=()=>{const button=root.querySelector('[data-expand-workspace]');if(button){button.textContent=expanded?'العودة لمساحة العمل':'توسيع المحرر';button.setAttribute('aria-expanded',String(expanded));}};
 function collapse(){expanded=false;root.classList.remove('office-expanded');for(const [node,inert]of hidden)node.inert=inert;hidden=[];label();}
 function toggle(){
  if(expanded){collapse();return;}
  expanded=true;root.classList.add('office-expanded');
  // Keep keyboard navigation inside the editor without moving its live content.
  for(let node=root;node.parentElement&&node!==document.body;node=node.parentElement){for(const sibling of node.parentElement.children){if(sibling!==node&&!sibling.matches('dialog')){hidden.push([sibling,sibling.inert]);sibling.inert=true;}}}
  label();
 }
 root.addEventListener('keydown',event=>{if(expanded&&event.key==='Escape'&&!event.defaultPrevented&&!event.target.closest('input,textarea,[contenteditable=true],dialog')){event.preventDefault();collapse();root.querySelector('[data-expand-workspace]')?.focus();}});
 return {collapse,refresh(){const ribbon=root.querySelector('.office-ribbon');if(!ribbon)return;let button=ribbon.querySelector('[data-expand-workspace]');if(!button){button=document.createElement('button');button.type='button';button.dataset.expandWorkspace='';button.onclick=event=>{event.stopPropagation();toggle();};ribbon.append(button);}label();}};
}
