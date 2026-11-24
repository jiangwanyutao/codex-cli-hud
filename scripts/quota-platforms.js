"use strict";

// Schema ports: CC Switch src-tauri/src/services/{balance,coding_plan}.rs and
// src/components/UsageScriptModal.tsx. NewAPI token response: controller/token.go.
// No provider response text or credential is returned in a snapshot/error.
const { createHash, createHmac } = require("node:crypto");
const { stripVTControlCharacters } = require("node:util");

function text(value) {
  return typeof value === "string" ? stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100).trim() : "";
}
function number(value) {
  if (typeof value === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim())) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function nonnegative(value) { const n = number(value); return n >= 0 ? n : undefined; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : []; }
function epoch(value) {
  const n = number(value);
  if (n !== undefined) return n > 0 ? (n < 1e12 ? n * 1000 : n) : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function snapshot(kind, settings = {}, now = Date.now()) {
  return { status: "unavailable", updatedAt: now, name: text(settings.name) || kind,
    kind, unit: "USD", windows: [] };
}
function finish(result) {
  if (result.status !== "unavailable") return result;
  if ([result.balance, result.remaining, result.used, result.limit].some(v => number(v) !== undefined) || result.windows.length || result.unlimited) result.status = "ok";
  return result;
}
function amountWindow(label, used, limit, resetsAt, unit) {
  used = nonnegative(used); limit = nonnegative(limit);
  if (used === undefined || !(limit > 0)) return undefined;
  return { label, used, limit, usedPercent: used / limit * 100, resetsAt: epoch(resetsAt), unit };
}
function percentWindow(label, percent, resetsAt, unit) {
  percent = nonnegative(percent);
  return percent === undefined ? undefined : { label, usedPercent: percent, resetsAt: epoch(resetsAt), unit };
}
function push(result, window) { if (window) result.windows.push(window); }

function normalizeSub2Api(body, settings = {}, now = Date.now()) {
  const data = object(body);
  const result = snapshot("sub2api", settings, now);
  if (data.isValid === false || ["expired", "disabled"].includes(data.status)) return { ...result, status: "expired" };
  if (data.success === false || data.error) return { ...result, status: "error" };
  const quota = object(data.quota);
  result.unit = text(data.unit) || text(quota.unit) || "USD";
  if (data.mode === "quota_limited" || quota.limit !== undefined) {
    result.limit = nonnegative(quota.limit);
    result.used = nonnegative(quota.used);
    result.remaining = number(quota.remaining);
    if (result.remaining === undefined && result.limit !== undefined && result.used !== undefined) result.remaining = result.limit - result.used;
  } else {
    result.balance = number(data.balance);
    // Sub2API's -1 subscription sentinel means unlimited, not a debt balance.
    result.remaining = nonnegative(data.remaining);
    if (number(data.remaining) === -1) result.unlimited = true;
  }
  for (const window of array(data.rate_limits).slice(0, 10)) {
    if (["5h", "1d", "7d"].includes(window?.window)) push(result, amountWindow(window.window, window.used, window.limit, window.reset_at, result.unit));
  }
  const sub = object(data.subscription);
  for (const [prefix, label] of [["daily", "1d"], ["weekly", "7d"], ["monthly", "month"]]) {
    push(result, amountWindow(label, sub[`${prefix}_usage_usd`], sub[`${prefix}_limit_usd`], undefined, "USD"));
  }
  return finish(result);
}

function normalizeNewApi(body, settings = {}, now = Date.now(), scale = 500000) {
  const root = object(body);
  const result = snapshot("newapi", settings, now);
  if (root.success === false || root.code === false || root.error) return { ...result, status: "error" };
  const data = object(root.data ?? root);
  scale = number(scale) > 0 ? number(scale) : 500000;
  const token = data.object === "token_usage" || Object.hasOwn(data, "total_available");
  const rawRemaining = token ? data.total_available : data.quota;
  const rawUsed = token ? data.total_used : data.used_quota;
  const used = nonnegative(rawUsed);
  if (used !== undefined) result.used = used / scale;
  if (token && data.unlimited_quota === true) {
    result.unlimited = true;
    // Account funds and an unlimited key's cap are different quantities.
    const account = object(data.user_quota);
    if (number(account.total_available) !== undefined) result.balance = number(account.total_available) / scale;
  } else {
    const remaining = number(rawRemaining);
    if (remaining !== undefined) result.remaining = remaining / scale;
    const granted = nonnegative(data.total_granted);
    if (token && granted !== undefined) result.limit = granted / scale;
    else if (result.remaining !== undefined && result.used !== undefined) result.limit = result.remaining + result.used;
  }
  if (token && epoch(data.expires_at) !== undefined && epoch(data.expires_at) <= now) result.status = "expired";
  return finish(result);
}

function normalizeGeneral(body, settings = {}, now = Date.now()) {
  const root = object(body);
  const data = object(root.data ?? root);
  const result = snapshot("general", settings, now);
  if (root.success === false || root.error) return { ...result, status: "error" };
  if (data.is_active === false || data.isValid === false) return { ...result, status: "expired" };
  result.unit = text(data.unit) || "USD";
  result.balance = number(data.balance);
  result.remaining = number(data.remaining);
  result.used = nonnegative(data.used);
  result.limit = nonnegative(data.total ?? data.limit);
  return finish(result);
}

function normalizeBalance(provider, body, settings = {}, now = Date.now()) {
  const root = object(body);
  const data = object(root.data ?? root);
  const result = snapshot(`balance:${provider}`, settings, now);
  if (root.success === false || root.error || (root.code !== undefined && ![0, 200, "0", "200", true].includes(root.code))) return { ...result, status: "error" };
  switch (provider) {
    case "deepseek": {
      const wallets = array(root.balance_infos).map(info => ({ unit: text(info?.currency), balance: number(info?.total_balance) }))
        .filter(info => info.unit && info.balance !== undefined);
      const chosen = wallets.find(info => info.balance > 0) || wallets[0];
      if (chosen) { result.unit = chosen.unit; result.balance = chosen.balance; }
      if (wallets.length > 1) result.wallets = wallets;
      break;
    }
    case "stepfun": result.unit = "CNY"; result.balance = number(root.balance); break;
    case "siliconflow": result.unit = settings.baseUrl?.includes("api.siliconflow.cn") ? "CNY" : "USD"; result.balance = number(data.totalBalance); break;
    case "openrouter": {
      const total = number(data.total_credits), used = nonnegative(data.total_usage);
      if (total !== undefined && used !== undefined) {
        result.limit = total; result.used = used; result.remaining = total - used;
      }
      break;
    }
    case "novita": if (number(root.availableBalance) !== undefined) result.balance = number(root.availableBalance) / 10000; break;
    case "zhipu": result.unit = settings.baseUrl?.includes("bigmodel.cn") ? "CNY" : "USD"; result.balance = number(data.availableBalance ?? data.balance); break;
    default: result.status = "unsupported";
  }
  return finish(result);
}

function normalizeTokenPlan(provider, body, settings = {}, now = Date.now()) {
  const root = object(body);
  const data = object(root.data ?? root);
  const result = snapshot(`token_plan:${provider}`, settings, now);
  result.unit = "quota";
  if (root.success === false || root.error || (root.base_resp && root.base_resp.status_code !== 0)) return { ...result, status: "error" };
  switch (provider) {
    case "kimi": {
      for (const item of array(root.limits)) {
        const d = object(item?.detail);
        const limit = nonnegative(d.limit), remaining = number(d.remaining);
        if (limit !== undefined && remaining !== undefined) push(result, amountWindow("5h", Math.max(0, limit - remaining), limit, d.resetTime, "quota"));
      }
      const usage = object(root.usage);
      const limit = nonnegative(usage.limit), remaining = number(usage.remaining);
      if (limit !== undefined && remaining !== undefined) push(result, amountWindow("7d", Math.max(0, limit - remaining), limit, usage.resetTime, "quota"));
      break;
    }
    case "zhipu":
    case "zhipu_team": {
      const candidates = array(data.limits).filter(item => ["TOKENS_LIMIT", "CREDIT_LIMIT"].includes(String(item?.type).toUpperCase()) && nonnegative(item.percentage) !== undefined);
      const selected = new Map();
      const unclassified = [];
      for (const item of candidates) {
        const label = item.unit === 3 ? "5h" : item.unit === 6 ? "7d" : undefined;
        if (label && !selected.has(label)) selected.set(label, item);
        else unclassified.push(item);
      }
      unclassified.sort((a, b) => (epoch(a.nextResetTime) ?? 0) - (epoch(b.nextResetTime) ?? 0));
      for (const label of ["5h", "7d"]) {
        const item = selected.get(label) || unclassified.shift();
        if (item) push(result, percentWindow(label, item.percentage, item.nextResetTime));
      }
      break;
    }
    case "minimax": {
      const item = array(root.model_remains).find(item => item?.model_name === "general");
      if (!item) break;
      const remaining = number(item.current_interval_remaining_percent);
      if (remaining !== undefined) push(result, percentWindow("5h", 100 - remaining, item.end_time));
      const weekly = number(item.current_weekly_remaining_percent);
      if ([1, 2].includes(item.current_weekly_status) && weekly !== undefined) push(result, percentWindow("7d", 100 - weekly, item.weekly_end_time));
      break;
    }
    case "zenmux":
      for (const [key, label] of [["quota_5_hour", "5h"], ["quota_7_day", "7d"]]) {
        const w = object(data[key]);
        const ratio = nonnegative(w.usage_percentage);
        const window = ratio !== undefined ? percentWindow(label, ratio * 100, w.resets_at, "USD") : amountWindow(label, w.used_value_usd, w.max_value_usd, w.resets_at, "USD");
        if (window) { window.used = nonnegative(w.used_value_usd); window.limit = nonnegative(w.max_value_usd); push(result, window); }
      }
      break;
    case "opencode_go":
      for (const [key, label] of [["rolling", "5h"], ["weekly", "7d"], ["monthly", "month"]]) {
        const w = object(root.usage?.[key]);
        push(result, percentWindow(label, w.percent, number(w.percent) > 0 ? w.resetsAt : undefined));
      }
      break;
    case "ollama_cloud": {
      const included = object(root.included);
      const balance = number(included.balance_usd), allowance = nonnegative(included.allowance_usd);
      if (balance !== undefined && allowance > 0) push(result, amountWindow("month", Math.max(0, allowance - balance), allowance, included.period?.until, "USD"));
      else for (const [key, label] of [["session", "5h"], ["weekly", "7d"]]) {
        const remaining = number(included[key]?.remaining_percent);
        if (remaining !== undefined) push(result, percentWindow(label, 100 - remaining, included[key].resets_at));
      }
      result.balance = number(root.purchased?.balance_usd);
      if (result.balance !== undefined) result.unit = "USD";
      break;
    }
    case "command_code": {
      const credits = object(root.credits?.credits ?? root.credits);
      const limits = object(root.credits?.windowLimits ?? credits.windowLimits);
      if (limits.limited === true) for (const [key, label] of [["fiveHour", "5h"], ["weekly", "7d"]]) {
        const w = object(limits[key]);
        push(result, amountWindow(label, w.used, w.cap, w.resetAt, "USD"));
      }
      const values = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits].map(nonnegative);
      const used = nonnegative(root.summary?.totalCost);
      if (values.every(v => v !== undefined)) {
        result.remaining = values.reduce((sum, value) => sum + value, 0); result.unit = "USD";
        if (used !== undefined) push(result, amountWindow("month", used, used + result.remaining, root.subscription?.data?.currentPeriodEnd, "USD"));
      }
      break;
    }
    case "volcengine": {
      const d = object(root.Result ?? root);
      for (const [key, label] of [["AFPFiveHour", "5h"], ["AFPWeekly", "7d"], ["AFPMonthly", "month"]]) {
        const w = object(d[key]); push(result, amountWindow(label, w.Used, w.Quota, w.ResetTime, "AFP"));
      }
      if (!result.windows.length) for (const item of array(d.QuotaUsage ?? d.Usages ?? d.Details)) {
        const raw = String(item?.Level ?? item?.Type ?? item?.Period ?? item?.Label ?? item?.Window ?? "").toLowerCase();
        const label = ["session", "5h", "fivehour", "five_hour", "rolling_5h"].includes(raw) ? "5h" : ["weekly", "week", "7d"].includes(raw) ? "7d" : ["monthly", "month"].includes(raw) ? "month" : undefined;
        if (label) push(result, percentWindow(label, item.Percent ?? item.UsedPercent ?? item.UsagePercent, item.ResetTime ?? item.ResetTimestamp));
      }
      break;
    }
    default: result.status = "unsupported";
  }
  return finish(result);
}

