import {spawn} from 'node:child_process';
export const natural = new Intl.Collator('ru', {numeric:true,sensitivity:'base'});
export function byteRange(header,size) {
  if (!header) return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!m || (!m[1]&&!m[2])) return false;
  let start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));
  let end=m[1]?(m[2]?Number(m[2]):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end) return false;
  return {start,end:Math.min(end,size-1)};
}
export function run(cmd,args,{timeoutMs=120000}={}){return new Promise((resolve,reject)=>{const p=spawn(cmd,args);let out='',err='';const timer=setTimeout(()=>p.kill('SIGKILL'),timeoutMs);p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',c=>{clearTimeout(timer);c===0?resolve(out):reject(new Error(err.slice(-500)||'Не удалось прочитать аудиофайл'));});});}
export async function probe(file){
  if(process.platform==='darwin') {const s=await run('/usr/bin/afinfo',[file]);const duration=Number(s.match(/estimated duration:\s*([\d.]+)/)?.[1]);if(!duration)throw Error('Не удалось определить длительность');return {duration,chapters:[]};}
  const p=JSON.parse(await run('ffprobe',['-v','error','-show_format','-show_streams','-show_chapters','-of','json',file]));
  const audio=p.streams?.find(s=>s.codec_type==='audio');
  const duration=Number(p.format.duration||audio?.duration);if(!audio||!Number.isFinite(duration)||duration<=0)throw Error('Файл не содержит поддерживаемое аудио');
  return {duration,chapters:(p.chapters||[]).map((c,i)=>({title:c.tags?.title||`Глава ${i+1}`,start:Number(c.start_time),end:Number(c.end_time)}))};
}
export function timeline(tracks){let offset=0;return tracks.map((t,i)=>{const out={...t,index:i,start:offset};offset+=t.duration;return out;});}
export function locate(tracks,seconds){let i=tracks.findLastIndex(t=>t.start<=seconds);i=Math.max(0,i);return {index:i,time:Math.max(0,Math.min(tracks[i].duration,seconds-tracks[i].start))};}

export function continuousSpaceNeeded({copy,size,duration}){return Math.ceil(copy?size*1.1:duration*12000*1.2)+2*1024**3;}
