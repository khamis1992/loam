export type DesignSelection = {version:1;profile:string};
export const DESIGN_PROFILES: Record<string,{label:string;keywords:string[];radius:string;tokens:Record<string,string>}>;
export function contrast(a:string,b:string):number;
export function readableInk(background:string,preferred?:string,minimum?:number):string;
export function chooseDesignProfile(text:string):string;
export function resolveMobileDesign(project:{accent:string;designSystem?:DesignSelection}):{profile:string;label:string;radius:string;tokens:Record<string,string>}|null;
export function mobileDesignContext(profile:string):string;