function baseURL(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("config-error");
  return url;
}
function knownProvider(url) {
  const h = url.hostname.toLowerCase(), p = url.pathname;
  if (h === "api.deepseek.com") return { kind: "balance", provider: "deepseek" };
  if (["api.stepfun.ai", "api.stepfun.com"].includes(h)) return { kind: "balance", provider: "stepfun" };
  if (["api.siliconflow.cn", "api.siliconflow.com"].includes(h)) return { kind: "balance", provider: "siliconflow" };
  if (h === "openrouter.ai") return { kind: "balance", provider: "openrouter" };
  if (h === "api.novita.ai") return { kind: "balance", provider: "novita" };
  if (["api.kimi.com", "api.kimi.ai"].includes(h) && /^\/coding(?:\/|$)/.test(p)) return { kind: "token_plan", provider: "kimi" };
  if (["open.bigmodel.cn", "bigmodel.cn", "api.z.ai"].includes(h)) return { kind: "token_plan", provider: "zhipu" };
  if (["api.minimaxi.com", "api.minimax.cn", "api.minimax.io"].includes(h)) return { kind: "token_plan", provider: "minimax" };
  if (["zenmux.ai", "zenmux.com"].some(domain => h === domain || h.endsWith("." + domain))) return { kind: "token_plan", provider: "zenmux" };
  if (h === "opencode.ai" && /^\/(?:zen|inference)\/go(?:\/|$)/.test(p)) return { kind: "token_plan", provider: "opencode_go" };
  if (h === "api.commandcode.ai" && /^\/provider(?:\/|$)/.test(p)) return { kind: "token_plan", provider: "command_code" };
  if (/^ark\.[a-z0-9-]+\.volces\.com$/.test(h) && /^\/api\/(?:plan|coding)(?:\/|$)/.test(p)) return { kind: "token_plan", provider: "volcengine" };
  if (h === "ollama.com") return { kind: "token_plan", provider: "ollama_cloud" };
  return undefined;
}
function detectPlatform(settings = {}) {
  if (["custom", "official_subscription", "github_copilot"].includes(settings.templateType)) return { kind: settings.templateType };
  let url;
  try { url = baseURL(settings.baseUrl); } catch { return { kind: "invalid" }; }
  const known = knownProvider(url);
  const kind = settings.templateType || "auto";
  if (kind === "balance") return { kind, provider: settings.balanceProvider || (known?.kind === kind ? known.provider : undefined) };
  if (kind === "token_plan") return { kind, provider: settings.codingPlanProvider || (known?.kind === kind ? known.provider : undefined) };
  if (kind !== "auto") return { kind };
  return known || { kind: "auto" };
}

