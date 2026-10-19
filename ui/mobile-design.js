import {DESIGN_PROFILES} from './mobile-design-profiles.js';
export {DESIGN_PROFILES};
export function contrast(a,b){
 const luminance=color=>{const c=color.slice(1).match(/../g).map(h=>parseInt(h,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
 const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
export function readableInk(background,preferred='#ffffff',minimum=4.5){
 if(contrast(background,preferred)>=minimum)return preferred;
 return contrast(background,'#000000')>contrast(background,'#ffffff')?'#000000':'#ffffff';
}
export function chooseDesignProfile(text){
 const query=text.toLowerCase();let best='arabic-rtl-modern',score=0;
 // Productivity has domain-specific Arabic terms; generic “تطبيق” must not beat them.
 for(const [id,p]of Object.entries(DESIGN_PROFILES)){const n=p.keywords.reduce((sum,k)=>sum+(query.includes(k.toLowerCase())?k.length:0),0);if(n>score){score=n;best=id;}}
 return best;
}
export function resolveMobileDesign(project){
 const id=project.designSystem?.profile;
 const profile=Object.hasOwn(DESIGN_PROFILES,id||'')?DESIGN_PROFILES[id]:null;
 if(!profile)return null;
 const tokens={...profile.tokens,primary:project.accent};
 tokens.foreground=readableInk(tokens.background,tokens.foreground);
 tokens['card-foreground']=readableInk(tokens.card,tokens['card-foreground']);
 tokens['secondary-foreground']=readableInk(tokens.secondary,tokens['secondary-foreground']);
 // A single muted ink must remain readable on all surfaces where it is used.
 const surfaces=[tokens.background,tokens.card,tokens.secondary,tokens.muted];
 if(surfaces.some(bg=>contrast(bg,tokens['muted-foreground'])<4.5))tokens['muted-foreground']='#172b35';
 tokens['on-primary']=readableInk(tokens.primary);
 tokens['on-accent']=readableInk(tokens.accent);
 tokens.ring=readableInk(tokens.background,tokens.ring,3);
 tokens.input=readableInk(tokens.card,tokens['muted-foreground'],3);
 return {profile:id,label:profile.label,radius:profile.radius,tokens};
}
export function mobileDesignContext(profile){
 const selected=DESIGN_PROFILES[profile];
 return `Design contract v1: ${profile} (${selected?.label||''}). A shared semantic palette, mobile spacing, accessible focus, SVG icons and compact destination cards are rendered automatically. Write for a calm, clear mobile interface: one concise introduction, task-specific destination labels, short supporting descriptions, visible field labels and specific save actions. Use progressive disclosure for optional guidance, never duplicate the title. Preserve entered state and back navigation. At most five primary tabs; put remaining pages below those tabs. Do not invent metrics or unsupported services. Do not output CSS, external fonts, decorative emoji or fake data. Colors and layout are controlled by the saved design profile, not by generated markup.`;
}
