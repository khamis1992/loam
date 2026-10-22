const fs=require('fs');const p='src/creative/timeline.ts';let s=fs.readFileSync(p,'utf8');
function must(x){if(!s.includes(x)){console.error('ANCHOR MISSING:',x.slice(0,90));process.exit(1);}}
function rep(old,nw){must(old);s=s.replace(old,nw,1);}

rep(`tracks:Array<{id:string;muted:boolean;hidden:boolean;volume?:number;pan?:number;solo?:boolean}>;`,
`tracks:Array<{id:string;muted:boolean;hidden:boolean;volume?:number;pan?:number;solo?:boolean;role?:'subtitles'|'voice';eq?:{low?:number;mid?:number;high?:number};compressor?:{enabled?:boolean;threshold?:number;ratio?:number}}>;duck?:{enabled?:boolean;amount?:number};`);
rep(`type Job={rendererVersion?:number;id:string;taskId:string;title:string;format:'mp4'|'webm';`,
`type Job={rendererVersion?:number;id:string;taskId:string;title:string;format:'mp4'|'webm'|'wav'|'stems';loudnessTarget?:number;`);
rep(`if(!['mp4','webm'].includes(input.format))throw Error('صيغة غير صالحة');`,
`if(!['mp4','webm','wav','stems'].includes(input.format))throw Error('صيغة غير صالحة');
      const loudnessTarget=typeof input.loudness==='number'&&Number.isFinite(input.loudness)?Math.max(-40,Math.min(-5,input.loudness)):undefined;`);
rep(`const job:Job={rendererVersion:2,id:randomUUID(),taskId,title:project.title,format:input.format,`,
`const job:Job={rendererVersion:2,id:randomUUID(),taskId,title:project.title,format:input.format,loudnessTarget,`);

// wav/stems branch around the existing video finalize
rep(`      const audioFile=path.join(dir,'mix-'+attempt+'.pcm');await joinAudio(Array.from({length:current.total},(_,i)=>path.join(dir,i+'.pcm')),audioFile,control.check);control.check();
      fs.writeFileSync(path.join(dir,'parts.txt'),`,
`      const audioFile=path.join(dir,'mix-'+attempt+'.pcm');await joinAudio(Array.from({length:current.total},(_,i)=>path.join(dir,i+'.pcm')),audioFile,control.check);control.check();
      if(current.format==='wav'||current.format==='stems'){
        const relative=current.format==='wav'?`uploads/loam-export-${current.id}.wav`:`uploads/loam-export-${current.id}-stems.zip`;
        const output=taskPath(this.root(current.taskId),relative);fs.mkdirSync(path.dirname(output),{recursive:true});
        current.message=current.format==='wav'?'ترميز الصوت المتصل (WAV)':'توليد المسارات المنفصلة لكل مسار';this.persist(current);
        if(current.format==='wav'){
          await this.ffmpeg(current.loudnessTarget!=null
            ?['-f','f32le','-ar','48000','-ac','2','-i',audioFile,'-af',`loudnorm=I=${current.loudnessTarget}:TP=-1.5:LRA=11`,'-ar','48000','-c:a','pcm_s16le','-f','wav',output+'.'+attempt+'.partial']
            :['-f','f32le','-ar','48000','-ac','2','-i',audioFile,'-c:a','pcm_s16le','-f','wav',output+'.'+attempt+'.partial']);
        }else{
          const JSZipModule=await import('jszip');const zip=new JSZipModule.default();
          const audible=current.project.tracks.filter(t=>!t.muted&&!t.hidden);
          const totalFrames=Math.round(current.duration*current.project.fps);
          let index=1;
          for(const track of audible){
            control.check();
            const stemPcm=await renderAudio(current.project,this.root(current.taskId),0,totalFrames,control,dir,track.id);
            const stemWav=path.join(dir,`stem-${track.id}-${attempt}.wav`);
            await this.ffmpeg(['-f','f32le','-ar','48000','-ac','2','-i','-','-t',String(current.duration),'-c:a','pcm_s16le','-f','wav',stemWav],control,false,Buffer.from(stemPcm.buffer));
            zip.file(`stem-${String(index).padStart(2,'0')}-${track.name.replace(/[\\\\/:*?"<>|]/g,'_')}.wav`,fs.readFileSync(stemWav));
            index++;
          }
          fs.writeFileSync(output+'.'+attempt+'.partial',await zip.generateAsync({type:'nodebuffer'}));
        }
        if(this.stopped||current.state!=='running')throw Error('Interrupted');fs.renameSync(output+'.'+attempt+'.partial',output);
        let lufsNote='';
        if(current.format==='wav'){
          try{const stderr=await this.runFfmpegRaw(['-i',output,'-filter_complex','ebur128=peak=true','-f','null','-']);
            const integrated=/I:\\s+(-?\\d+\\.\\d) LUFS/.exec(stderr)?.[1],peak=/Peak:\\s+(-?\\d+\\.\\d) dBFS/.exec(stderr)?.[1];
            if(integrated)lufsNote=` · مقاس ${integrated} LUFS${peak?` وذروة ${peak} dBFS`:''}`;
          }catch{/* measurement is informational */}
        }
        current.path=relative;current.state='done';current.message=(current.format==='wav'?`مكتمل — صوت WAV${current.loudnessTarget!=null?` مُسوّى إلى ${current.loudnessTarget} LUFS`:''}`:'مكتمل — مسارات منفصلة ZIP')+lufsNote;this.persist(current);
      }else{
      fs.writeFileSync(path.join(dir,'parts.txt'),`);

// close the else after the video finalize
rep(`      if(this.stopped||current.state!=='running')throw Error('Interrupted');fs.renameSync(output+'.'+attempt+'.partial',output);current.path=relative;current.state='done';current.message='مكتمل ومحفوظ';this.persist(current);
    }catch(e){`,
`      if(this.stopped||current.state!=='running')throw Error('Interrupted');fs.renameSync(output+'.'+attempt+'.partial',output);current.path=relative;current.state='done';current.message='مكتمل ومحفوظ';this.persist(current);
      }
    }catch(e){`);

// ffmpeg helper gains optional stdin bytes for stem wav writes
rep(`private ffmpeg(args:string[]){return new Promise<void>((resolve,reject)=>{const executable=path.join(ROOT,'node_modules','ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');const child=spawn(executable,['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,stdio:['ignore','ignore','pipe']});`,
`private ffmpeg(args:string[],control?:{process:(child:ChildProcess|undefined)=>void},stdin=false,stdinData?:Buffer){return new Promise<void>((resolve,reject)=>{const executable=path.join(ROOT,'node_modules','ffmpeg-static',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');const child=spawn(executable,['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,stdio:[stdin?'pipe':'ignore','ignore','pipe']});if(control)control.process(child);else this.process=child;`);

// feed stdinData when provided and wire resolve on stdin closure
rep(`let error='';child.stderr?.on('data',data=>{error=(error+data).slice(-2000);});child.once('error',reject);child.once('exit',code=>{if(this.process===child)this.process=undefined;code===0?resolve():reject(Error('تعذّر ترميز التصدير: '+error));});});}`,
`let error='';child.stderr?.on('data',data=>{error=(error+data).slice(-2000);});child.once('error',reject);child.once('exit',code=>{if(this.process===child)this.process=undefined;code===0?resolve():reject(Error('تعذّر ترميز التصدير: '+error));});child.stdin?.on('error',()=>{});if(stdinData&&child.stdin)child.stdin.end(stdinData);});}`);
fs.writeFileSync(p,s);console.log('server cycle-6 wired');
