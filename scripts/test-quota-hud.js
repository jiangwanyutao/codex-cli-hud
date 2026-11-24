"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { createProvider, URI, TOOL } = require("./quota-hud");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function flatten(tree) {
  return typeof tree === "string" ? tree : (tree?.children || []).map(flatten).join("");
}

function read(provider, state) {
  const result = provider.respond("resources/read", {
    uri: URI,
    _meta: { "com.openai/codex-statusline-state": state },
  });
  assert.equal(result.contents[0].uri, URI);
  assert.equal(result.contents[0].mimeType, "application/json");
  return flatten(JSON.parse(result.contents[0].text));
}

async function testDescriptorsAndDetachedCollection() {
  const pending=deferred();let calls=0;
  const provider=createProvider({collectProvider:()=>{calls++;return pending.promise;},collectOfficial:()=>{throw Error("inactive account queried");}});
  assert.ok(provider.respond("initialize").capabilities.resources);
  assert.deepEqual(provider.respond("tools/list").tools[0]._meta["openai/ui"].entrypoints,[{type:"statusline",resourceUri:URI}]);
  assert.equal(calls,0);
  assert.throws(()=>provider.respond("resources/read",{uri:"wrong"}));
  const state={thread:{model:{display_name:"Model-A"},workspace:{cwd:"project-A"},usage:{context:{used_percentage:12}}},account:{rate_limits:[{limit_id:"codex",primary_limit:{used_percent:90,window_minutes:300}}]}};
  const start=performance.now();const first=read(provider,state);
  assert.ok(performance.now()-start<1000);assert.match(first,/Model-A/);assert.match(first,/12%/);assert.doesNotMatch(first,/OpenAI/);
  assert.equal(first.split("\n")[1], "\u67e5\u8be2\u4e2d");
  await Promise.resolve();assert.equal(calls,1);
  await new Promise(r=>setTimeout(r,1100));read(provider,state);assert.equal(calls,1);
  pending.resolve({status:"ok",kind:"sub2api",name:"Current API",remaining:42,unit:"USD"});
  await provider.refresh();assert.match(read(provider,state),/42/);assert.equal(provider.snapshot(state).official,undefined);
  provider.stop();
}

async function testRefreshTtlAndFailureRetention() {
  let now=100000,calls=0;let result={status:"ok",identity:"a",updatedAt:now,remaining:5};
  const provider=createProvider({now:()=>now,collectProvider:()=>{calls++;return result;}});
  await provider.refresh();now+=4999;await provider.refresh();assert.equal(calls,1);
  now++;result={status:"error",identity:"a"};await provider.refresh();assert.equal(provider.snapshot().provider.status,"stale");
  now+=5000;result={status:"error",identity:"b"};await provider.refresh();assert.equal(provider.snapshot().provider.remaining,undefined);
  now+=5000;result={status:"official",kind:"official_subscription",identity:"official"};await provider.refresh();
  const state={account:{rate_limits:[{limit_id:"codex",primary_limit:{used_percent:25,window_minutes:300,resets_at:123456}}]}};
  assert.equal(provider.snapshot(state).official.windows[0].usedPercent,25);
  assert.equal(provider.snapshot({}).official.status,"unavailable","never query a separately logged-in account");
  now+=5000;result={status:"ok",identity:"api",kind:"newapi",remaining:20};await provider.refresh();
  assert.equal(provider.snapshot(state).official,undefined,"hide inactive official account");
  provider.stop();now+=10000;await provider.refresh();assert.equal(calls,5);
}

async function testStdioProtocolRecovery() {
  const script = path.join(__dirname, "quota-hud.js");
  const messages = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("stdio test timed out")); }, 5000);
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0);
        assert.equal(stderr, "");
        resolve(stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)));
      } catch (error) { reject(error); }
    });
    child.stdin.end([
      "{broken",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/read", params: null }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/list" }),
      "",
    ].join("\n"));
  });
  assert.equal(messages.length, 4, "notifications must not produce responses");
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[0].id, null);
  assert.equal(messages[1].id, 2);
  assert.equal(messages[1].result.tools[0].name, TOOL.name);
  assert.equal(messages[2].error.code, -32602);
  assert.equal(messages[3].result.resources[0].uri, URI);
  for (const message of messages) assert.equal(message.jsonrpc, "2.0");
}

async function testLiveThreadProjection() {
  const updates=[];
  let stopped=false;
  const activityTracker={snapshot:id=>id==="current-thread"?{status:"ok",tools:[{name:"Read",count:3}]}:{status:"unavailable"},
    update:async id=>{updates.push(id);},stop:()=>{stopped=true;}};
  const provider=createProvider({activityTracker,collectProvider:async()=>({status:"ok",remaining:10,unit:"USD"})});
  const state={thread:{id:"current-thread",workspace:{cwd:"D:\\work\\full-project"},agent:{state:"working"},usage:{context:{used_percentage:40}}}};
  const value=read(provider,state);
  assert.match(value,/D:\\work\\full-project/);
  assert.match(value,/Read×3/);
  assert.match(value,/执行中/);
  assert.deepEqual(updates,["current-thread"]);
  assert.equal(provider.snapshot({thread:{id:"different-thread"}}).activity.status,"unavailable");
  provider.stop();assert.equal(stopped,true);
}

async function testSwitchHidesOldQuotaBeforeNetworkCompletes() {
  let now=100000;
  let settings={status:"ok",fingerprint:"a",templateType:"sub2api",baseUrl:"https://a.test"};
  const pending=deferred();
  const provider=createProvider({now:()=>now,collectorOptions:{now:()=>now,readSettings:async()=>settings,
    collectPlatform:async s=>s.fingerprint==="a"?{status:"ok",remaining:50,updatedAt:now}:pending.promise}});
  await provider.refresh();assert.equal(provider.snapshot().provider.remaining,50);
  settings={...settings,fingerprint:"b",baseUrl:"https://b.test"};now+=5000;
  const next=provider.refresh();
  await new Promise(r=>setImmediate(r));
  assert.equal(provider.snapshot().provider.identity,"b");
  assert.equal(provider.snapshot().provider.status,"loading");
  assert.equal(provider.snapshot().provider.remaining,undefined,"old account must disappear before replacement query resolves");
  pending.resolve({status:"ok",remaining:20,updatedAt:now});await next;
  assert.equal(provider.snapshot().provider.remaining,20);provider.stop();
}

async function main() {
  await testDescriptorsAndDetachedCollection();
  await testRefreshTtlAndFailureRetention();
  await testStdioProtocolRecovery();
  await testLiveThreadProjection();
  await testSwitchHidesOldQuotaBeforeNetworkCompletes();
  console.log("quota HUD provider: all checks passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
