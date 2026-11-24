"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { collectPlatform, detectPlatform, normalizeSub2Api, normalizeNewApi, normalizeGeneral,
  normalizeBalance, normalizeTokenPlan, signVolcengine, number } = require("./quota-platforms");

const now = Date.parse("2026-11-24T00:00:00Z");
function server(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const parsed = new URL(url);
    const route = routes[url] ?? routes[parsed.pathname + parsed.search] ?? routes[parsed.pathname];
    if (typeof route === "function") return route(url, init);
    const body = route?.body ?? route;
    const status = route?.status ?? (route === undefined ? 404 : 200);
    return { ok: status >= 200 && status < 300, status, url, text: async () => JSON.stringify(body ?? {}) };
  };
  return { calls, fetch, now };
}
const configured = { baseUrl: "https://gateway.example/v1", apiKey: "synthetic-key", name: "My gateway" };

test("real HTTP gateways preserve ports and prefixes during automatic quota detection", async () => {
  const http = require("node:http");
  for (const kind of ["newapi", "sub2api", "general"]) {
    const calls = [];
    const routes = kind === "newapi"
      ? { "/api/status": { data: { system_name: "New API", quota_per_unit: 500000 } },
          "/api/usage/token": { data: { object: "token_usage", total_available: 5000000, total_used: 1000000 } } }
      : kind === "sub2api" ? { "/v1/usage": { balance: 10 } }
      : { "/user/balance": { balance: 10 } };
    const gateway = http.createServer((req, res) => {
      calls.push({ path: req.url, authorization: req.headers.authorization });
      const body = req.url.startsWith("/relay/") ? routes[req.url.slice(6)] : undefined;
      res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body || {}));
    });
    await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
    try {
      const result = await collectPlatform({ ...configured,
        baseUrl: `http://127.0.0.1:${gateway.address().port}/relay/v1` });
      assert.equal(result.status, "ok", kind);
      assert.equal(result.kind, kind);
      assert.equal(result.remaining ?? result.balance, 10);
      assert.ok(calls.every(call => call.path.startsWith("/relay/")));
      assert.ok(calls.filter(call => call.path !== "/relay/api/status")
        .every(call => call.authorization === "Bearer synthetic-key"));
      assert.equal(calls[0].authorization, undefined);
    } finally {
      gateway.closeAllConnections();
      await new Promise(resolve => gateway.close(resolve));
    }
  }
});

test("numeric parsing retains signed balances and rejects coercions", () => {
  for (const value of [null, undefined, "", " ", true, false, [], {}, "0x10", "Infinity", NaN, Infinity]) assert.equal(number(value), undefined);
  assert.equal(number("-0.000001"), -0.000001);
  assert.equal(number("1e2"), 100);
});

test("Sub2API quota, rate windows, subscriptions and unlimited sentinel", () => {
  const result = normalizeSub2Api({ mode: "quota_limited", quota: { used: 110, limit: 100, remaining: -10 },
    rate_limits: [{ window: "5h", used: 0, limit: 10, reset_at: "2026-11-25T00:00:00Z" }, { window: "7d", used: null, limit: 100 }] }, configured, now);
  assert.equal(result.status, "ok"); assert.equal(result.remaining, -10);
  assert.equal(result.windows.length, 1); assert.equal(result.windows[0].usedPercent, 0);
  assert.equal(result.windows[0].resetsAt, Date.parse("2026-11-25T00:00:00Z"));
  const unlimited = normalizeSub2Api({ remaining: -1, subscription: { daily_limit_usd: 100, daily_usage_usd: 12 } });
  assert.equal(unlimited.remaining, undefined); assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.windows[0].usedPercent, 12); assert.equal(unlimited.windows[0].resetsAt, undefined);
  assert.equal(normalizeSub2Api({}).status, "unavailable");
  assert.equal(normalizeSub2Api({ isValid: false, balance: 100 }).status, "expired");
});

