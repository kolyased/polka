import {readdir,stat,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {dataDir,set,list} from '../storage.mjs';
import {probe,timeline,natural} from '../lib.mjs';
if(!process.argv[2]){console.error('Usage: npm run import -- /path/to/audiobooks');process.exit(1);}
const source=path.resolve(process.argv[2]);
async function visit(dir){
 const entries=await readdir(dir,{withFileTypes:true});const audio=entries.filter(e=>e.isFile()&&/\.(mp3|m4[ab])$/i.test(e.name)).sort((a,b)=>natural.compare(a.name,b.name));
 if(audio.length){
  if(list('book:').some(b=>b.source===dir)){console.log('Уже импортировано:',path.basename(dir));return;}
  const id=randomBytes(12).toString('hex'),dest=path.join(dataDir,'books',id);await mkdir(dest,{recursive:true});let tracks=[],chapters=[];
  for(const [index,f] of audio.entries()){const from=path.join(dir,f.name),to=path.join(dest,`${index}${path.extname(f.name).toLowerCase()}`);const info=await probe(from);await copyFile(from,to);tracks.push({name:f.name,path:to,duration:info.duration,size:(await stat(from)).size});if(audio.length===1)chapters=info.chapters;}
  tracks=timeline(tracks);let cover=null;const image=entries.find(e=>/^cover\.(jpg|png|jpeg|webp)$/i.test(e.name));if(image){cover=path.join(dest,image.name);await copyFile(path.join(dir,image.name),cover);}
  let title=audio.length===1?audio[0].name.replace(/\.mp3$/i,'').replaceAll('_',' '):path.basename(dir);let author='';

  const book={id,title,author,source:dir,cover,tracks,chapters:chapters.length?chapters:tracks.map(t=>({title:t.name.replace(/\.[^.]+$/,''),start:t.start,end:t.start+t.duration})),duration:tracks.reduce((n,t)=>n+t.duration,0),size:tracks.reduce((n,t)=>n+t.size,0),createdAt:Date.now()};set('book:'+id,book);console.log(`${title}: ${tracks.length} файлов, ${Math.round(book.duration/60)} мин`);
 }else for(const e of entries)if(e.isDirectory())await visit(path.join(dir,e.name));
}
await visit(source);
