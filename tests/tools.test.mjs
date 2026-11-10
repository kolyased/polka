import test from 'node:test';
import assert from 'node:assert/strict';
import {run,continuousSpaceNeeded} from '../lib.mjs';
test('continuous output budget includes copy or AAC output plus a 2 GiB reserve',()=>{
 const reserve=2*1024**3;
 assert.equal(continuousSpaceNeeded({copy:true,size:1000,duration:100}),1100+reserve);
 assert.equal(continuousSpaceNeeded({copy:false,size:1,duration:36000}),Math.ceil(36000*12000*1.2)+reserve);
});
test('audio tools accept an explicit timeout and terminate overdue children',async()=>{
 await assert.rejects(run(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeoutMs:20}));
 assert.equal(await run(process.execPath,['-e','setTimeout(()=>process.stdout.write("done"),30)'],{timeoutMs:2000}),'done');
});
