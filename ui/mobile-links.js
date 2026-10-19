// Canonical local links retain the main studio shell and select an exact screen.
export function screenLink(taskId,screenId){
 const url=new URL('/',location.origin);url.hash='/studios/mobile';
 url.searchParams.set('mobileTask',taskId);url.searchParams.set('mobileScreen',screenId);
 return url.href;
}