test("NewAPI raw quota scaling and unlimited token do not invent account caps", () => {
  const account = normalizeNewApi({ success: true, data: { quota: 1000000, used_quota: 500000 } }, configured, now);
  assert.equal(account.remaining, 2); assert.equal(account.used, 1); assert.equal(account.limit, 3);
  const key = normalizeNewApi({ code: true, data: { object: "token_usage", total_available: 200000, total_used: 100000, total_granted: 300000 } }, configured, now, 100000);
  assert.equal(key.remaining, 2); assert.equal(key.limit, 3);
  const unlimited = normalizeNewApi({ data: { object: "token_usage", unlimited_quota: true, total_available: 0, total_granted: 0,
    total_used: 500000, user_quota: { total_available: 1500000 } } }, configured, now);
  assert.equal(unlimited.remaining, undefined); assert.equal(unlimited.limit, undefined);
  assert.equal(unlimited.balance, 3); assert.equal(unlimited.used, 1); assert.equal(unlimited.unlimited, true);
  assert.equal(normalizeNewApi({ data: { object: "token_usage", expires_at: now / 1000 - 1, total_available: 100 } }, {}, now).status, "expired");
  assert.equal(normalizeNewApi({ success: false, message: "secret" }).status, "error");
  assert.equal(normalizeNewApi({ data: { quota: null, used_quota: null } }).status, "unavailable");
});

test("general respects invalid account and missing fields", () => {
  assert.equal(normalizeGeneral({ balance: "-2.50" }).balance, -2.5);
  assert.equal(normalizeGeneral({ is_active: false, balance: 10 }).status, "expired");
  assert.equal(normalizeGeneral({ balance: null }).status, "unavailable");
});

test("balance schemas, currencies and Novita fixed-point conversion", () => {
  const deepseek = normalizeBalance("deepseek", { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0" }, { currency: "USD", total_balance: "-0.25" }] });
  assert.equal(deepseek.status, "ok"); assert.equal(deepseek.wallets[1].balance, -0.25);
  assert.equal(normalizeBalance("stepfun", { balance: "12.50" }).unit, "CNY");
  assert.equal(normalizeBalance("siliconflow", { data: { totalBalance: "-1" } }, { baseUrl: "https://api.siliconflow.cn" }).unit, "CNY");
  assert.equal(normalizeBalance("novita", { availableBalance: "-15" }).balance, -0.0015);
  const router = normalizeBalance("openrouter", { data: { total_credits: "10", total_usage: "12" } });
  assert.equal(router.remaining, -2); assert.equal(router.used, 12);
  for (const provider of ["deepseek", "stepfun", "siliconflow", "openrouter", "novita"]) assert.equal(normalizeBalance(provider, {}).status, "unavailable");
});

test("Kimi does not fabricate missing remaining and parses both windows", () => {
  const result = normalizeTokenPlan("kimi", { limits: [{ detail: { limit: "100", remaining: "80", resetTime: "2026-12-01" } }, { detail: { limit: 100 } }], usage: { limit: 1000, remaining: 500 } });
  assert.deepEqual(result.windows.map(w => [w.label, w.usedPercent]), [["5h", 20], ["7d", 50]]);
});

test("Zhipu explicit period wins over reset order", () => {
  const result = normalizeTokenPlan("zhipu", { success: true, data: { limits: [
    { type: "TOKENS_LIMIT", unit: 6, percentage: 80, nextResetTime: now + 1000 },
    { type: "tokens_limit", unit: 3, percentage: 5, nextResetTime: now + 3600000 },
    { type: "OTHER", percentage: 100 }
  ] } });
  assert.deepEqual(result.windows.map(w => [w.label, w.usedPercent]), [["5h", 5], ["7d", 80]]);
  assert.equal(normalizeTokenPlan("zhipu", { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3 }] } }).status, "unavailable");
});

test("MiniMax selects general, converts remaining, hides unlimited weekly bucket", () => {
  const result = normalizeTokenPlan("minimax", { model_remains: [
    { model_name: "video", current_interval_remaining_percent: 1 },
    { model_name: "general", current_interval_remaining_percent: 75, current_weekly_status: 3, current_weekly_remaining_percent: 100 }
  ] });
  assert.deepEqual(result.windows.map(w => [w.label, w.usedPercent]), [["5h", 25]]);
});

test("ZenMux ratio, OpenCode zero reset and Ollama monthly units", () => {
  const zen = normalizeTokenPlan("zenmux", { success: true, data: { quota_5_hour: { usage_percentage: 0.25, used_value_usd: 3, max_value_usd: 12 } } });
  assert.equal(zen.windows[0].usedPercent, 25); assert.equal(zen.windows[0].unit, "USD");
  const go = normalizeTokenPlan("opencode_go", { usage: { rolling: { percent: 0, resetsAt: "2026-12-01" }, weekly: { percent: 35, resetsAt: "2026-12-02" } } });
  assert.equal(go.windows[0].resetsAt, undefined); assert.ok(go.windows[1].resetsAt);
  const ollama = normalizeTokenPlan("ollama_cloud", { included: { balance_usd: 6, allowance_usd: 10, period: { until: "2026-12-01" } }, purchased: { balance_usd: 2 } });
  assert.equal(ollama.windows[0].usedPercent, 40); assert.equal(ollama.balance, 2);
});

