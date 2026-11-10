export const CHUNK=4*1024*1024;
export const MEDIA='polka-media-v1';
let database;
export function openDB(){
 if(!database)database=new Promise((resolve,reject)=>{
  const r=indexedDB.open('polka-offline',1);
  r.onupgradeneeded=()=>r.result.createObjectStore('tracks');
  r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>{db.close();database=null;};db.onclose=()=>{database=null;};resolve(db);};
  r.onerror=()=>{database=null;reject(r.error);};
 });
 return database;
}
export async function dbGet(key){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction('tracks'),r=tx.objectStore('tracks').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function dbPut(key,value){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction('tracks','readwrite');if(value===null)tx.objectStore('tracks').delete(key);else tx.objectStore('tracks').put(value,key);tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error||Error('Не удалось сохранить скачивание'));});}
export const trackKey=(id,index)=>`/api/books/${id}/audio/${index}`;
export const chunkKey=(id,index,part)=>`/_offline/${id}/${index}/${part}`;
export async function cachedKeys(){return new Set((await(await caches.open(MEDIA)).keys()).map(key=>new URL(key.url).pathname));}
export async function isDownloaded(book,keys){
 keys??=await cachedKeys();
 for(const [i,t]of book.tracks.entries()){
  const manifest=await dbGet(trackKey(book.id,i));
  if(!manifest)return false;
  if(manifest.size!==t.size||manifest.version!==t.version||!t.version){await removeDownload(book);return false;}
  if(manifest.complete===false)return false;
  for(let n=0;n<Math.ceil(t.size/CHUNK);n++)if(!keys.has(chunkKey(book.id,i,n))){await dbPut(trackKey(book.id,i),{...manifest,complete:false});return false;}
 }
 return true;
}
export async function removeDownload(book){
 const cache=await caches.open(MEDIA);
 for(const key of await cache.keys())if(new URL(key.url).pathname.startsWith(`/_offline/${book.id}/`))await cache.delete(key);
 const db=await openDB();
 await new Promise((resolve,reject)=>{
  const tx=db.transaction('tracks','readwrite'),store=tx.objectStore('tracks'),cursor=store.openCursor();
  cursor.onsuccess=()=>{const c=cursor.result;if(c){if(String(c.key).startsWith(`/api/books/${book.id}/audio/`))c.delete();c.continue();}};
  tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);
 });
 await cache.delete(`/api/books/${book.id}/cover`);
}
export async function downloadedBytes(book){
 const keys=await cachedKeys();let received=0;
 for(const [i,t]of book.tracks.entries()){
  const manifest=await dbGet(trackKey(book.id,i));
  if(manifest?.size!==t.size||manifest?.version!==t.version||!t.version)continue;
  for(let n=0;n<Math.ceil(t.size/CHUNK);n++)if(keys.has(chunkKey(book.id,i,n)))received+=Math.min(CHUNK,t.size-n*CHUNK);
 }
 return received;
}
export async function download(book,signal,onProgress){
 const aborted=()=>{if(signal.aborted)throw new DOMException('Загрузка приостановлена','AbortError');};
 aborted();
 let timer,abortListener;
 try{await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(Error('Офлайн-режим не готов. Перезагрузи приложение с интернетом.')),15000);
  abortListener=()=>reject(new DOMException('Загрузка приостановлена','AbortError'));
  signal.addEventListener('abort',abortListener,{once:true});
 })]);}finally{clearTimeout(timer);signal.removeEventListener('abort',abortListener);}
 aborted();const cache=await caches.open(MEDIA),keys=await cachedKeys();let received=0;
 for(const [i,t]of book.tracks.entries()){
  const key=trackKey(book.id,i),old=await dbGet(key);
  // Invalidate unversioned or changed partial files before resuming a download.
  if(old?.size!==t.size||old?.version!==t.version||!t.version){
   for(const cached of keys)if(cached.startsWith(`/_offline/${book.id}/${i}/`)){await cache.delete(cached);keys.delete(cached);}
  }
  const manifest={version:t.version,size:t.size,count:Math.ceil(t.size/CHUNK),id:book.id,index:i,type:/\.m4[ab]$/i.test(t.name)?'audio/mp4':'audio/mpeg',complete:false};
  await dbPut(key,manifest);
  for(let n=0;n<manifest.count;n++){
   aborted();const partKey=chunkKey(book.id,i,n),start=n*CHUNK,end=Math.min(t.size-1,start+CHUNK-1);
   if(!keys.has(partKey)){
    const res=await fetch(key,{headers:{Range:`bytes=${start}-${end}`,'X-Polka-Download':'1'},signal,cache:'no-store'});
    if(res.status!==206||res.headers.get('Content-Range')!==`bytes ${start}-${end}/${t.size}`)throw Error(res.status===401?'Войди снова, чтобы скачать книгу':'Сервер не подтвердил часть файла');
    if(t.version&&res.headers.get('ETag')!==JSON.stringify(t.version))throw Error('Аудиофайл изменился. Обнови библиотеку и скачай книгу заново.');
    const buf=await res.arrayBuffer();if(buf.byteLength!==end-start+1)throw Error('Загрузка прервана. Можно продолжить.');
    aborted();await cache.put(partKey,new Response(buf,{headers:{'Content-Type':manifest.type}}));
   }
   received+=end-start+1;onProgress(received/book.size);
  }
  aborted();await dbPut(key,{...manifest,complete:true});
 }
 if(book.cover){try{const res=await fetch(book.cover,{signal});if(res.ok)await cache.put(book.cover,res);}catch{}}
 aborted();
}

// Clear the whole media store, including orphaned and unfinished downloads.
export async function clearOffline(){
 if(globalThis.caches){for(const name of await caches.keys())if(name.startsWith('polka-media-'))await caches.delete(name);
 if((await caches.keys()).some(name=>name.startsWith('polka-media-')))throw Error('Не удалось удалить аудиокэш');
 }
 if(!globalThis.indexedDB)return;
 const db=await openDB();await new Promise((resolve,reject)=>{const tx=db.transaction('tracks','readwrite');tx.objectStore('tracks').clear();tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||Error('Не удалось очистить офлайн-данные'));});
}
