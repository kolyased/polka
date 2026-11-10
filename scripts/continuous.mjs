// Prepare uninterrupted playback without changing book IDs or chapter offsets.
import path from 'node:path';
import {writeFile,rename,stat,statfs,rm,mkdir} from 'node:fs/promises';
import {get,set,list,dataDir} from '../storage.mjs';
import {run,probe,continuousSpaceNeeded} from '../lib.mjs';
const timeoutMs=Number(process.env.CONTINUOUS_TIMEOUT_SECONDS||21600)*1000;
if(!Number.isFinite(timeoutMs)||timeoutMs<30000||timeoutMs>86400000)throw Error('CONTINUOUS_TIMEOUT_SECONDS must be 30..86400');
const lock=path.join(dataDir,'continuous.lock');await mkdir(lock);
try{for(const b of list('book:')){
 if(b.tracks.length<2)continue;
 const dir=path.dirname(b.tracks[0].path),manifest=path.join(dir,'continuous.ffconcat');
 const specs=[];
 for(const t of b.tracks){const p=JSON.parse(await run('ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,channels','-of','json',t.path]));specs.push(p.streams[0]);}
 const copy=specs.every(s=>s.codec_name==='mp3'&&JSON.stringify(s)===JSON.stringify(specs[0]));
 const ext=copy?'.mp3':'.m4b',temporary=path.join(dir,'continuous.tmp'+ext),output=path.join(dir,'continuous'+ext);
 const disk=await statfs(dir),needed=continuousSpaceNeeded({copy,size:b.size,duration:b.duration});
 if(disk.bavail*disk.bsize<needed)throw Error('Недостаточно места для непрерывного файла и резерва 2 ГБ');
 try{
 await writeFile(manifest,b.tracks.map(t=>"file '"+t.path.replaceAll("'","'\\''")+"'").join('\n'));
 await run('ffmpeg',['-nostdin','-y','-v','error','-f','concat','-safe','0','-i',manifest,'-map','0:a:0',...(copy?['-c:a','copy']:['-c:a','aac','-b:a','96k','-movflags','+faststart']),temporary],{timeoutMs});
 const info=await probe(temporary);if(Math.abs(info.duration-b.duration)>Math.max(3,b.duration*.001))throw Error('Duration mismatch; originals retained');
 await rename(temporary,output);const size=(await stat(output)).size;
 set('book:'+b.id,{...b,sourceTracks:b.tracks,storedSize:b.size+size,size,tracks:[{index:0,name:b.title+ext,path:output,duration:info.duration,size,start:0}],duration:info.duration,chapters:b.chapters.map(c=>({...c,end:Math.min(c.end,info.duration)}))});
 }finally{await rm(temporary,{force:true});await rm(manifest,{force:true});}
 console.log(b.title+': continuous playback ready; original files retained');
}

}finally{await rm(lock,{recursive:true,force:true});}