test("Command Code preserves window and credit-pool meanings", () => {
  const result = normalizeTokenPlan("command_code", {
    credits: { credits: { monthlyCredits: 70, purchasedCredits: 10, freeCredits: 0 }, windowLimits: { limited: true, fiveHour: { used: 7, cap: 14 }, weekly: { used: 0, cap: 35 } } },
    summary: { totalCost: 20 }, subscription: { data: { currentPeriodEnd: "2026-12-01" } }
  });
  assert.equal(result.remaining, 80);
  assert.deepEqual(result.windows.map(w => [w.label, w.usedPercent]), [["5h", 50], ["7d", 0], ["month", 20]]);
  assert.equal(normalizeTokenPlan("command_code", { credits: { credits: {} }, summary: {} }).status, "unavailable");
});

test("Volcengine AFP and coding windows reject missing amounts and reset sentinels", () => {
  const afp = normalizeTokenPlan("volcengine", { Result: { AFPFiveHour: { Quota: 50, Used: 12.5 }, AFPDaily: { Quota: 100, Used: 20 }, AFPWeekly: { Quota: 100 }, AFPMonthly: { Quota: 2000, Used: 850.5 } } });
  assert.deepEqual(afp.windows.map(w => [w.label, w.usedPercent]), [["5h", 25], ["month", 42.525]]);
  const coding = normalizeTokenPlan("volcengine", { Result: { QuotaUsage: [ { Level: "session", Percent: 0, ResetTimestamp: -1 }, { Level: "weekly", Percent: 2, ResetTimestamp: now / 1000 + 3600 }, { Level: "monthly" } ] } });
  assert.deepEqual(coding.windows.map(w => [w.label, w.usedPercent]), [["5h", 0], ["7d", 2]]);
  assert.equal(coding.windows[0].resetsAt, undefined);
});

test("exact host detection resists hostname-in-path and suffix lookalikes", () => {
  assert.deepEqual(detectPlatform({ baseUrl: "https://api.deepseek.com/v1" }), { kind: "balance", provider: "deepseek" });
  assert.deepEqual(detectPlatform({ baseUrl: "https://api.minimax.cn/anthropic" }), { kind: "token_plan", provider: "minimax" });
  for (const baseUrl of ["https://api.deepseek.com.evil.example", "https://evil.example/api.deepseek.com", "https://evil.example/?host=api.deepseek.com"]) assert.notEqual(detectPlatform({ baseUrl }).provider, "deepseek");
  assert.equal(detectPlatform({ baseUrl: "https://user:pass@example.com" }).kind, "invalid");
});

test("NewAPI fingerprint query is public and API token query stays same origin", async () => {
  const mock = server({ "/api/status": { success: true, data: { quota_per_unit: 100000 } }, "/api/usage/token": { code: true, data: { object: "token_usage", total_available: 300000, total_used: 100000 } } });
  const result = await collectPlatform(configured, mock);
  assert.equal(result.kind, "newapi"); assert.equal(result.remaining, 3);
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[0].init.headers.Authorization, undefined);
  assert.equal(mock.calls[1].init.headers.Authorization, "Bearer synthetic-key");
  assert.ok(mock.calls.every(c => new URL(c.url).origin === "https://gateway.example"));
});

test("explicit NewAPI dashboard credentials never use inference key", async () => {
  const mock = server({ "/api/status": {}, "/api/user/self": { success: true, data: { quota: 500000 } } });
  const result = await collectPlatform({ ...configured, templateType: "newapi", accessToken: "dashboard-only", userId: "12" }, mock);
  assert.equal(result.remaining, 1);
  assert.equal(mock.calls[1].init.headers.Authorization, "Bearer dashboard-only");
  assert.equal(mock.calls[1].init.headers["New-Api-User"], "12");
  const partial = server({ "/api/status": {} });
  assert.equal((await collectPlatform({ ...configured, templateType: "newapi", accessToken: "dashboard-only" }, partial)).status, "credentials-required");
  assert.equal(partial.calls.length, 1);
});

