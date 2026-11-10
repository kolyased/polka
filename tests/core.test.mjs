import test from 'node:test';
import assert from 'node:assert/strict';
import {byteRange,timeline,locate,natural} from '../lib.mjs';
test('HTTP ranges: full, middle, suffix, open ended and invalid',()=>{
 assert.equal(byteRange(null,1000),null);assert.deepEqual(byteRange('bytes=200-399',1000),{start:200,end:399});assert.deepEqual(byteRange('bytes=-100',1000),{start:900,end:999});assert.deepEqual(byteRange('bytes=900-',1000),{start:900,end:999});assert.deepEqual(byteRange('bytes=900-9000',1000),{start:900,end:999});for(const s of ['bytes=1000-','bytes=900-800','bytes=0-1,3-4','bytes=-0','bytes=-'])assert.equal(byteRange(s,1000),false);
});
test('six hour audiobook seeks without loading whole file',()=>{const ts=timeline([{duration:21600}]);assert.deepEqual(locate(ts,21599),{index:0,time:21599});});
test('100 tracks share a continuous timeline; skip crosses boundaries',()=>{const ts=timeline(Array.from({length:100},()=>({duration:120})));assert.equal(ts[99].start,11880);assert.deepEqual(locate(ts,120),{index:1,time:0});assert.deepEqual(locate(ts,115+30),{index:1,time:25});assert.deepEqual(locate(ts,125-15),{index:0,time:110});});
test('natural chapter sorting',()=>assert.deepEqual(['Глава 10.mp3','Глава 1.mp3','Глава 2.mp3'].sort(natural.compare),['Глава 1.mp3','Глава 2.mp3','Глава 10.mp3']));
