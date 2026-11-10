import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const CHUNK=4*1024*1024, size=CHUNK+100;
const source=(await readFile(new URL('../public/sw.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
function worker({missing=false,manifest=true,complete=true,version='v1',liveVersion=null}={}){
 let callback;const cache=new Map();const a=new Uint8Array(CHUNK).fill(65),b=new Uint8Array(100).fill(66);cache.set('/_offline/b/0/0',new Response(a));if(!missing)cache.set('/_offline/b/0/1',new Response(b));
 const context={self:{location:{origin:'https://polka.test'},addEventListener:(event,fn)=>{if(event==='fetch')callback=fn;}},CHUNK,MEDIA:'test',dbGet:async()=>manifest?{version,size,id:'b',index:0,type:'audio/mpeg',complete}:null,chunkKey:(id,i,n)=>`/_offline/${id}/${i}/${n}`,caches:{open:async()=>({match:async k=>cache.get(k)?.clone(),keys:async()=>[...cache.keys()].map(k=>new Request('https://polka.test'+k))})},fetch:async req=>req?.method==='HEAD'&&liveVersion?new Response(null,{headers:{ETag:JSON.stringify(liveVersion)}}):new Response('network',{status:503}),URL,Request,Response,ReadableStream,Uint8Array};vm.runInNewContext(source,context);
 return async(range,method='GET')=>{let response;callback({request:new Request('https://polka.test/api/books/b/audio/0',{method,headers:range?{Range:range}:{}}),respondWith:p=>response=p});return response;};
}
test('offline range spans cache blocks and returns exact bytes',async()=>{const fetch=worker(),r=await fetch(`bytes=${CHUNK-10}-${CHUNK+9}`);assert.equal(r.status,206);assert.equal(r.headers.get('Content-Length'),'20');assert.equal(await r.text(),'AAAAAAAAAABBBBBBBBBB');});
test('offline suffix, full response, HEAD, and unsatisfiable ranges',async()=>{const fetch=worker();assert.equal(await(await fetch('bytes=-5')).text(),'BBBBB');const all=await fetch();assert.equal(all.status,200);assert.equal((await all.arrayBuffer()).byteLength,size);const head=await fetch('bytes=0-9','HEAD');assert.equal(head.headers.get('Content-Length'),'10');assert.equal((await head.arrayBuffer()).byteLength,0);assert.equal((await fetch(`bytes=${size}-`)).status,416);});
test('evicted or incomplete downloads never pretend to be usable audio',async()=>{assert.equal((await worker({missing:true})(`bytes=${CHUNK}-`)).status,503);assert.equal((await worker({manifest:false})('bytes=0-5')).status,503);});

test('unfinished manifests always use network, never a truncated offline response',async()=>{assert.equal((await worker({complete:false})('bytes=0-5')).status,503);});

test('same-sized server replacements and unversioned caches are never served as current audio',async()=>{assert.equal((await worker({liveVersion:'v2'})('bytes=0-5')).status,503);assert.equal((await worker({version:null})('bytes=0-5')).status,503);assert.equal((await worker({liveVersion:'v1'})('bytes=0-5')).status,206);});