test("unknown same-origin Sub2API is detected and proxy path prefix retained", async () => {
  const mock = server({ "/prefix/api/status": { status: 404 }, "/prefix/v1/usage": { mode: "quota_limited", quota: { used: 5, limit: 20, remaining: 15 } } });
  const result = await collectPlatform({ ...configured, baseUrl: "https://gateway.example/prefix/v1" }, mock);
  assert.equal(result.kind, "sub2api"); assert.equal(result.remaining, 15);
  assert.equal(mock.calls.length, 2);
});

test("autodetection falls back to token schema then general without cross-origin probes", async () => {
  const mock = server({ "/api/usage/token": { code: true, data: { object: "token_usage", total_available: 500000 } } });
  assert.equal((await collectPlatform(configured, mock)).remaining, 1);
  const general = server({ "/user/balance": { balance: "8.5" } });
  assert.equal((await collectPlatform(configured, general)).kind, "general");
  assert.equal(general.calls.length, 4);
});

test("official balance endpoints and approved alias mapping", async () => {
  for (const [baseUrl, endpoint, body, expected] of [
    ["https://api.deepseek.com/v1", "https://api.deepseek.com/user/balance", { balance_infos: [{ currency: "CNY", total_balance: "2" }] }, 2],
    ["https://api.stepfun.ai/v1", "https://api.stepfun.com/v1/accounts", { balance: "3" }, 3],
    ["https://api.siliconflow.com/v1", "https://api.siliconflow.com/v1/user/info", { data: { totalBalance: "4" } }, 4],
    ["https://api.novita.ai/v3/openai", "https://api.novita.ai/v3/user/balance", { availableBalance: 50000 }, 5]
  ]) {
    const mock = server({ [endpoint]: body });
    const result = await collectPlatform({ ...configured, baseUrl }, mock);
    assert.equal(result.balance, expected); assert.equal(mock.calls[0].url, endpoint);
  }
});

test("MiniMax approved alias, Zhipu team headers and missing credentials", async () => {
  const mini = server({ "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains": { model_remains: [{ model_name: "general", current_interval_remaining_percent: 50 }] } });
  assert.equal((await collectPlatform({ ...configured, baseUrl: "https://api.minimax.cn/anthropic" }, mini)).windows[0].usedPercent, 50);
  const settings = { ...configured, baseUrl: "https://open.bigmodel.cn/api/paas/v4", templateType: "token_plan", codingPlanProvider: "zhipu_team", teamOrganizationId: "org", teamProjectId: "project" };
  const mock = server({ "/api/monitor/usage/quota/limit?type=2": { success: true, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 25 }] } } });
  assert.equal((await collectPlatform(settings, mock)).windows[0].usedPercent, 25);
  assert.equal(mock.calls[0].init.headers.Authorization, "synthetic-key");
  assert.equal(mock.calls[0].init.headers["bigmodel-organization"], "org");
  const missing = server({});
  assert.equal((await collectPlatform({ ...settings, teamProjectId: undefined }, missing)).status, "credentials-required");
  assert.equal(missing.calls.length, 0);
});

test("Zhipu no-plan falls back to balance but authentication failure does not", async () => {
  const settings = { ...configured, baseUrl: "https://open.bigmodel.cn/api/paas/v4" };
  const mock = server({ "/api/monitor/usage/quota/limit": { success: false, msg: "当前用户不存在coding plan" }, "/api/biz/account/query-customer-account-report": { success: true, data: { availableBalance: 7 } } });
  assert.equal((await collectPlatform(settings, mock)).balance, 7);
  const denied = server({ "/api/monitor/usage/quota/limit": { status: 401 } });
  assert.equal((await collectPlatform(settings, denied)).status, "login-required"); assert.equal(denied.calls.length, 1);
});

