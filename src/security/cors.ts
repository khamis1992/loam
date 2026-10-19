// Bounded checks for the explicit API probes routed through Node fetch.
// They do not replace the browser's complete Fetch implementation.
export function corsResponseAllowed(headers:Headers,origin:string,includeCredentials:boolean):boolean{
  const allowed=headers.get('access-control-allow-origin');
  return (allowed===origin||!includeCredentials&&allowed==='*')&&(!includeCredentials||headers.get('access-control-allow-credentials')==='true');
}
export function corsUnsafeHeaders(headers:Record<string,string>):string[]{
  const unsafe=/[\x00-\x08\x0a-\x1f\x7f"():<>?@\[\]\\{}]/;
  return Object.entries(headers).filter(([name,value])=>{
    if(['origin','cookie'].includes(name))return false;
    if(Buffer.byteLength(value)>128)return true;
    if(name==='accept')return unsafe.test(value);
    if(name==='accept-language'||name==='content-language')return !/^[0-9A-Za-z *,\-.;=]*$/.test(value);
    if(name==='content-type')return unsafe.test(value)||!['application/x-www-form-urlencoded','multipart/form-data','text/plain'].includes(value.split(';')[0]!.trim().toLowerCase());
    return true;
  }).map(([name])=>name.toLowerCase()).sort();
}
export function corsPreflightAllowed(headers:Headers,origin:string,credentials:boolean,method:string,requestedHeaders:string[]):boolean{
  if(!corsResponseAllowed(headers,origin,credentials))return false;
  const methods=(headers.get('access-control-allow-methods')??'').split(',').map(v=>v.trim());
  if(!['GET','HEAD','POST'].includes(method)&&!methods.includes(method)&&!(methods.includes('*')&&!credentials))return false;
  const allowed=(headers.get('access-control-allow-headers')??'').split(',').map(v=>v.trim().toLowerCase());
  return requestedHeaders.every(h=>allowed.includes(h)||h!=='authorization'&&!credentials&&allowed.includes('*'));
}
