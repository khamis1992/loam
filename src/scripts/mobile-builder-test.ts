import type {FrameLocator,Page} from 'playwright';
type Studio=Page|FrameLocator;
export async function tools(studio:Studio,open:boolean){
 const dialog=studio.locator('#studio-tools');
 if(open&&!await dialog.isVisible())await studio.locator('#open-tools').click();
 if(!open&&await dialog.isVisible())await studio.locator('#close-tools').click();
}
export async function more(studio:Studio,id:string){
 await studio.locator('#project-menu>summary').click();
 await studio.locator('#'+id).click();
}