test("Volcengine signed control-plane request and AFP-to-coding fallback", async () => {
  const settings = { ...configured, baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", accessKeyId: "test-ak", secretAccessKey: "test-secret" };
  const mock = server({
    "/?Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01": { Result: { AFPFiveHour: { Quota: 0, Used: 0 } } },
    "/?Action=GetCodingPlanUsage&Region=cn-beijing&Version=2024-01-01": { Result: { QuotaUsage: [{ Level: "weekly", Percent: 25, ResetTimestamp: now / 1000 + 3600 }] } }
  });
  const result = await collectPlatform(settings, mock);
  assert.equal(result.windows[0].usedPercent, 25); assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assert.equal(new URL(call.url).origin, "https://open.volcengineapi.com");
    assert.equal(call.init.method, "POST"); assert.equal(call.init.body, "");
    assert.match(call.init.headers.Authorization, /^HMAC-SHA256 Credential=test-ak\/20261124\/cn-beijing\/ark\/request, SignedHeaders=host;x-date;x-content-sha256;content-type, Signature=[0-9a-f]{64}$/);
    assert.equal(call.init.headers["X-Content-Sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  }
  assert.ok(!JSON.stringify(result).includes("test-secret"));
  const signed = signVolcengine(settings, "GetAFPUsage", "cn-beijing", now);
  assert.equal(signed.headers["X-Date"], "20261124T000000Z");
  // Independently reproduced with Python hashlib/hmac against CC Switch's
  // canonical request rules (fixed header order, raw SK, request terminator).
  assert.equal(signed.headers.Authorization.split("Signature=")[1], "7ef1b580209ebc1e4ca2521058cc2086b83fca5d3ea6c6c26cb7f3af739a6d74");
  assert.notEqual(signed.headers.Authorization, signVolcengine(settings, "GetCodingPlanUsage", "cn-beijing", now).headers.Authorization);
});

test("Volcengine missing credentials and signature denial stop without inference key fallback", async () => {
  const settings = { ...configured, baseUrl: "https://ark.cn-beijing.volces.com/api/plan" };
  const missing = server({});
  assert.equal((await collectPlatform(settings, missing)).status, "credentials-required"); assert.equal(missing.calls.length, 0);
  const denied = server({ "/": { status: 400, body: { ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "secret payload" } } } } });
  const result = await collectPlatform({ ...settings, accessKeyId: "ak", secretAccessKey: "sk" }, denied);
  assert.equal(result.status, "login-required"); assert.equal(denied.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes("secret payload"));
});

test("Command Code query preserves organization and subscription period scope", async () => {
  const mock = server({ "/alpha/whoami": { org: { id: "org-1" } }, "/alpha/billing/credits": { credits: { monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 } },
    "/alpha/billing/subscriptions": { data: { currentPeriodStart: "2026-11-01", currentPeriodEnd: "2026-12-01" } }, "/alpha/usage/summary": { totalCost: 30 } });
  const result = await collectPlatform({ ...configured, baseUrl: "https://api.commandcode.ai/provider/v1" }, mock);
  assert.equal(result.windows[0].usedPercent, 30);
  const summary = mock.calls.find(c => c.url.includes("/alpha/usage/summary"));
  assert.equal(new URL(summary.url).searchParams.get("orgId"), "org-1");
  assert.equal(new URL(summary.url).searchParams.get("since"), "2026-11-01");
});

test("credentials, redirects, oversized responses and raw failures never escape", async () => {
  const missing = server({});
  assert.equal((await collectPlatform({ ...configured, templateType: "general", apiKey: "" }, missing)).status, "credentials-required");
  assert.equal(missing.calls.length, 0);
  const settings = { ...configured, templateType: "general" };
  for (const fetch of [async () => { throw new Error("Bearer synthetic-key private"); },
    async () => ({ ok: true, status: 200, redirected: true, url: "https://evil.example", text: async () => '{"balance":10}' }),
    async () => ({ ok: true, status: 200, text: async () => "x".repeat(262145) })]) {
    const result = await collectPlatform(settings, { fetch, now });
    assert.equal(result.status, "error"); assert.ok(!JSON.stringify(result).includes("synthetic-key"));
  }
});

test("bounded timeout covers a non-cooperative transport", async () => {
  const started = Date.now();
  const result = await collectPlatform({ ...configured, templateType: "general" }, { fetch: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(result.status, "error"); assert.ok(Date.now() - started < 1000);
});

test("autodetect transport failures stay transient errors rather than unsupported", async () => {
  const result = await collectPlatform(configured, { fetch: async () => { throw new Error("ECONNRESET private-key"); } });
  assert.equal(result.status, "error"); assert.ok(!JSON.stringify(result).includes("private-key"));
});

test("custom and external account modes remain explicitly routed by caller", async () => {
  for (const templateType of ["custom", "official_subscription", "github_copilot"]) {
    const mock = server({});
    assert.equal((await collectPlatform({ templateType }, mock)).status, "unsupported");
    assert.equal(mock.calls.length, 0);
  }
});
