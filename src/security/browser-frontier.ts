import {inScope,type CampaignScope} from './scope.js';

type Reason='depth'|'pages'|'queue'|'interrupted';
export interface BrowserDiscovery {
  incomplete:boolean;
  limits:Record<Reason,number>;
  linkLimitedPages:number;
  unvisited:Array<{url:string;reason:Reason}>;
}

// Tracks known rendered links, not a claim to enumerate all application routes.
export class BrowserFrontier {
  private queue:Array<{url:string;depth:number}>;
  private queued:Set<string>;
  private visited=new Set<string>();
  private deferred=new Map<string,Reason>();
  private linkLimitedPages=0;
  constructor(private scope:CampaignScope){
    this.queue=[...new Set(scope.seeds)].map(url=>({url,depth:0}));
    this.queued=new Set(this.queue.map(p=>p.url));
  }
  next(){const page=this.queue.shift();if(page){this.queued.delete(page.url);this.visited.add(page.url);this.deferred.delete(page.url);}return page;}
  add(links:string[],depth:number,limited:boolean){
    if(limited)this.linkLimitedPages++;
    for(const link of links){
      let u:URL;try{u=new URL(link);}catch{continue;}
      if(u.search||u.hash||!inScope(this.scope,u.href)||this.visited.has(u.href)||this.queued.has(u.href))continue;
      if(depth>=this.scope.maxDepth){if(!this.deferred.has(u.href))this.deferred.set(u.href,'depth');continue;}
      if(this.queue.length>=100){this.deferred.set(u.href,'queue');continue;}
      this.deferred.delete(u.href);this.queued.add(u.href);this.queue.push({url:u.href,depth:depth+1});
    }
  }
  snapshot(interrupted=false,redact=(value:string)=>value):BrowserDiscovery{
    const pending=new Map(this.deferred);
    for(const page of this.queue)pending.set(page.url,interrupted?'interrupted':'pages');
    const limits:Record<Reason,number>={depth:0,pages:0,queue:0,interrupted:0};
    for(const reason of pending.values())limits[reason]++;
    return {incomplete:pending.size>0||this.linkLimitedPages>0,limits,linkLimitedPages:this.linkLimitedPages,unvisited:[...pending].slice(0,100).map(([url,reason])=>({url:redact(url),reason}))};
  }
}