function rootPath(url, suffix) {
  // Preserve explicit reverse-proxy path prefixes while removing API version tails.
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return new URL(prefix + suffix, url.origin).href;
}
function canonicalOfficial(url, provider) {
  const h = url.hostname;
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return url.origin;
  const aliases = { "stepfun:api.stepfun.ai": "https://api.stepfun.com", "minimax:api.minimax.cn": "https://api.minimaxi.com",
    "zhipu:bigmodel.cn": "https://open.bigmodel.cn", "zhipu_team:bigmodel.cn": "https://open.bigmodel.cn",
    "zhipu_team:api.z.ai": "https://open.bigmodel.cn" };
  return aliases[`${provider}:${h}`] || url.origin;
}

function signVolcengine(settings, action, region, now) {
  const uri = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = `Action=${uri(action)}&Region=${uri(region)}&Version=2024-01-01`;
  const date = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const short = date.slice(0, 8);
  const hash = value => createHash("sha256").update(value).digest("hex");
  const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
  const contentHash = hash("");
  const contentType = "application/json; charset=utf-8";
  const signed = "host;x-date;x-content-sha256;content-type";
  const headers = `host:open.volcengineapi.com\nx-date:${date}\nx-content-sha256:${contentHash}\ncontent-type:${contentType}\n`;
  const canonical = `POST\n/\n${query}\n${headers}\n${signed}\n${contentHash}`;
  const scope = `${short}/${region}/ark/request`;
  const toSign = `HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`;
  const key = hmac(hmac(hmac(hmac(settings.secretAccessKey, short), region), "ark"), "request");
  return { url: `https://open.volcengineapi.com/?${query}`, headers: {
    Authorization: `HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${hmac(key, toSign).toString("hex")}`,
    "X-Date": date, "X-Content-Sha256": contentHash, "Content-Type": contentType,
  } };
}

