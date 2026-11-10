import http from 'node:http';
import {createReadStream,createWriteStream,existsSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {mkdir,stat,statfs,rename,truncate,rm} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {dataDir,get,set,del,list,transaction} from './storage.mjs';
import {byteRange,probe,timeline} from './lib.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||8787),host=process.env.HOST||'127.0.0.1';
const production=process.env.NODE_ENV==='production';
const origin=process.env.ORIGIN||`http://localhost:${port}`;
const MAX_BOOK=3*1024**3, MAX_LIBRARY=Number(process.env.LIBRARY_LIMIT_GB||10)*1024**3;
const hash=s=>createHash('sha256').update(s).digest('hex');
if(!get('owner')&&!existsSync(path.join(dataDir,'setup-key.txt')))writeFileSync(path.join(dataDir,'setup-key.txt'),randomBytes(24).toString('hex'),{mode:0o600});
const fail=(status,message)=>Object.assign(new Error(message),{status});
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function json(req,limit=128*1024){let n=0,s='';for await(const b of req){n+=b.length;if(n>limit)throw fail(413,'Слишком большой запрос');s+=b;}try{return JSON.parse(s);}catch{throw fail(400,'Некорректный запрос');}}
function trackVersion(t){const s=existsSync(t.path)?statSync(t.path,{bigint:true}):null;return hash([t.version||'',s?.size,s?.mtimeNs,s?.ctimeNs].join(':'));}
function publicBook(b){const {source,sourceTracks,storedSize,...book}=b;return {...book,tracks:b.tracks.map(({path:p,...t})=>({...t,version:trackVersion({...t,path:p})})),cover:b.cover?`/api/books/${b.id}/cover`:null};}
async function serveFile(req,res,file,type,cache='private, no-cache'){
  const s=await stat(file),range=byteRange(req.headers.range,s.size);
  if(range===false){res.writeHead(416,{'Content-Range':`bytes */${s.size}`});return res.end();}
  const h={'Content-Type':type,'Accept-Ranges':'bytes','Cache-Control':cache,'Content-Length':range?range.end-range.start+1:s.size};
  if(range)h['Content-Range']=`bytes ${range.start}-${range.end}/${s.size}`;
  res.writeHead(range?206:200,h);if(req.method==='HEAD')return res.end();
  const stream=createReadStream(file,range||{});res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
}
const mime={'.mp3':'audio/mpeg','.m4a':'audio/mp4','.m4b':'audio/mp4','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json'};
const locks=new Set(),attempts=new Map();
export function clientAddress(req){
 const peer=req.socket.remoteAddress;
 // Only an explicitly configured immediate proxy may supply one client address.
 const trusted=(process.env.TRUSTED_PROXIES||'').split(',').map(s=>s.trim()).filter(Boolean);
 const forwarded=req.headers['x-forwarded-for'];
 return trusted.includes(peer)&&typeof forwarded==='string'&&isIP(forwarded.trim())?forwarded.trim():peer;
}
function rateLimit(req){const ip=clientAddress(req),now=Date.now();for(const [key,a]of attempts)if(a.until<now)attempts.delete(key);let a=attempts.get(ip);if(!a)a={count:0,until:now+60000};if(a.count>=12)throw fail(429,'Слишком много попыток. Подожди минуту.');a.count++;attempts.set(ip,a);}
let importQueue=Promise.resolve();
async function importLock(){let release;const next=new Promise(r=>release=r),previous=importQueue;importQueue=next;await previous;return release;}
const IMPORT_TTL=7*86400000;
function publishImport(job){transaction(()=>{set('book:'+job.id,job.pendingBook);const {pendingBook,...rest}=job;set('import:'+job.id,{...rest,status:'complete',bookId:job.id,updatedAt:Date.now()});});}
export async function maintainImports(now=Date.now()){
 for(const job of list('import:')){
  const dir=path.join(dataDir,'imports',job.id),dest=path.join(dataDir,'books',job.id);
  if(job.status==='finalizing'){
   if(!existsSync(dest))await rename(dir,dest);
   publishImport(job);
  }else if(job.status==='uploading'&&now-(job.updatedAt||job.createdAt)>IMPORT_TTL){
   await rm(dir,{recursive:true,force:true});del('import:'+job.id);
  }
 }
}
await maintainImports();
const maintenance=setInterval(async()=>{const release=await importLock();try{await maintainImports();}catch(e){console.error('Import maintenance:',e.message);}finally{release();}},3600000);maintenance.unref();

function session(req){const token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('polka='))?.slice(6);if(!token)return null;const s=get('session:'+hash(token));return s&&s.expires>Date.now()?s:null;}
function login(res){for(const s of list('session:'))if(s.expires<Date.now())del('session:'+s.id);const token=randomBytes(32).toString('hex');set('session:'+hash(token),{id:hash(token),expires:Date.now()+90*86400000});res.setHeader('Set-Cookie',`polka=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000${production?'; Secure':''}`);send(res,200,{ok:true});}
export const handler=async(req,res)=>{
  let releaseImport;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try{
    const url=new URL(req.url,origin),p=url.pathname,method=req.method;
    if(!['GET','HEAD'].includes(method)&&req.headers.origin!==origin)throw fail(403,'Недопустимый источник запроса');
    if(p==='/api/health')return send(res,200,{ok:true});
    if(p==='/api/auth'&&method==='GET')return send(res,200,{authenticated:!!session(req),setup:!get('owner')});
    if(p==='/api/setup'&&method==='POST'){
      rateLimit(req);if(get('owner'))throw fail(409,'Владелец уже настроен');const b=await json(req);
      const expected=readFileSync(path.join(dataDir,'setup-key.txt'),'utf8').trim();
      if(typeof b.key!=='string'||!timingSafeEqual(Buffer.from(hash(b.key.trim())),Buffer.from(hash(expected))))throw fail(403,'Неверный ключ настройки');
      if(typeof b.password!=='string'||b.password.length<12||b.password.length>256)throw fail(400,'Пароль должен содержать от 12 до 256 символов');
      const salt=randomBytes(16).toString('hex');set('owner',{salt,password:scryptSync(b.password,salt,64).toString('hex')});await rm(path.join(dataDir,'setup-key.txt'));return login(res);
    }
    if(p==='/api/login'&&method==='POST'){
      rateLimit(req);const b=await json(req),u=get('owner');if(!u||typeof b.password!=='string'||b.password.length>256||!timingSafeEqual(Buffer.from(u.password,'hex'),scryptSync(b.password,u.salt,64)))throw fail(401,'Неверный пароль');return login(res);
    }
    if(p==='/api/logout'&&method==='POST'){const s=session(req);if(s)del('session:'+s.id);res.setHeader('Set-Cookie','polka=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,200,{ok:true});}
    if(p.startsWith('/api/')){
      if(!session(req))throw fail(401,'Войди в свою библиотеку');
      if(p.startsWith('/api/imports')||p==='/api/storage'){releaseImport=await importLock();await maintainImports();}
      if(p==='/api/books'&&method==='GET')return send(res,200,{books:list('book:').map(publicBook),progress:list('progress:')});
      if(p==='/api/storage'&&method==='GET'){const s=await statfs(dataDir);return send(res,200,{used:list('book:').reduce((a,b)=>a+(b.storedSize??b.size),0),limit:MAX_LIBRARY,free:s.bavail*s.bsize});}
      const m=/^\/api\/books\/([a-zA-Z0-9-]+)(?:\/(cover|audio|progress|bookmarks)(?:\/(\d+))?)?$/.exec(p);
      if(m){
        const b=get('book:'+m[1]);if(!b)throw fail(404,'Книга не найдена');const action=m[2];
        if(!action&&method==='GET')return send(res,200,publicBook(b));
        if(action==='cover'&&['GET','HEAD'].includes(method)){if(!b.cover)throw fail(404,'Нет обложки');return await serveFile(req,res,b.cover,mime[path.extname(b.cover).toLowerCase()]||'image/jpeg');}
        if(action==='audio'&&['GET','HEAD'].includes(method)){const t=b.tracks[Number(m[3])];if(!t)throw fail(404,'Файл не найден');res.setHeader('ETag','"'+trackVersion(t)+'"');return await serveFile(req,res,t.path,mime[path.extname(t.path).toLowerCase()]);}
        if(action==='progress'&&method==='PUT'){
          const body=await json(req),prev=get('progress:'+b.id)||{revision:0};
          if(body.baseRevision!==prev.revision)throw fail(409,'Позиция изменена на другом устройстве');
          if(!Number.isFinite(body.time)||body.time<0||body.time>b.duration+1)throw fail(400,'Неверная позиция');
          const progress={bookId:b.id,time:body.time,speed:Math.min(3,Math.max(.5,Number(body.speed)||1)),updatedAt:Date.now(),revision:prev.revision+1};set('progress:'+b.id,progress);return send(res,200,progress);
        }
        if(action==='bookmarks'&&method==='GET')return send(res,200,get('marks:'+b.id)||[]);
        if(action==='bookmarks'&&method==='PUT'){const marks=await json(req);if(!Array.isArray(marks)||marks.length>500||marks.some(x=>!Number.isFinite(x.time)||x.time<0||x.time>b.duration||typeof x.title!=='string'||x.title.length>500))throw fail(400,'Некорректные закладки');set('marks:'+b.id,marks);return send(res,200,marks);}
      }
      if(p==='/api/imports'&&method==='POST'){
        const b=await json(req);if(typeof b.title!=='string'||!b.title.trim()||b.title.length>300||!Array.isArray(b.files)||!b.files.length||b.files.length>500)throw fail(400,'Укажи название и выбери до 500 файлов');
        let total=0;const files=b.files.map((f,i)=>{const ext=path.extname(f.name||'').toLowerCase();if(!['.mp3','.m4a','.m4b'].includes(ext)||!Number.isSafeInteger(f.size)||f.size<=0)throw fail(400,'Поддерживаются MP3, M4A и M4B');total+=f.size;return {name:String(f.name).slice(0,250),size:f.size,index:i,ext};});
        const free=await statfs(dataDir),used=list('book:').reduce((n,b)=>n+(b.storedSize??b.size),0),reserved=list('import:').filter(x=>x.status!=='complete').reduce((n,x)=>n+x.size,0);
        if(total>MAX_BOOK||used+reserved+total>MAX_LIBRARY||total>free.bavail*free.bsize-2*1024**3)throw fail(413,'Недостаточно места. Лимит одной книги — 3 ГБ.');
        const id=randomBytes(12).toString('hex');await mkdir(path.join(dataDir,'imports',id),{recursive:true});const job={id,title:b.title.trim(),author:String(b.author||'').slice(0,200),files,size:total,status:'uploading',createdAt:Date.now(),updatedAt:Date.now()};set('import:'+id,job);return send(res,201,job);
      }
      const im=/^\/api\/imports\/([a-f0-9]+)(?:\/(\d+|finish))?$/.exec(p);
      if(im){
        const job=get('import:'+im[1]);if(!job)throw fail(404,'Загрузка не найдена');
        const dir=path.join(dataDir,'imports',job.id);
        if(!im[2]&&method==='DELETE'){if(job.status==='complete')throw fail(409,'Книга уже добавлена');await rm(dir,{recursive:true,force:true});del('import:'+job.id);return send(res,200,{ok:true});}
        if(!im[2]&&method==='GET'){const offsets=await Promise.all(job.files.map(f=>stat(path.join(dir,String(f.index)+f.ext)).then(s=>s.size).catch(()=>0)));return send(res,200,{...job,offsets});}
        if(im[2]==='finish'&&method==='POST'){
          if(job.status==='complete')return send(res,200,{bookId:job.bookId});
          if(locks.has(job.id))throw fail(409,'Обработка уже выполняется');locks.add(job.id);
          try{
            const tracks=[];let embedded=[];
            for(const f of job.files){const file=path.join(dir,String(f.index)+f.ext);if((await stat(file).catch(()=>({size:0}))).size!==f.size)throw fail(400,'Не все файлы загружены');const info=await probe(file).catch(()=>{throw fail(400,`Не удалось прочитать аудио: ${f.name}`);});tracks.push({name:f.name,duration:info.duration,size:f.size,path:file});if(job.files.length===1)embedded=info.chapters;}
            const ts=timeline(tracks),duration=ts.reduce((s,t)=>s+t.duration,0);
            const dest=path.join(dataDir,'books',job.id);await mkdir(path.dirname(dest),{recursive:true});for(const t of ts)t.path=path.join(dest,path.basename(t.path));
            const book={id:job.id,title:job.title,author:job.author,tracks:ts,duration,size:job.size,chapters:embedded.length?embedded:ts.map(t=>({title:t.name.replace(/\.[^.]+$/,''),start:t.start,end:t.start+t.duration})),createdAt:Date.now(),cover:null};const pending={...job,status:'finalizing',pendingBook:book};set('import:'+job.id,pending);await rename(dir,dest);publishImport(pending);return send(res,200,{bookId:book.id});
          }finally{locks.delete(job.id);}
        }
        if(/^\d+$/.test(im[2])&&method==='PUT'){
          if(job.status!=='uploading'||locks.has(job.id))throw fail(409,'Книга уже обрабатывается');const f=job.files[Number(im[2])];if(!f)throw fail(404,'Файл не найден');
          const key=job.id+':'+f.index;if(locks.has(key))throw fail(409,'Файл уже загружается');locks.add(key);
          const target=path.join(dir,String(f.index)+f.ext);const size=await stat(target).then(s=>s.size).catch(()=>0);
          try{const offset=Number(req.headers['x-upload-offset']),len=Number(req.headers['content-length']);if(offset!==size)throw fail(409,'Продолжи загрузку с сохранённой позиции');if(!Number.isSafeInteger(len)||len<=0||len>8*1024**2||size+len>f.size)throw fail(413,'Некорректный размер части');
            let received=0;const guard=new Transform({transform(chunk,enc,cb){received+=chunk.length;cb(received>len?fail(413,'Слишком много данных'):null,chunk);}});
            try{await pipeline(req,guard,createWriteStream(target,{flags:'a',mode:0o600}));if(received!==len)throw Error('Передача прервана');}catch(e){await truncate(target,size).catch(()=>{});throw e;}set('import:'+job.id,{...job,updatedAt:Date.now()});return send(res,200,{offset:size+len});
          }finally{locks.delete(key);}
        }
      }
      throw fail(404,'Не найдено');
    }
    if(!['GET','HEAD'].includes(method))throw fail(405,'Метод не поддерживается');
    const staticFiles=new Set(['/','/index.html','/app.js','/player-audio.js','/offline.js','/style.css','/sw.js','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png']);
    if(!staticFiles.has(p))throw fail(404,'Не найдено');
    return await serveFile(req,res,path.join(root,'public',p==='/'?'index.html':p),mime[path.extname(p)]||(p==='/'?'text/html; charset=utf-8':'application/octet-stream'),'no-cache');
  }catch(e){if(res.headersSent){res.destroy();return;}send(res,e.status||500,{error:e.status?e.message:'Не удалось выполнить действие. Попробуй ещё раз.'});if(!e.status)console.error(e.message);}finally{releaseImport?.();}
};
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=http.createServer(handler);
 server.requestTimeout=120000;
 server.on('error',e=>{console.error(`Не удалось запустить сервер: ${e.code} (${host}:${port})`);process.exitCode=1;});
 server.listen(port,host,()=>console.log(`Полка: ${origin} (bind ${host}:${port})`));
}
