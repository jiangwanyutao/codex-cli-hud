"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");

function privateProcess(command, args, payload, timeoutMs = 15000) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill(); resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 1048576) finish({ ok: false, reason: "output-too-large" });
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish({ ok: false, reason: "script-error" }));
    child.on("error", () => finish({ ok: false, reason: "script-unavailable" }));
    child.on("close", code => {
      if (code !== 0) return finish({ ok: false, reason: "script-error" });
      try { finish({ ok: true, value: JSON.parse(output) }); }
      catch { finish({ ok: false, reason: "invalid-output" }); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function bindScript(code, settings) {
  // Escape string literal contents, including all three JS quote styles.
  return code.replace(/\{\{(apiKey|baseUrl|accessToken|userId)\}\}/g, (_, key) =>
    JSON.stringify(String(settings[key] ?? "")).slice(1, -1).replace(/'/g, "\\'").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"));
}

async function evaluate(code, stage, response, options = {}) {
  const result = await privateProcess(options.python || process.env.CODEX_QUOTA_PYTHON || "python",
    [path.join(__dirname, "quota-script-sandbox.py")], { code, stage, response }, 30000);
  if (!result.ok || !result.value?.ok) throw new Error(result.value?.reason || result.reason || "script-error");
  return JSON.parse(result.value.json);
}

function normalizeUsage(value, settings = {}, now = Date.now()) {
  const rows = Array.isArray(value) ? value : value?.success === true && Array.isArray(value.data) ? value.data : [value];
  const valid = rows.filter(row => row && typeof row === "object" && !Array.isArray(row));
  if (!valid.length) return { status: "unavailable" };
  const num = n => typeof n === "number" && Number.isFinite(n) ? n : undefined;
  const result = { status: "ok", updatedAt: now, name: settings.name, kind: settings.templateType || "custom", windows: [] };
  if (valid.every(v => v.isValid === false)) return { ...result, status: "expired" };
  for (const [index, row] of valid.entries()) {
    if (row.isValid === false) continue;
    const entry = {
      label: row.planName || (valid.length > 1 ? `Plan ${index + 1}` : "Usage"),
      used: num(row.used), limit: num(row.total), remaining: num(row.remaining),
      resetsAt: row.resetsAt || row.resetAt, unit: typeof row.unit === "string" ? row.unit : settings.unit,
    };
    if (entry.used === undefined && entry.limit !== undefined && entry.remaining !== undefined) entry.used = entry.limit - entry.remaining;
    if (valid.length === 1) Object.assign(result, { used: entry.used, limit: entry.limit, remaining: entry.remaining, unit: entry.unit });
    else result.windows.push(entry);
  }
  if (result.used === undefined && result.limit === undefined && result.remaining === undefined && !result.windows.length) result.status = "unavailable";
  return result;
}

function validateRequest(request, settings) {
  if (!request || typeof request.url !== "string") throw new Error("invalid-request");
  const url = new URL(request.url);
  const base = new URL(settings.baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid-request");
  // An explicitly saved custom HTTP endpoint is supported, including local helpers.
  // Cross-origin access requires a local user override listing that exact origin.
  const allowed = [base.origin, ...(settings.allowedOrigins || [])];
  if (!allowed.includes(url.origin)) throw new Error("query-origin-required");
  if (!["GET", "POST"].includes(String(request.method || "GET").toUpperCase())) throw new Error("invalid-request");
  if (request.headers && (typeof request.headers !== "object" || Array.isArray(request.headers))) throw new Error("invalid-request");
  return url.href;
}

async function collectCustom(settings, options = {}) {
  try {
    if (settings.command) {
      if (typeof settings.command !== "string" || !Array.isArray(settings.args || []) || (settings.args || []).some(v => typeof v !== "string")) return { status: "config-error" };
      const result = await privateProcess(settings.command, settings.args || [], {
        baseUrl: settings.baseUrl, apiKey: settings.apiKey, accessToken: settings.accessToken, userId: settings.userId,
      }, Math.min(30000, Math.max(2000, (settings.timeout || 10) * 1000)));
      if (!result.ok) return { status: result.reason === "script-unavailable" ? "script-unavailable" : "error" };
      return normalizeUsage(result.value, settings);
    }
    const code = bindScript(settings.scriptCode, settings);
    const evalFn = options.evaluate || evaluate;
    const request = await evalFn(code, "request", undefined, options);
    const url = validateRequest(request, settings);
    const response = await (options.fetch || fetch)(url, {
      method: request.method || "GET", headers: request.headers,
      ...(request.body !== undefined ? { body: typeof request.body === "string" ? request.body : JSON.stringify(request.body) } : {}),
      redirect: "error", signal: AbortSignal.timeout(Math.min(30000, Math.max(2000, (settings.timeout || 10) * 1000))),
    });
    if (!response.ok) return { status: response.status === 401 || response.status === 403 ? "credentials-required" : "error" };
    let raw;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) { await reader.cancel(); return { status: "error" }; }
          chunks.push(Buffer.from(value));
        }
        raw = Buffer.concat(chunks).toString("utf8");
      } finally { reader.releaseLock(); }
    } else raw = await response.text();
    if (raw.length > 1048576) return { status: "error" };
    const usage = await evalFn(code, "extractor", JSON.parse(raw), options);
    return normalizeUsage(usage, settings, typeof options.now === "function" ? options.now() : options.now || Date.now());
  } catch (error) {
    const safe = ["sandbox-unavailable", "query-origin-required", "script-error", "invalid-request"];
    return { status: safe.includes(error.message) ? error.message : "error" };
  }
}
module.exports = { collectCustom, normalizeUsage, validateRequest, bindScript, evaluate };
