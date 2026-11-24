"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { collectCopilot, normalizeCopilot } = require("./quota-copilot");

const body = { quota_reset_date: "2026-12-01", quota_snapshots: {
  premium_interactions: { entitlement: 300, remaining: 210, percent_remaining: 70 },
  chat: { entitlement: 0, remaining: 0, unlimited: true },
  completions: { entitlement: 0, remaining: 0, has_quota: false },
} };

test("normalizes finite, unlimited, and not-included quotas without false exhaustion", () => {
  const result = normalizeCopilot(body, 1234);
  assert.equal(result.status, "ok");
  assert.equal(result.updatedAt, 1234);
  assert.deepEqual(result.windows[0], { label: "Premium", unit: "requests", resetsAt: Date.parse("2026-12-01"),
    limit: 300, remaining: 210, used: 90, usedPercent: 30 });
  assert.equal(result.windows[1].unlimited, true);
  assert.equal(result.windows[2].included, false);
  assert.equal(result.windows[1].usedPercent, undefined);
  assert.equal(result.windows[2].usedPercent, undefined);
});

test("rejects unknown, invalid, and contradictory numeric quota responses", () => {
  for (const quota of [null, {}, { entitlement: 0, remaining: 0 }, { entitlement: 10, remaining: 11 },
    { entitlement: 10, remaining: -1 }, { entitlement: "10", remaining: 5 }, { entitlement: Infinity, remaining: 1 }]) {
    assert.equal(normalizeCopilot({ quota_snapshots: { chat: quota } }).status, "unavailable");
  }
  assert.equal(normalizeCopilot({ quota_snapshots: { chat: { entitlement: 10, remaining: 0 } } }).windows[0].usedPercent, 100);
});

test("missing bound/default credential never falls back to provider API key or sends request", async () => {
  for (const settings of [undefined, {}, { apiKey: "inference-secret" }, { githubToken: " " }]) {
    const result = await collectCopilot(settings, { fetch: () => { throw new Error("must not fetch"); } });
    assert.equal(result.status, "login-required");
    assert.equal(result.error, "COPILOT_ACCOUNT_REQUIRED");
  }
});

test("uses GitHub OAuth headers and domain-specific endpoint with redirects disabled", async () => {
  for (const [githubDomain, expected] of [[undefined, "https://api.github.com/copilot_internal/user"],
    ["corp.ghe.com", "https://corp.ghe.com/api/v3/copilot_internal/user"]]) {
    const result = await collectCopilot({ githubToken: "private-token", githubDomain }, { now: 1234, fetch: async (url, init) => {
      assert.equal(url, expected);
      assert.equal(init.headers.Authorization, "token private-token");
      assert.equal(init.headers["x-github-api-version"], "2025-10-01");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return { ok: true, status: 200, json: async () => ({ ...body, copilot_plan: "private-token" }) };
    } });
    assert.equal(result.status, "ok");
    assert.equal(JSON.stringify(result).includes("private-token"), false);
  }
});

test("rejects malformed credential destinations before fetching", async () => {
  for (const githubDomain of ["https://github.com", "github.com/evil", "github.com@evil.test", "github.com:443", "github.com\n"]) {
    const result = await collectCopilot({ githubToken: "secret", githubDomain }, { fetch: () => assert.fail("must not fetch") });
    assert.equal(result.error, "COPILOT_DOMAIN_INVALID");
  }
});

test("redacts HTTP, redirect, parsing, and transport errors", async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    const result = await collectCopilot({ githubToken: "secret" }, { fetch: async () => ({ status, ok: false, json: () => assert.fail("must not read error body") }) });
    assert.notEqual(result.status, "ok");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  for (const fetch of [async () => { throw new Error("token secret"); },
    async () => ({ status: 200, ok: true, json: async () => { throw new Error("token secret"); } })]) {
    assert.equal((await collectCopilot({ githubToken: "secret" }, { fetch })).error, "COPILOT_UNAVAILABLE");
  }
});

test("timeout aborts transport and covers stalled response body", async () => {
  for (const stalledBody of [false, true]) {
    let signal;
    const result = await collectCopilot({ githubToken: "secret" }, { timeoutMs: 10, fetch: async (url, init) => {
      signal = init.signal;
      if (stalledBody) return { status: 200, ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    assert.equal(result.error, "COPILOT_TIMEOUT");
    assert.equal(signal.aborted, true);
  }
});
