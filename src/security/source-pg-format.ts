/** pg-promise raw modifiers only; not a PostgreSQL parser or sanitizer model. */
export function pgRawReferences(sql:string):Array<{index:number}|{name:string}>{
  const refs:Array<{index:number}|{name:string}>=[];
  for(const m of sql.matchAll(/\$([1-9]\d*)(?::raw\b|\^)/g))if(Number(m[1])<=100000)refs.push({index:Number(m[1])-1});
  // Named filters belong INSIDE the delimiter: ${id:raw}, not ${id}:raw.
  const delimiters=[/\$\{([^{}]*)\}/g,/\$\(([^()]*)\)/g,/\$\[([^\[\]]*)\]/g,/\$<([^<>]*)>/g,/\$\/([^/]*)\//g];
  for(const re of delimiters)for(const m of sql.matchAll(re)){
    const name=/^\s*([\w$.]+)\s*(?::raw|\^)\s*$/.exec(m[1]!);
    if(name)refs.push({name:name[1]!});
  }
  return refs;
}
