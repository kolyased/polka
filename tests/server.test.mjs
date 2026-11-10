import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {Readable,Writable} from 'node:stream';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const temp=await mkdtemp(path.join(os.tmpdir(),'polka-test-'));process.env.DATA_DIR=temp;
const {handler}=await import('../server.mjs');const {set,get,db}=await import('../storage.mjs');
after(async()=>{db.close();await rm(temp,{recursive:true,force:true});});
let cookie;
async function request(url,method='GET',body,headers={}){
 const buffer=body===undefined?Buffer.alloc(0):Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
 const req=Readable.from(buffer.length?[buffer]:[]);req.url=url;req.method=method;req.headers={origin:'http://localhost:8787',...(cookie?{cookie}:{}),'content-length':String(buffer.length),...headers};req.socket={remoteAddress:'127.0.0.1'};
 const chunks=[];const res=new Writable({write(chunk,enc,cb){chunks.push(chunk);cb();}});res.headers={};res.setHeader=(k,v)=>res.headers[k.toLowerCase()]=v;res.writeHead=(code,h={})=>{res.status=code;res.headersSent=true;for(const[k,v]of Object.entries(h))res.setHeader(k,v);};
 const done=new Promise((resolve,reject)=>{res.on('finish',resolve);res.on('error',reject);});await handler(req,res);await done;const data=Buffer.concat(chunks);return {status:res.status,headers:res.headers,data,json:()=>JSON.parse(data.toString())};
}
test('private library, owner setup, login and cookie',async()=>{
 assert.equal((await request('/api/books')).status,401);
 assert.equal((await request('/api/setup','POST',{key:'wrong',password:'example-password'})).status,403);
 const key=(await readFile(path.join(temp,'setup-key.txt'),'utf8')).trim();const r=await request('/api/setup','POST',{key,password:'example-password'});assert.equal(r.status,200);assert.match(r.headers['set-cookie'],/HttpOnly/);cookie=r.headers['set-cookie'].split(';')[0];assert.equal((await request('/api/books')).status,200);
 assert.equal((await request('/api/setup','POST',{key,password:'example-password'})).status,409);
});
test('CSRF rejects cross-origin mutations',async()=>assert.equal((await request('/api/imports','POST',{}, {origin:'https://evil.test'})).status,403));
test('authenticated audio supports byte and suffix ranges; no filesystem path leaks',async()=>{
 const file=path.join(temp,'audio.mp3');await writeFile(file,Buffer.from('0123456789'));set('book:test',{id:'test',title:'Test',duration:21600,size:10,cover:null,tracks:[{path:file,name:'book.mp3',duration:21600,size:10,start:0}],chapters:[]});
 const r=await request('/api/books/test/audio/0','GET',undefined,{range:'bytes=3-6'});assert.equal(r.status,206);assert.equal(r.data.toString(),'3456');assert.equal(r.headers['content-range'],'bytes 3-6/10');assert.equal((await request('/api/books/test/audio/0','GET',undefined,{range:'bytes=-3'})).data.toString(),'789');assert.equal((await request('/api/books/test/audio/0','GET',undefined,{range:'bytes=10-'})).status,416);
 assert.equal('path'in(await request('/api/books')).json().books[0].tracks[0],false);
});
test('revision conflict cannot overwrite progress with stale offline state',async()=>{
 const r=await request('/api/books/test/progress','PUT',{time:18000,speed:1.25,baseRevision:0});assert.equal(r.status,200);assert.equal(r.json().revision,1);
 assert.equal((await request('/api/books/test/progress','PUT',{time:10,baseRevision:0})).status,409);assert.equal(get('progress:test').time,18000);
 assert.equal((await request('/api/books/test/progress','PUT',{time:17000,baseRevision:1})).status,200);
});
test('continuous playback retains originals privately and counts their disk space',async()=>{
 const original=get('book:test');
 try {
  set('book:test',{...original,sourceTracks:[{path:'/private/original.mp3',size:20}],storedSize:30});
  const book=(await request('/api/books/test')).json();
  assert.equal('sourceTracks' in book,false);
  assert.equal('storedSize' in book,false);
  assert.equal(book.size,10);
  assert.equal((await request('/api/storage')).json().used,30);
 }finally{set('book:test',original);}
});
test('resumable upload enforces offsets, length and rejects non-audio names',async()=>{
 assert.equal((await request('/api/imports','POST',{title:'x',files:[{name:'evil.html',size:10}]})).status,400);
 const r=await request('/api/imports','POST',{title:'Test import',files:[{name:'../../x.mp3',size:10}]});assert.equal(r.status,201);const id=r.json().id;
 assert.equal((await request(`/api/imports/${id}/0`,'PUT',Buffer.from('12345'),{'x-upload-offset':'0'})).status,200);
 assert.equal((await request(`/api/imports/${id}/0`,'PUT',Buffer.from('67890'),{'x-upload-offset':'0'})).status,409);
 assert.equal((await request(`/api/imports/${id}`)).json().offsets[0],5);
 assert.equal((await request(`/api/imports/${id}/0`,'PUT',Buffer.from('67890'),{'x-upload-offset':'5'})).status,200);
 assert.equal((await readFile(path.join(temp,'imports',id,'0.mp3'))).toString(),'1234567890');
 assert.equal((await request(`/api/imports/${id}/finish`,'POST',{})).status,400);
 assert.equal(get('book:'+id),null);
});
test('unknown static paths cannot read configuration',async()=>{assert.equal((await request('/storage.mjs')).status,404);assert.equal((await request('/data/library.sqlite')).status,404);});

