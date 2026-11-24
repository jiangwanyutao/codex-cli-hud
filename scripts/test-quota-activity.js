"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createActivityTracker } = require("./quota-activity");
const ID = "019adead-beef-7000-8000-000000000001";
const CHILD = "019adead-beef-7000-8000-000000000002";
const OTHER = "019adead-beef-7000-8000-000000000003";
const row = (type, payload, timestamp = "2026-11-24T00:00:00Z") => JSON.stringify({ timestamp, type, payload }) + "\n";
const meta = id => row("session_meta", { id, cwd: "private-path" });
const call = (id, name, args = {}, namespace) => row("response_item", { type: "function_call", call_id: id, name, namespace, arguments: JSON.stringify(args) });
const output = (id, output) => row("response_item", { type: "function_call_output", call_id: id, output: typeof output === "string" ? output : JSON.stringify(output) });
async function fixture(t, content = "", options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hud-activity-"));
  const dir = path.join(home, "sessions", "2026", "11", "24");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-24T00-00-00-${ID}.jsonl`);
  await fs.writeFile(file, meta(ID) + content);
  const tracker = createActivityTracker({ home, now: () => Date.parse("2026-11-24T00:00:10Z"), ...options });
  t.after(async () => { tracker.stop(); await fs.rm(home, { recursive: true, force: true }); });
  return { home, file, tracker, append: text => fs.appendFile(file, text) };
}

test("counts visible calls once, clears on result, and never scans exec code or exposes arguments", async t => {
  const f = await fixture(t, call("a", "exec", { secret: "private-token", code: "await tools.foo(); await tools.bar();" }, "functions"));
  let result = await f.tracker.update(ID);
  assert.deepEqual(result.tools, [{ name: "functions.exec", count: 1 }]);
  assert.deepEqual(result.activeTools, [{ name: "functions.exec" }]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  await f.append(output("a", "private output") + call("a", "exec", {}, "functions"));
  result = await f.tracker.update(ID);
  assert.deepEqual(result.tools, [{ name: "functions.exec", count: 1 }]);
  assert.deepEqual(result.activeTools, []);
  assert.deepEqual(await f.tracker.update(ID), result);
});

test("does not count a rollout with wrong session identity or accept path injection", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, meta(OTHER) + call("a", "bad_tool"));
  assert.equal((await f.tracker.update(ID)).status, "unavailable");
  assert.equal((await f.tracker.update("../secrets")).status, "unavailable");
  assert.deepEqual(f.tracker.snapshot(OTHER).tools, []);
});

test("incremental byte budget and split UTF8/JSON records only apply complete lines", async t => {
  const f = await fixture(t, "", { maxBytesPerUpdate: 128 });
  const record = call("a", "search", { prompt: "秘密" });
  await f.append(record.slice(0, -5));
  for (let i = 0; i < 10; i++) await f.tracker.update(ID);
  assert.deepEqual(f.tracker.snapshot(ID).tools, []);
  await f.append(record.slice(-5));
  let result;
  for (let i = 0; i < 10; i++) result = await f.tracker.update(ID);
  assert.equal(result.tools[0].count, 1);
});

test("truncation resets counts and oversized lines recover at the next newline", async t => {
  const f = await fixture(t, call("a", "search") + call("b", "search"));
  await f.tracker.update(ID);
  await fs.writeFile(f.file, meta(ID) + call("c", "read"));
  assert.deepEqual((await f.tracker.update(ID)).tools, [{ name: "read", count: 1 }]);
  const g = await fixture(t, row("response_item", { type: "function_call", call_id: "huge", name: "hidden", arguments: "x".repeat(2000) }) + call("a", "safe"), { maxBytesPerUpdate: 128, maxLineBytes: 256 });
  for (let i = 0; i < 25; i++) await g.tracker.update(ID);
  assert.deepEqual(g.tracker.snapshot(ID).tools, [{ name: "safe", count: 1 }]);
});

test("tracks turn elapsed time and only confirmed plan output changes checklist", async t => {
  const f = await fixture(t, row("event_msg", { type: "task_started", turn_id: "turn1" }) + call("p", "update_plan", { explanation: "secret", plan: [{ step: "private", status: "completed" }, { step: "private", status: "in_progress" }] }));
  let result = await f.tracker.update(ID);
  assert.equal(result.elapsedSeconds, 10);
  assert.equal(result.plan, undefined);
  await f.append(output("p", "Plan updated"));
  result = await f.tracker.update(ID);
  assert.deepEqual(result.plan, { completed: 1, total: 2 });
  await f.append(row("event_msg", { type: "task_complete", turn_id: "turn1" }, "2026-11-24T00:00:05Z"));
  assert.equal((await f.tracker.update(ID)).elapsedSeconds, 5);
  await f.append(row("event_msg", { type: "task_started", turn_id: "turn2" }, "2026-11-24T00:00:08Z"));
  result = await f.tracker.update(ID);
  assert.equal(result.elapsedSeconds, 2);
  assert.equal(result.plan, undefined);
});

test("agent counts require confirmed lifecycle, preserve status privacy, and close the intended agent", async t => {
  const f = await fixture(t, call("s", "spawn_agent", { prompt: "private" }));
  assert.equal((await f.tracker.update(ID)).agents, undefined);
  await f.append(output("s", { agent_id: CHILD }));
  assert.deepEqual((await f.tracker.update(ID)).agents, { total: 1 });
  await f.append(row("event_msg", { type: "sub_agent_activity", agent_thread_id: CHILD, agent_path: "/root/helper", kind: "started" }));
  assert.deepEqual((await f.tracker.update(ID)).agents, { running: 1, total: 1 });
  await f.append(call("w", "wait_agent") + output("w", { status: { [CHILD]: { completed: "private final response" } } }));
  let result = await f.tracker.update(ID);
  assert.deepEqual(result.agents, { running: 0, total: 1 });
  assert.equal(JSON.stringify(result).includes("private"), false);
  await f.append(call("c", "close_agent", { target: CHILD }) + output("c", { previous_status: "running" }));
  assert.deepEqual((await f.tracker.update(ID)).agents, { running: 0, total: 1 });
});

test("paginated completed items merge by call ID and ignore other thread items", async t => {
  const event = item => row("event_msg", { type: "item_completed", thread_id: ID, turn_id: "one", item });
  const f = await fixture(t, call("e", "exec_command") + event({ type: "CommandExecution", id: "e", status: "completed", command: ["private"], aggregated_output: "secret" }) +
    event({ type: "McpToolCall", id: "m", tool: "find", status: "completed" }) +
    event({ type: "CollabAgentToolCall", id: "s", tool: "spawn_agent", status: "completed", agents_states: { [CHILD]: "running" } }) +
    row("event_msg", { type: "item_completed", thread_id: OTHER, item: { type: "McpToolCall", id: "other", tool: "ignored" } }));
  const result = await f.tracker.update(ID);
  assert.equal(result.tools.find(v => v.name === "exec_command").count, 1);
  assert.equal(result.tools.some(v => v.name === "ignored"), false);
  assert.deepEqual(result.activeTools, []);
  assert.deepEqual(result.agents, { running: 1, total: 1 });
});

test("concurrent updates share one read and stopped tracker stays empty", async t => {
  const f = await fixture(t, call("a", "search"));
  await Promise.all([f.tracker.update(ID), f.tracker.update(ID)]);
  assert.equal(f.tracker.snapshot(ID).tools[0].count, 1);
  f.tracker.stop();
  assert.equal((await f.tracker.update(ID)).status, "unavailable");
  assert.deepEqual(f.tracker.snapshot(ID).tools, []);
});

test("fork boundary excludes inherited parent activity and missing boundary fails closed", async t => {
  const ownMeta = { type: "session_meta", ordinal: 0, payload: { id: ID, subagent_history_start_ordinal: 3, base_instructions: "x".repeat(70000) } };
  const records = [ownMeta,
    { type: "session_meta", ordinal: 1, payload: { id: OTHER } },
    { type: "response_item", ordinal: 2, payload: { type: "function_call", call_id: "parent", name: "parent_tool" } },
    { type: "response_item", ordinal: 3, payload: { type: "function_call", call_id: "child", name: "child_tool" } }];
  const f = await fixture(t);
  await fs.writeFile(f.file, records.map(x => JSON.stringify(x) + "\n").join(""));
  assert.deepEqual((await f.tracker.update(ID)).tools, [{ name: "child_tool", count: 1 }]);
  const g = await fixture(t);
  delete ownMeta.payload.subagent_history_start_ordinal;
  await fs.writeFile(g.file, records.map(x => JSON.stringify(x) + "\n").join(""));
  const result = await g.tracker.update(ID);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.tools, []);
  assert.equal((await g.tracker.update(ID)).status, "unavailable");
});
