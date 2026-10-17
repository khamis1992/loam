import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
const allowed=new Set(['index.html','app.js','style.css','mobile.png','office.png','security.png','creative.png','swarm.png']);
const server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!allowed.has(name)){res.writeHead(404);res.end();return;}try{const bytes=await readFile(new URL(name,import.meta.url));const ext=name.split('.').pop();res.setHeader('Content-Type',({html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',png:'image/png'})[ext]);res.end(bytes);}catch{res.writeHead(500);res.end();}});
server.listen(0,'127.0.0.1',async()=>{await writeFile(new URL('preview-url.txt',import.meta.url),'http://127.0.0.1:'+server.address().port+'/');});
