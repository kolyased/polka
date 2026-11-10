import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf("$('#logout').onclick="),app.indexOf('\nfunction connection'));
function scenario({cleanupFails=false,dirtyMarks=false,dirtyPosition=false,download=false}={}){
 const events=[],button={},storage={...(dirtyMarks?{'marks:b:dirty':true}:{}),clear(){events.push('local-clear');delete this['marks:b:dirty'];},get length(){return this['marks:b:dirty']?1:0;}};
 let pending=null;
 if(download){let resolve;const done=new Promise(r=>resolve=r);pending={done,controller:{abort(){events.push('abort');queueMicrotask(()=>{events.push('download-settled');resolve();});}}};}
 const ctx={$:()=>button,confirm:()=>true,loggingOut:false,localStateCleared:false,audio:{pause(){},removeAttribute(){},load(){}},remember(){},downloading:pending,uploadController:null,syncing:false,sync:async()=>events.push('sync'),syncMarks:async()=>events.push('marks'),positions:dirtyPosition?{b:{dirty:true}}:{},localStorage:storage,read:k=>storage[k],audioLoader:{cancel(){}},clearTimer(){},navigator:{},clearOffline:async()=>{events.push('cleanup');if(cleanupFails)throw Error('cache failed');},post:async()=>events.push('revoke'),location:{reload:()=>events.push('reload')},toast:message=>events.push(message),setTimeout};
 vm.runInNewContext(source,ctx);return {run:()=>button.onclick(),events};
}
test('logout waits for download cancellation and cleans storage before revoking the session',async()=>{const s=scenario({download:true});await s.run();assert.deepEqual(s.events,['abort','download-settled','sync','marks','cleanup','local-clear','revoke','reload']);});
test('cleanup failure keeps the session available for a retry and reports failure',async()=>{const s=scenario({cleanupFails:true});await s.run();assert.ok(!s.events.includes('revoke'));assert.ok(!s.events.includes('reload'));assert.match(s.events.at(-1),/cache failed/);});
test('dirty bookmarks and dirty positions both prevent data deletion and logout',async()=>{for(const option of ['dirtyMarks','dirtyPosition']){const s=scenario({[option]:true});await s.run();assert.ok(!s.events.includes('cleanup'));assert.ok(!s.events.includes('revoke'));}});
