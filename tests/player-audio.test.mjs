import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {createAudioLoader} from '../public/player-audio.js';

class Audio extends EventTarget {
 duration=120; currentTime=0; playbackRate=1; calls=[];
 load(){this.calls.push('load');}
 play(){this.calls.push('play');return Promise.resolve();}
 metadata(){this.dispatchEvent(new Event('loadedmetadata'));}
}
const clean=a=>{assert.equal(getEventListeners(a,'loadedmetadata').length,0);assert.equal(getEventListeners(a,'error').length,0);};
test('play is requested inside the original tap; metadata restores position and speed',async()=>{
 const a=new Audio(),loader=createAudioLoader(a);
 const promise=loader.load({src:'/book',time:60,rate:1.5,play:true});
 assert.deepEqual(a.calls,['load','play']);a.metadata();await promise;
 assert.equal(a.currentTime,60);assert.equal(a.playbackRate,1.5);clean(a);
});
test('rapid book switching cancels stale metadata work and removes listeners',async()=>{
 const a=new Audio(),loader=createAudioLoader(a);
 const first=loader.load({src:'/first',time:90});const rejected=assert.rejects(first,{name:'AbortError'});
 const next=loader.load({src:'/second',time:12});a.metadata();await Promise.all([rejected,next]);
 assert.equal(a.currentTime,12);assert.equal(a.src,'/second');clean(a);
});
test('network failure and timeout can be retried without accumulating handlers',async()=>{
 const a=new Audio(),loader=createAudioLoader(a,10);
 const failed=loader.load({src:'/bad'});a.dispatchEvent(new Event('error'));await assert.rejects(failed);clean(a);
 await assert.rejects(loader.load({src:'/stalled'}));clean(a);
 const retry=loader.load({src:'/good'});a.metadata();await retry;clean(a);
});
test('an early autoplay rejection is handled while metadata is still pending',async()=>{
 const a=new Audio();a.play=()=>Promise.reject(new DOMException('Gesture required','NotAllowedError'));
 let error;
 const promise=createAudioLoader(a).load({src:'/book',play:true,onPlayError:e=>error=e});
 await new Promise(r=>setTimeout(r,5));a.metadata();await promise;
 assert.equal(error.name,'NotAllowedError');clean(a);
});
test('buffering does not keep the player waiting once metadata is ready',async()=>{
 const a=new Audio();a.play=()=>new Promise(()=>{});
 const promise=createAudioLoader(a).load({src:'/book',play:true});
 a.metadata();await promise;clean(a);
});
