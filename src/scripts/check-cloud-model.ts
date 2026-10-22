import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {OllamaClient,IncompleteModelStream,type ChatMessage,type OllamaFunctionTool} from '../ollama.js';

const seen:{cloud:{path:string;auth?:string;body:any};ollama:{path:string;body:any}}={cloud:{path:'',body:null},ollama:{path:'',body:null}};
let cloudReply:{content:string[];toolFragments?:Array<{index:number;id?:string;name?:string;args?:string}>;finish?:string;usage?:object;noFinish?:boolean}={content:['مرح','با ']};
const startCloud=async():Promise<Server>=>{
 const server=createServer((req,res)=>{
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   seen.cloud={path:req.url!,auth:req.headers.authorization,body:raw?JSON.parse(raw):null};
   if(req.url!.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'openai/gpt-5.3'},{id:'deepseek/deepseek-chat-v4'}]}));return;}
   if(!req.url!.endsWith('/chat/completions')){res.statusCode=404;res.end('{}');return;}
   res.setHeader('content-type','text/event-stream');
   const send=(obj:any)=>res.write(`data: ${JSON.stringify(obj)}\n\n`);
   for(const piece of cloudReply.content)send({model:'openai/gpt-5.3',choices:[{delta:{content:piece}}]});
   for(const frag of cloudReply.toolFragments??[])
    send({model:'openai/gpt-5.3',choices:[{delta:{tool_calls:[{index:frag.index,...(frag.id?{id:frag.id}:{}),function:{...(frag.name?{name:frag.name}:{}),...(frag.args?{arguments:frag.args}:{})}}]}}]});
   if(cloudReply.usage)send({model:'openai/gpt-5.3',choices:[{}],usage:cloudReply.usage});
   if(!cloudReply.noFinish)send({model:'openai/gpt-5.3',choices:[{delta:{},finish_reason:cloudReply.finish??'stop'}]});
   res.write('data: [DONE]\n\n');res.end();
  });
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return server;
};
const startOllama=async():Promise<Server>=>{
 const server=createServer((req,res)=>{
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   seen.ollama={path:req.url!,body:raw?JSON.parse(raw):null};
   if(req.url==='/api/tags'){res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{name:'qwen2.5:14b'}]}));return;}
   res.setHeader('content-type','application/x-ndjson');
   res.end(JSON.stringify({model:'qwen2.5:14b',message:{role:'assistant',content:'محلي'},done:true,done_reason:'stop',prompt_eval_count:3,eval_count:2})+'\n');
  });
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return server;
};
const ollama=await startOllama(),cloud=await startCloud();
const ollamaPort=(ollama.address() as any).port,cloudPort=(cloud.address() as any).port;
try{
 const client=new OllamaClient(`http://127.0.0.1:${ollamaPort}`,{baseUrl:`http://127.0.0.1:${cloudPort}/v1`,apiKey:'test-key-123'});
 const tools:OllamaFunctionTool[]=[{type:'function',function:{name:'file_write',description:'كتابة ملف',parameters:{type:'object',properties:{path:{type:'string'}}}}}];

 // Text streams token-by-token through the cloud provider; usage and finish reason map back.
 const tokens:string[]=[];
 cloudReply={content:['أهلاً ','بك'],finish:'stop',usage:{prompt_tokens:11,completion_tokens:7}};
 const text=await client.chat({model:'openai/gpt-5.3:cloud',messages:[{role:'user',content:'سلام'}],tools,onToken:t=>tokens.push(t),timeoutMs:10_000});
 assert.equal(text.content,'أهلاً بك');
 assert.deepEqual(tokens,['أهلاً ','بك']);
 assert.equal(text.model,'openai/gpt-5.3:cloud');
 assert.equal(text.doneReason,'stop');
 assert.equal(text.usage.promptTokens,11);assert.equal(text.usage.completionTokens,7);
 assert.equal(seen.cloud.path,'/v1/chat/completions');
 assert.equal(seen.cloud.auth,'Bearer test-key-123');
 assert.equal(seen.cloud.body.model,'openai/gpt-5.3','suffix stripped for the provider');
 assert.equal(seen.cloud.body.tools[0].function.name,'file_write');
 assert.deepEqual(seen.cloud.body.stream_options,{include_usage:true});

 // Tool-call fragments assemble across deltas with parsed JSON arguments.
 cloudReply={content:[''],toolFragments:[{index:0,id:'call_1',name:'file_'},{index:0,name:'write'},{index:0,args:'{"pa'},{index:0,args:'th":"a.txt"}'}],finish:'tool_calls',usage:{prompt_tokens:20,completion_tokens:9}};
 const toolResult=await client.chat({model:'deepseek/deepseek-chat-v4:cloud',messages:[{role:'user',content:'اكتب ملف'}],timeoutMs:10_000});
 assert.equal(toolResult.toolCalls.length,1);
 assert.ok(toolResult.toolCalls[0], 'assembled tool call must exist');
 assert.equal(toolResult.toolCalls[0].function.name,'file_write');
 assert.deepEqual(toolResult.toolCalls[0].function.arguments,{path:'a.txt'});
 assert.equal(toolResult.doneReason,'tool_calls');

 // Images become OpenAI content parts; tool history gets matching tool_call ids.
 const history:ChatMessage[]=[
  {role:'user',content:'انظر',images:['AAAA']},
  {role:'assistant',content:'',tool_calls:[{function:{name:'file_write',arguments:{path:'b.txt'}}}]},
  {role:'tool',content:'تم',tool_name:'file_write'},
 ];
 await client.chat({model:'openai/gpt-5.3:cloud',messages:history,timeoutMs:10_000});
 const sent=seen.cloud.body.messages;
 assert.equal(sent[0].content[0].type,'text');
 assert.equal(sent[0].content[1].image_url.url,'data:image/png;base64,AAAA');
 assert.ok(/^loam_\d+_\d+$/.test(sent[1].tool_calls[0].id),'assistant tool calls get ids');
 assert.equal(sent[2].tool_call_id,sent[1].tool_calls[0].id,'tool replies reference the matching id');
 assert.equal(sent[2].role,'tool');

 // Local models keep hitting the Ollama endpoint untouched, with or without a cloud provider.
 const local=await client.chat({model:'qwen2.5:14b',messages:[{role:'user',content:'مرحبا'}],timeoutMs:10_000});
 assert.equal(local.content,'محلي');
 assert.equal(seen.ollama.path,'/api/chat');
 assert.equal(seen.ollama.body.model,'qwen2.5:14b');
 // A ":cloud" name without a configured provider passes through to the local endpoint unchanged.
 const passthrough=new OllamaClient(`http://127.0.0.1:${ollamaPort}`);
 const viaLocal=await passthrough.chat({model:'glm-5.3-flash:cloud',messages:[{role:'user',content:'x'}],timeoutMs:10_000});
 assert.equal(viaLocal.content,'محلي');
 assert.equal(seen.ollama.body.model,'glm-5.3-flash:cloud');

 // Model listing merges the provider catalog with local tags, suffixed for routing.
 const models=await client.listModels();
 assert.ok(models.includes('qwen2.5:14b'));
 assert.ok(models.includes('openai/gpt-5.3:cloud'));
 assert.ok(models.includes('deepseek/deepseek-chat-v4:cloud'));

 // Transport DONE does not certify a complete model choice. Even syntactically
 // valid partial verdicts or tool arguments must not reach the caller as success.
 for (const incomplete of [
  {content:[],noFinish:true},
  {content:['{"verdict":"pass"}'],noFinish:true},
  {content:[],toolFragments:[{index:0,name:'file_write',args:'{"path":"a.txt"}'}],noFinish:true},
 ]) {
  cloudReply=incomplete;
  await assert.rejects(()=>client.chat({model:'openai/gpt-5.3:cloud',messages:[{role:'user',content:'x'}],timeoutMs:10_000}),e=>e instanceof IncompleteModelStream);
 }
 console.log('PASS cloud model routing and complete text/tool streams; empty, partial verdict and partial tool streams rejected even with transport DONE');
}finally{ollama.closeAllConnections();cloud.closeAllConnections();await new Promise<void>(r=>{ollama.close(()=>r());});await new Promise<void>(r=>{cloud.close(()=>r());});}
