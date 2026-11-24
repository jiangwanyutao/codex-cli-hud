"use strict";
const assert = require("node:assert/strict");
const { stripVTControlCharacters } = require("node:util");
const { render, renderTree, clean, cellWidth, bar, money, amount, resetText } = require("./quota-hud-render");
const now = Date.parse("2026-11-24T12:00:00Z");
const flatten = node => typeof node === "string" ? node : node.children.map(flatten).join("");
const fixture = {
  model: "gpt-5.4", project: "quota-hud", branch: "main*", contextPercent: 45,
  provider: { name: "公司订阅", kind: "sub2api", unit: "USD", status: "ok", updatedAt: now,
    limit: 1800, used: 1404.08458264, remaining: 395.91541736, windows: [] },
};
const official = { status: "ok", updatedAt: now, windows: [
  { label: "5h", usedPercent: 25, resetsAt: now + 5400000 },
  { label: "7d", usedPercent: 91, resetsAt: now + 172800000 },
] };
const plain = render(fixture, { now, native: true });
const rows = plain.split("\n");
assert.equal(rows.length, 3);
assert.match(rows[0], /\[gpt-5.4\].*quota-hud.*分支:\(main\*\)/);
assert.match(rows[1], /^已用.*78%.*剩余 \$395\.9154 \/ \$1,800\.00/);
assert.doesNotMatch(plain, /公司订阅/);
assert.match(rows[1], /上下文 .*45%$/);
assert.equal(rows[2], "");
assert.doesNotMatch(plain, /OpenAI|官方|sub2api|Sub2API|remaining|Usage|Context|unavailable|loading/);
assert.ok(rows.every(row => cellWidth(row) <= 76));
assert.equal(flatten(renderTree(fixture, { now })), plain);
assert.equal(stripVTControlCharacters(render(fixture, { now, native: true, color: true })), plain);
assert.ok(renderTree(fixture, { now }).children.some(node => node.props?.color === "cyan"));
assert.ok(renderTree(fixture, { now }).children.some(node => node.props?.color === "yellow"));
assert.doesNotMatch(JSON.stringify(renderTree(fixture, { now })), /\\u001b/);
const full = render(fixture, { now, width: 180 });
assert.match(full.split("\n")[1], /^已用.*剩余/);
assert.doesNotMatch(full, /sub2api|remaining|Context/);
const officialFixture = { ...fixture, provider: { status: "official" }, official };
const officialRows = render(officialFixture, { now, native: true }).split("\n");
assert.equal(officialRows.length, 3);
assert.match(officialRows[1], /^官方.*5小时.*25%.*每周.*91%/);
assert.match(officialRows[1], /上下文/);
assert.doesNotMatch(officialRows[2], /官方|OpenAI/);
assert.doesNotMatch(officialRows.join("\n"), /当前服务|暂不可用|公司订阅/);
assert.ok(officialRows.every(row => cellWidth(row) <= 76));
const combinedRows = render({ ...fixture, official }, { now, native: true }).split("\n");
assert.match(combinedRows[1], /^已用/);
assert.match(combinedRows[1], /上下文/);
assert.match(combinedRows[2], /官方/);
assert.ok(combinedRows.every(row => cellWidth(row) <= 76));
const longTitle = render({ ...fixture, project: "很长的项目名称".repeat(30) }, { now, native: true }).split("\n");
assert.match(longTitle[0], /…$/);
assert.equal(longTitle[1], rows[1]);
assert.equal(longTitle[2], rows[2]);
for (const width of [8, 20, 40, 60, 76, 180]) {
  const output = render(fixture, { now, width });
  assert.ok(output.split("\n").every(row => cellWidth(row) <= width));
}
for (const value of [null, NaN, Infinity, -1, "35"]) assert.equal(bar(value), "暂无数据");
assert.equal(bar(120), "██████████ 120%");
assert.equal(money(0), "$0.00");
assert.equal(money(0.00000001), "$1e-8");
assert.equal(money(395.91541736), "$395.9154");
assert.equal(amount(12.34567, "CNY"), "¥12.3457");
assert.equal(amount(1200, "tokens"), "1,200 令牌");
assert.equal(amount(20, "requests"), "20 次");
assert.equal(amount(25, "%"), "25%");
assert.equal(amount(25), "25");
assert.equal(money(null), null);
assert.match(resetText(now - 1, now), /待刷新/);
assert.equal(resetText(null, now), "重置时间未知");
for (const status of ["login-required", "missing_auth", "credentials-required"]) {
  assert.match(render({ provider: { name: "服务", status } }, { now }).split("\n")[1], /待登录/);
}
assert.match(render({ ...fixture, provider: { ...fixture.provider, updatedAt: now - 3600000 } }, { now }), /待更新/);
const bad = "evil\x1b[2J\x1b]0;owned\x07\n\r\u202eproject";
assert.equal(clean(bad), "evil project");
assert.doesNotMatch(render({ model: bad, project: bad, branch: bad }), /\x1b|\r|\u202e/);
assert.doesNotThrow(() => render(null));
assert.doesNotThrow(() => render({ official: { windows: [null, "bad", {}] }, provider: { windows: {} } }));
assert.equal(cellWidth("中文"), 4);
for (const remaining of [0, 42]) {
  const data = { provider: { name: "自定义", kind: "custom", unit: "requests", remaining, status: "ok" } };
  for (const native of [true, false]) {
    const row = render(data, { now, native }).split("\n")[1];
    assert.match(row, new RegExp(`剩余 ${remaining} 次`));
    assert.doesNotMatch(row.split(" │ ")[0], /暂无数据|\$|custom/);
  }
}
const rotatingFixture = { ...fixture, provider: { ...fixture.provider, windows: [
  { label: "5h", used: 91, limit: 100, resetsAt: now + 5400000 },
  { label: "7d", used: 20, limit: 50, unit: "requests", resetsAt: now + 172800000 },
] } };
const pages = [];
for (let tick = 0; tick < 30; tick++) {
  const output = render(rotatingFixture, { now: now + tick * 5000, native: true }).split("\n");
  assert.equal(output.length, 3);
  assert.ok(output.every(row => cellWidth(row) <= 76));
  assert.match(output[1], /!5小时 █ 91%/);
  assert.match(output[1], /\[\d+\/\d+\]/);
  pages.push(output[1]);
}
assert.match(pages.join("\n"), /剩余 \$395\.9154/);
assert.match(pages.join("\n"), /总额 \$1,800\.00/);
assert.match(pages.join("\n"), /每周 已用 20 次/);
assert.match(pages.join("\n"), /每周 总额 50 次/);
const copilot = { ...fixture, provider: { name: "GitHub", kind: "github_copilot", unit: "requests", status: "ok", windows: [
  { label: "Chat", unlimited: true, usedPercent: 100 }, { label: "Premium", included: false, usedPercent: 100 },
] } };
const copilotPages = [];
for (let tick = 0; tick < 12; tick++) {
  const output = render(copilot, { now: now + tick * 5000, native: true }).split("\n");
  assert.ok(output.every(row => cellWidth(row) <= 76));
  assert.doesNotMatch(output[1], /100%|暂无数据|\$|github_copilot/);
  copilotPages.push(output[1]);
}
assert.match(copilotPages.join("\n"), /聊天 不限量/);
assert.match(copilotPages.join("\n"), /高级请求 未包含/);
const legacy = render({ cowork6: { balance: 12.3 } }, { now });
assert.match(legacy, /余额 \$12\.30/);
for (const native of [true, false]) {
  const loading = render({ provider: { status: "loading", name: "api.example.com" } }, { native, now });
  assert.match(loading.split("\n")[1], /^查询中/);
  assert.doesNotMatch(loading, /api\.example\.com/);
  const ready = render({ ...fixture, provider: { ...fixture.provider, name: "api.example.com" } }, { native, now });
  assert.doesNotMatch(ready, /api\.example\.com/);
}
const activityFixture = { ...fixture, project: "D:\\project\\codex-quota-hud", runState: "working", activity: {
  status: "ok", activeTools: [{ name: "Read", arguments: "SECRET_ARGUMENT" }],
  tools: [{ name: "Read", count: 3 }, { name: "Grep", count: 2 }, { name: "Edit", count: 1 }],
  agents: { running: 1, total: 3 }, plan: { completed: 2, total: 5 }, elapsedSeconds: 125,
} };
const activityPages = [];
for (let tick = 0; tick < 20; tick++) {
  const output = render(activityFixture, { now: now + tick * 5000, native: true });
  const lines = output.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /D:\\project\\codex-quota-hud/);
  assert.match(lines[1], /^已用/);
  assert.match(lines[1], /上下文 .*45%/);
  assert.doesNotMatch(lines[2], /上下文/);
  assert.ok(lines.every(line => cellWidth(line) <= 76));
  assert.doesNotMatch(output, /SECRET_ARGUMENT|公司订阅|sub2api/);
  activityPages.push(lines[2]);
}
const allActivity = activityPages.join("\n");
assert.match(allActivity, /执行中/);
assert.match(allActivity, /◐ Read/);
assert.match(allActivity, /Read×3/);
assert.match(allActivity, /Grep×2/);
assert.doesNotMatch(allActivity, /✓/);
assert.match(allActivity, /子代理 1\/3/);
assert.match(allActivity, /任务 2\/5/);
assert.match(allActivity, /耗时2分5秒/);
assert.match(allActivity, /\[\d+\/\d+\]/);
assert.equal(render(activityFixture, { now, native: true }), render(activityFixture, { now, native: true }));
assert.equal(flatten(renderTree(activityFixture, { now })), render(activityFixture, { now, native: true }));
const fullActivity = render(activityFixture, { now, width: 500 });
assert.match(fullActivity, /D:\\project\\codex-quota-hud/);
assert.match(fullActivity, /Read×3.*子代理 1\/3.*任务 2\/5/);
const totalOnlyAgents = render({ ...fixture, activity: { status: "ok", agents: { total: 1 } } }, { now, native: true });
assert.match(totalOnlyAgents, /子代理 1/);
assert.doesNotMatch(totalOnlyAgents, /子代理 1\//);
for (const telemetry of [undefined, { status: "unavailable" }, { status: "loading" }, { status: "ok" }]) {
  const output = render({ ...fixture, activity: telemetry }, { now, native: true });
  assert.doesNotMatch(output, /子代理 0|任务 0|×0|耗时0/);
}
assert.match(render({ ...fixture, activity: { status: "loading" } }, { now, native: true }), /动态读取中/);
assert.match(render({ ...fixture, runState: "thinking" }, { now, native: true }), /思考中/);
const hostileActivity = render({ ...fixture, activity: { status: "ok", activeTools: [{ name: bad + "x".repeat(100), arguments: "SECRET" }], tools: [{ name: "badCount", count: -1 }], agents: { running: 5, total: 2 }, plan: { completed: 1 } } }, { now, native: true });
assert.doesNotMatch(hostileActivity, /\x1b|\u202e|SECRET|badCount|子代理|任务/);
assert.ok(hostileActivity.split("\n").every(line => cellWidth(line) <= 76));
if (process.argv.includes("--preview")) console.log(render(activityFixture, { now, native: true }));
console.log("quota HUD renderer: all checks passed");

for (const width of [8, 20, 40, 60, 76]) {
 const lines = render(activityFixture, {now, native:true, width}).split("\n");
 assert.ok(lines.every(line => cellWidth(line) <= width));
 if(width >= 20) assert.match(lines[1], /上下文/);
}