test('forwarded client addresses require an explicit trusted peer and a single valid IP',async()=>{
 const {clientAddress}=await import('../server.mjs');
 const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'203.0.113.5'}};
 assert.equal(clientAddress(req),'127.0.0.1');
 process.env.TRUSTED_PROXIES='127.0.0.1';
 try{assert.equal(clientAddress(req),'203.0.113.5');req.headers['x-forwarded-for']='203.0.113.5, 203.0.113.6';assert.equal(clientAddress(req),'127.0.0.1');req.headers['x-forwarded-for']='garbage';assert.equal(clientAddress(req),'127.0.0.1');}finally{delete process.env.TRUSTED_PROXIES;}
});
test('replacing audio with equal-sized bytes changes the public version and ETag',async()=>{
 const before=(await request('/api/books/test')).json().tracks[0].version;
 await writeFile(path.join(temp,'audio.mp3'),'abcdefghij');
 const after=(await request('/api/books/test')).json().tracks[0].version;
 assert.notEqual(after,before);
 assert.equal((await request('/api/books/test/audio/0','HEAD')).headers.etag,JSON.stringify(after));
});
test('expired reservations are released and unfinished imports can be explicitly cancelled',async()=>{
 const {mkdir}=await import('node:fs/promises');
 const id='deadbeef';await mkdir(path.join(temp,'imports',id),{recursive:true});
 set('import:'+id,{id,status:'uploading',createdAt:Date.now()-8*86400000,size:100,files:[]});
 assert.equal((await request('/api/storage')).status,200);assert.equal(get('import:'+id),null);
 const r=await request('/api/imports','POST',{title:'Cancel',files:[{name:'x.mp3',size:10}]});
 const job=r.json();assert.equal((await request('/api/imports/'+job.id,'DELETE')).status,200);assert.equal(get('import:'+job.id),null);
});
test('publication journal recovers a crash before or after directory rename',async()=>{
 const {mkdir,rename,stat}=await import('node:fs/promises');
 for(const moved of [false,true]){
  const id=moved?'abcdef01':'abcdef02',dir=path.join(temp,'imports',id),dest=path.join(temp,'books',id);
  await mkdir(dir,{recursive:true});await mkdir(path.dirname(dest),{recursive:true});await writeFile(path.join(dir,'0.mp3'),'audio');
  if(moved)await rename(dir,dest);
  set('import:'+id,{id,status:'finalizing',createdAt:Date.now(),pendingBook:{id,title:'Recovered',tracks:[{name:'audio.mp3',path:path.join(dest,'0.mp3'),size:5}],chapters:[]}});
  assert.equal((await request('/api/storage')).status,200);
  assert.equal(get('book:'+id).title,'Recovered');assert.equal(get('import:'+id).status,'complete');assert.equal((await stat(path.join(dest,'0.mp3'))).size,5);
 }
});
test('finish waits for an in-flight chunk and publishes valid audio exactly once',async()=>{
 const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
 const input=path.join(temp,'fixture.wav'),output=path.join(temp,'fixture.m4a');await writeFile(input,wav);
 const {execFileSync}=await import('node:child_process');
 if(process.platform==='darwin')execFileSync('/usr/bin/afconvert',['-f','m4af','-d','aac',input,output]);else execFileSync('ffmpeg',['-v','error','-i',input,'-c:a','aac',output]);
 const audio=await readFile(output);
 const job=(await request('/api/imports','POST',{title:'Valid audio',files:[{name:'test.m4a',size:audio.length}]})).json();
 // Starting both handlers in the same turn exercises serialization through validation and rename.
 const uploading=request(`/api/imports/${job.id}/0`,'PUT',audio,{'x-upload-offset':'0'});
 const finishing=request(`/api/imports/${job.id}/finish`,'POST',{});
 assert.equal((await uploading).status,200);const result=await finishing;assert.equal(result.status,200);
 assert.equal((await request(`/api/imports/${job.id}/finish`,'POST',{})).json().bookId,job.id);
 assert.equal(get('book:'+job.id).tracks.length,1);assert.equal(get('import:'+job.id).status,'complete');
});
