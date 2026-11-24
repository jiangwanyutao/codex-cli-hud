"use strict";
const assert = require("node:assert/strict");
const {createCollector} = require("./quota-provider");
async function main() {
  let now=100000, calls=0;
  let settings={status:"ok",name:"A",fingerprint:"a",baseUrl:"https://a.test",apiKey:"fake"};
  let result={status:"ok",kind:"newapi",remaining:10,updatedAt:now};
  const collect=createCollector({now:()=>now,readSettings:async()=>settings,collectPlatform:async()=>{calls++;return result;},collectCustom:async()=>({status:"ok",remaining:99,updatedAt:now})});
  assert.equal((await collect()).remaining,10);
  now+=5000;await collect();assert.equal(calls,1);
  settings={...settings,name:"B",fingerprint:"b"};result={status:"error"};
  assert.equal((await collect()).remaining,undefined,"identity switch must discard previous balance");
  now+=60000;result={status:"ok",remaining:20,updatedAt:now};await collect();
  now+=60000;result={status:"error"};assert.equal((await collect()).status,"stale");
  now+=60000;result={status:"credentials-required"};assert.equal((await collect()).remaining,undefined);
  settings={...settings,fingerprint:"c",scriptCode:"configured extractor",templateType:"custom"};
  assert.equal((await collect()).remaining,99,"saved custom query must take precedence");
  settings={...settings,status:"disabled"};assert.equal((await collect()).status,"disabled");
  let nativeCalls=0, customCalls=0;
  now=100000;
  settings={status:"ok",fingerprint:"standalone",baseUrl:"https://standalone.test/v1",apiKey:"fixture",templateType:"auto",configSource:"codex"};
  const native=createCollector({now:()=>now,readSettings:async()=>settings,
    collectPlatform:async s=>{nativeCalls++;assert.ok(["auto","sub2api"].includes(s.templateType));return {status:"ok",kind:"sub2api",remaining:8,updatedAt:now};},
    collectCustom:async()=>{customCalls++;return {status:"ok"};}});
  assert.equal((await native()).configSource,"codex");
  now+=29999;await native();assert.equal(nativeCalls,1);
  now+=1;await native();assert.equal(nativeCalls,2,"default interval is exactly 30s");
  assert.equal(customCalls,0,"standalone automatic routing never needs script sandbox");
  settings={...settings,fingerprint:"configured",autoQueryInterval:2};await native();
  now+=119999;await native();assert.equal(nativeCalls,3);
  now+=1;await native();assert.equal(nativeCalls,4,"explicit interval remains minutes");
  settings={status:"ok",fingerprint:"official",templateType:"official_subscription",configSource:"codex"};
  assert.equal((await native()).status,"official");
  assert.equal(nativeCalls,4,"official default must not call provider endpoint");
  const probed=[];
  const standalone=createCollector({readSettings:async()=>({status:"ok",fingerprint:"real-adapter",baseUrl:"https://standalone.test/v1",apiKey:"fixture",templateType:"auto",configSource:"codex"}),
    fetch:async(url,init)=>{probed.push(url);assert.equal(new URL(url).origin,"https://standalone.test");
      if(new URL(url).pathname==="/v1/usage") {assert.equal(init.headers.Authorization,"Bearer fixture");return new Response(JSON.stringify({mode:"quota_limited",quota:{used:5,limit:20,remaining:15}}));}
      return new Response("{}",{status:404});},
    collectCustom:async()=>{throw new Error("No browser script is needed");}});
  const detected=await standalone();
  assert.equal(detected.kind,"sub2api");assert.equal(detected.remaining,15);assert.ok(probed.length>0);
  console.log("quota provider routing: all checks passed");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
