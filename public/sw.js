import {dbGet,chunkKey,CHUNK,MEDIA} from './offline.js';
const SHELL='polka-shell-v5';
const ASSETS=['/','/app.js','/player-audio.js','/offline.js','/style.css','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(SHELL).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith('polka-shell-')&&k!==SHELL)await caches.delete(k);await self.clients.claim();})());});
async function audio(req,url){
 const manifest=await dbGet(url.pathname);
 if(!manifest?.version||manifest.complete===false||req.headers.has('X-Polka-Download'))return fetch(req);
 // Validate cached bytes against the live file when the server is reachable.
 try{
  const live=await fetch(new Request(req.url,{method:'HEAD',headers:{'X-Polka-Download':'1'},cache:'no-store',signal:globalThis.AbortSignal?.timeout(3000)}));
  if(live.status===401||live.status===404)return live;
  if(live.ok&&live.headers.get('ETag')!==JSON.stringify(manifest.version))return fetch(req);
 }catch{/* The verified download remains usable without a network. */}
 const size=manifest.size;let start=0,end=size-1;const header=req.headers.get('Range');
 if(header){const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));end=m[1]?(m[2]?Number(m[2]):size-1):size-1;end=Math.min(end,size-1);if(start>end||start>=size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});}
 const cache=await caches.open(MEDIA);const first=Math.floor(start/CHUNK),last=Math.floor(end/CHUNK);
 // A storage eviction must never silently look like a complete download.
 const keys=new Set((await cache.keys()).map(key=>new URL(key.url).pathname));
 for(let n=first;n<=last;n++)if(!keys.has(chunkKey(manifest.id,manifest.index,n)))return fetch(req);
 const headers={'Content-Type':manifest.type,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store'};if(header)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
 if(req.method==='HEAD')return new Response(null,{status:header?206:200,headers});
 let part=first;const stream=new ReadableStream({async pull(controller){try{if(part>last){controller.close();return;}const res=await cache.match(chunkKey(manifest.id,manifest.index,part));const b=new Uint8Array(await res.arrayBuffer());const lo=part===first?start%CHUNK:0,hi=part===last?end%CHUNK+1:b.length;controller.enqueue(b.subarray(lo,hi));part++;}catch(e){controller.error(e);}}});
 return new Response(stream,{status:header?206:200,headers});
}
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);if(url.origin!==self.location.origin||!['GET','HEAD'].includes(req.method))return;
 if(/^\/api\/books\/[^/]+\/audio\/\d+$/.test(url.pathname)){event.respondWith(audio(req,url));return;}
 if(url.pathname.endsWith('/cover')){event.respondWith(caches.open(MEDIA).then(async c=>(await c.match(req))||fetch(req)));return;}
 if(req.mode==='navigate'){event.respondWith(fetch(req).catch(()=>caches.match('/')));return;}
 if(ASSETS.includes(url.pathname))event.respondWith(caches.match(req).then(c=>c||fetch(req)));
});
