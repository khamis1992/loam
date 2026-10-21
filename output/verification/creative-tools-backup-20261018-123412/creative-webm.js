// MediaRecorder emits a streaming WebM without Duration. Add it to Segment/Info
// so downloaded clips can be reopened and trimmed again in the editor.
export async function finalizeWebM(blob,seconds){
  const bytes=new Uint8Array(await blob.arrayBuffer());
  function element(offset){
    const start=offset;let idLength=1;while(idLength<=4&&!(bytes[offset]&(1<<(8-idLength))))idLength++;
    if(idLength>4)throw Error('Invalid WebM ID');let id=0;for(let i=0;i<idLength;i++)id=id*256+bytes[offset++];
    let sizeLength=1;while(sizeLength<=8&&!(bytes[offset]&(1<<(8-sizeLength))))sizeLength++;
    if(sizeLength>8)throw Error('Invalid WebM size');let size=bytes[offset]&((1<<(8-sizeLength))-1),unknown=size===(1<<(8-sizeLength))-1;offset++;
    for(let i=1;i<sizeLength;i++){unknown=unknown&&bytes[offset]===255;size=size*256+bytes[offset++];}
    const end=unknown?bytes.length:offset+size;if(end>bytes.length||end<=start)throw Error('Truncated WebM');return {id,start,data:offset,end,unknown,idLength};
  }
  const join=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
  const sizeBytes=size=>{let length=1;while(size>=2**(7*length)-1)length++;const out=new Uint8Array(length);for(let i=length-1;i>=0;i--){out[i]=size%256;size=Math.floor(size/256);}out[0]|=1<<(8-length);return out;};
  let segment;for(let at=0;at<bytes.length;){const e=element(at);if(e.id===0x18538067){segment=e;break;}at=e.end;}
  if(!segment)throw Error('WebM segment missing');
  let info;for(let at=segment.data;at<segment.end;){const e=element(at);if(e.id===0x1549a966){info=e;break;}at=e.end;}
  if(!info)throw Error('WebM info missing');
  const parts=[];let scale=1000000;
  for(let at=info.data;at<info.end;){const e=element(at);if(e.id===0x2ad7b1){scale=0;for(let i=e.data;i<e.end;i++)scale=scale*256+bytes[i];}if(e.id!==0x4489)parts.push(bytes.slice(e.start,e.end));at=e.end;}
  const duration=new Uint8Array(11);duration.set([0x44,0x89,0x88]);new DataView(duration.buffer).setFloat64(3,seconds*1e9/scale,false);parts.push(duration);
  const body=join(parts),newInfo=join([bytes.slice(info.start,info.start+info.idLength),sizeBytes(body.length),body]);
  const segmentBody=join([bytes.slice(segment.data,info.start),newInfo,bytes.slice(info.end,segment.end)]);
  return new Blob([bytes.slice(0,segment.start+segment.idLength),segment.unknown?bytes.slice(segment.start+segment.idLength,segment.data):sizeBytes(segmentBody.length),segmentBody,bytes.slice(segment.end)],{type:'video/webm'});
}