async function collectPlatform(settings = {}, options = {}) {
  const now = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const mode = detectPlatform(settings);
  const empty = status => ({ ...snapshot(mode.kind, settings, now), status });
  if (mode.kind === "invalid") return empty("config-error");
  if (["custom", "official_subscription", "github_copilot"].includes(mode.kind)) return empty("unsupported");
  const url = baseURL(settings.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  let timedOut;
  const timeoutPromise = new Promise((resolve, reject) => { timedOut = () => reject(new Error("error")); controller.signal.addEventListener("abort", timedOut, { once: true }); });
  const allowed = new Set([url.origin]);
  const fetchImpl = options.fetch || globalThis.fetch;
  const read = async (address, headers = {}, method = "GET", readBusinessError = false) => {
    const destination = new URL(address);
    if (!allowed.has(destination.origin)) throw new Error("config-error");
    const response = await fetchImpl(destination.href, { method, headers: { Accept: "application/json", ...headers }, redirect: "error", signal: controller.signal, ...(method === "POST" ? { body: "" } : {}) });
    if (response.redirected || (response.url && new URL(response.url).origin !== destination.origin)) throw new Error("error");
    if ([401, 403].includes(response.status)) throw new Error("login-required");
    if (!response.ok && !readBusinessError) {
      if ([404, 405].includes(response.status)) throw new Error("endpoint-unavailable");
      throw new Error("error");
    }
    let raw = "";
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 262144) { await reader.cancel(); throw new Error("error"); }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally { reader.releaseLock(); }
    } else { raw = await response.text(); if (Buffer.byteLength(raw) > 262144) throw new Error("error"); }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error("unavailable"); }
    if (!response.ok && !data?.ResponseMetadata?.Error && !data?.Error) throw new Error("error");
    return object(data);
  };
  const bearer = key => ({ Authorization: `Bearer ${key}` });
  const requireKey = () => { if (typeof settings.apiKey !== "string" || !settings.apiKey.trim()) throw new Error("credentials-required"); };
  const tryRead = async (...args) => {
    try { return { data: await read(...args) }; }
    catch (e) {
      if (controller.signal.aborted) throw e;
      return { error: ["config-error", "login-required", "endpoint-unavailable", "unavailable"].includes(e.message) ? e.message : "error" };
    }
  };

  const run = async () => {
    if (mode.kind === "balance") {
      requireKey();
      const paths = { deepseek: "/user/balance", stepfun: "/v1/accounts", siliconflow: "/v1/user/info", openrouter: "/api/v1/credits", novita: "/v3/user/balance", zhipu: "/api/biz/account/query-customer-account-report" };
      if (!paths[mode.provider]) return empty("unsupported");
      const origin = canonicalOfficial(url, mode.provider); allowed.add(origin);
      return normalizeBalance(mode.provider, await read(origin + paths[mode.provider], mode.provider === "zhipu" ? { Authorization: settings.apiKey } : bearer(settings.apiKey)), settings, now);
    }
    if (mode.kind === "token_plan") {
      const provider = mode.provider;
      if (provider === "volcengine") {
        if (!settings.accessKeyId || !settings.secretAccessKey) return empty("credentials-required");
        if (!/^ark\.[a-z0-9-]+\.volces\.com$/.test(url.hostname) && url.hostname !== "open.volcengineapi.com") return empty("config-error");
        allowed.add("https://open.volcengineapi.com");
        const region = /^ark\.([a-z0-9-]+)\.volces\.com$/.exec(url.hostname)?.[1] || "cn-beijing";
        let last = empty("unavailable");
        for (const action of ["GetAFPUsage", "GetCodingPlanUsage"]) {
          const signed = signVolcengine(settings, action, region, now);
          const reply = await tryRead(signed.url, signed.headers, "POST", true);
          if (reply.error === "login-required" || reply.error === "error") return empty(reply.error);
          if (reply.error) { last = empty(reply.error); continue; }
          const failure = reply.data.ResponseMetadata?.Error ?? reply.data.Error;
          if (failure) {
            if (/auth|signature|accessdenied|denied|forbidden|credential|token/i.test(String(failure.Code))) return empty("login-required");
            last = empty("error"); continue;
          }
          const normalized = normalizeTokenPlan(provider, reply.data, settings, now);
          if (normalized.status === "ok") return normalized;
          last = normalized;
        }
        return last;
      }
      requireKey();
      const paths = { kimi: "/coding/v1/usages", zhipu: "/api/monitor/usage/quota/limit", zhipu_team: "/api/monitor/usage/quota/limit?type=2", minimax: "/v1/api/openplatform/coding_plan/remains", opencode_go: "/zen/go/v1/usage", ollama_cloud: "/api/balance" };
      const origin = canonicalOfficial(url, provider); allowed.add(origin);
      let headers = bearer(settings.apiKey);
      if (["zhipu", "zhipu_team"].includes(provider)) headers = { Authorization: settings.apiKey, "Accept-Language": "en-US,en" };
      if (provider === "zhipu_team") {
        if (!settings.teamOrganizationId || !settings.teamProjectId) return empty("credentials-required");
        headers["bigmodel-organization"] = settings.teamOrganizationId; headers["bigmodel-project"] = settings.teamProjectId;
      }
      if (provider === "command_code") {
        const who = await read(origin + "/alpha/whoami?limits=1", headers);
        const params = new URLSearchParams();
        if (typeof who.org?.id === "string") params.set("orgId", who.org.id);
        const query = params.size ? "?" + params : "";
        const [credits, subscription] = await Promise.all([read(origin + "/alpha/billing/credits" + query, headers), read(origin + "/alpha/billing/subscriptions" + query, headers)]);
        if (typeof subscription.data?.currentPeriodStart === "string") params.set("since", subscription.data.currentPeriodStart);
        const summary = await read(origin + "/alpha/usage/summary" + (params.size ? "?" + params : ""), headers);
        return normalizeTokenPlan(provider, { credits, subscription, summary }, settings, now);
      }
      if (!paths[provider] && provider !== "zenmux") return empty("unsupported");
      const data = await read(provider === "zenmux" ? url.href : origin + paths[provider], headers);
      if (provider === "zhipu" && data.success === false && /coding\s*plan/i.test(data.msg || "") && /不存在|没有|未订阅|no\b|not\b/i.test(data.msg || "")) {
        return normalizeBalance("zhipu", await read(origin + "/api/biz/account/query-customer-account-report", headers), settings, now);
      }
      return normalizeTokenPlan(provider, data, settings, now);
    }
    if (mode.kind === "general") { requireKey(); return normalizeGeneral(await read(rootPath(url, "/user/balance"), bearer(settings.apiKey)), settings, now); }
    if (mode.kind === "sub2api") { requireKey(); return normalizeSub2Api(await read(rootPath(url, "/v1/usage"), bearer(settings.apiKey)), settings, now); }
    if (!["newapi", "auto"].includes(mode.kind)) return empty("unsupported");
    // Public fingerprint contains no key; raw quotas default to NewAPI's 500000/USD.
    const status = await tryRead(rootPath(url, "/api/status"));
    const fingerprint = object(status.data?.data ?? status.data);
    const scale = number(fingerprint.quota_per_unit) > 0 ? number(fingerprint.quota_per_unit) : 500000;
    const newApi = Object.hasOwn(fingerprint, "quota_per_unit") || /new.?api|one.?api/i.test(String(fingerprint.system_name || ""));
    const queryNewApi = async () => {
      if (settings.accessToken || settings.userId) {
        if (!settings.accessToken || !settings.userId) return empty("credentials-required");
        return normalizeNewApi(await read(rootPath(url, "/api/user/self"), { ...bearer(settings.accessToken), "New-Api-User": String(settings.userId) }), settings, now, scale);
      }
      requireKey();
      return normalizeNewApi(await read(rootPath(url, "/api/usage/token"), bearer(settings.apiKey)), settings, now, scale);
    };
    if (mode.kind === "newapi" || newApi) return queryNewApi();
    requireKey();
    const sub = await tryRead(rootPath(url, "/v1/usage"), bearer(settings.apiKey));
    if (sub.data && ["mode", "quota", "subscription", "balance", "remaining", "rate_limits"].some(key => Object.hasOwn(sub.data, key))) return normalizeSub2Api(sub.data, settings, now);
    const token = await tryRead(rootPath(url, "/api/usage/token"), bearer(settings.apiKey));
    if (token.data && (token.data.data?.object === "token_usage" || Object.hasOwn(object(token.data.data ?? token.data), "total_available"))) return normalizeNewApi(token.data, settings, now, scale);
    const general = await tryRead(rootPath(url, "/user/balance"), bearer(settings.apiKey));
    if (general.data && ["balance", "remaining"].some(key => Object.hasOwn(object(general.data.data ?? general.data), key))) return normalizeGeneral(general.data, settings, now);
    if ([sub, token, general].some(r => r.error === "login-required")) return empty("login-required");
    if ([sub, token, general].some(r => r.error === "error")) return empty("error");
    return empty("unsupported");
  };
  try { return await Promise.race([run(), timeoutPromise]); }
  catch (error) { return empty(["config-error", "credentials-required", "login-required", "endpoint-unavailable", "unavailable"].includes(error.message) ? error.message : "error"); }
  finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", timedOut); controller.abort(); }
}

module.exports = { collectPlatform, detectPlatform, normalizeSub2Api, normalizeNewApi, normalizeGeneral,
  normalizeBalance, normalizeTokenPlan, signVolcengine, number };
