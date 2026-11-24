"use strict";
const assert=require("node:assert/strict");
const {evaluate,collectCustom,normalizeUsage,validateRequest,bindScript}=require("./quota-custom");
async function main(){
  const settings={name:"local",baseUrl:"http://127.0.0.1:3456",scriptCode:'({request:{url:"{{baseUrl}}/usage"},extractor:r=>({remaining:r.balance,unit:"CNY"})})'};
  assert.equal(validateRequest({url:settings.baseUrl+"/usage"},settings),settings.baseUrl+"/usage");
  assert.throws(()=>validateRequest({url:"https://unrelated.test"},settings),/query-origin-required/);
  assert.equal(normalizeUsage({remaining:0,unit:"requests"}).remaining,0);
  assert.equal(normalizeUsage({isValid:false}).status,"expired");
  assert.equal(normalizeUsage({}).status,"unavailable");
  assert.equal(normalizeUsage({success:true,data:[{total:100,remaining:40}]}).used,60);
  let stages=[];
  const result=await collectCustom(settings,{now:()=>123,evaluate:async(_,stage)=>{stages.push(stage);return stage==="request"?{url:settings.baseUrl+"/usage"}:{remaining:42,unit:"CNY"};},fetch:async()=>({ok:true,text:async()=>'{"balance":42}'})});
  assert.equal(result.remaining,42);assert.equal(result.updatedAt,123);assert.deepEqual(stages,["request","extractor"]);
  let cancelled=false;
  const oversized=await collectCustom(settings,{evaluate:async()=>({url:settings.baseUrl+"/usage"}),fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>({value:new Uint8Array(1048577),done:false}),cancel:async()=>{cancelled=true;},releaseLock(){}})}})});
  assert.equal(oversized.status,"error");assert.equal(cancelled,true,"oversized body must stop streaming");
  // Optional integration test: ordinary adapters do not require a browser.
  if (!process.argv.includes("--sandbox")) {
    console.log("quota custom script contracts: all checks passed (use --sandbox for browser isolation)");
    return;
  }
  // Exercise the actual browser-worker boundary using only synthetic data.
  const code=bindScript(settings.scriptCode,settings);
  assert.equal((await evaluate(code,"request")).url,settings.baseUrl+"/usage");
  assert.equal((await evaluate(code,"extractor",{balance:42})).remaining,42);
  const boundary=await evaluate('({request:{node:typeof process,require:typeof require,document:typeof document}})',"request");
  assert.deepEqual(boundary,{node:"undefined",require:"undefined",document:"undefined"});
  await assert.rejects(evaluate('(()=>{while(true){} })()',"request"));
  await assert.rejects(evaluate('({extractor:()=>fetch("https://example.com")})',"extractor",{}));
  console.log("quota custom scripts: all checks passed (including real sandbox)");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
