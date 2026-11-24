"use strict";
const { execFile } = require("node:child_process");
const path = require("node:path");
const { collectPlatform } = require("./quota-platforms");
const { collectCustom } = require("./quota-custom");

function readSettings(options = {}) {
  return new Promise(resolve => execFile(options.python || process.env.CODEX_QUOTA_PYTHON || "python",
    [path.join(__dirname, "quota-settings.py")], { windowsHide: true, timeout: 5000, maxBuffer: 262144 }, (error, stdout) => {
      if (error) return resolve({ status: "config-error" });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ status: "config-error" }); }
    }));
}

function createCollector(options = {}) {
  let cached;
  let identity;
  let lastQuery = 0;
  let kind;
  return async function collectProvider() {
    const settings = await (options.readSettings || readSettings)(options);
    if (settings.fingerprint !== identity) {
      identity = settings.fingerprint; cached = undefined; lastQuery = 0; kind = undefined;
      options.onIdentityChange?.({ status: settings.status === "ok" ? "loading" : settings.status,
        kind: settings.templateType || "auto", identity, configSource: settings.configSource });
    }
    const meta = { name: settings.name || "API", kind: settings.templateType || kind || "auto", identity: settings.fingerprint, configSource: settings.configSource };
    if (settings.status !== "ok") { cached = undefined; return { ...meta, status: settings.status || "not-configured" }; }
    const now = (options.now || Date.now)();
    const configuredInterval = Number(settings.autoQueryInterval);
    const interval = Number.isFinite(configuredInterval) && configuredInterval > 0 ? configuredInterval * 60000 : 30000;
    if (cached && now - lastQuery < interval) return cached;
    lastQuery = now;
    let result;
    if (settings.command || (settings.scriptCode && !["token_plan", "balance", "official_subscription", "github_copilot"].includes(settings.templateType))) {
      result = await (options.collectCustom || collectCustom)(settings, options);
    } else if (settings.templateType === "official_subscription") {
      result = { status: "official", name: "OpenAI", kind: "official_subscription" };
    } else if (settings.templateType === "github_copilot") {
      const { collectCopilot } = require("./quota-copilot");
      result = await collectCopilot(settings, options);
    } else {
      result = await (options.collectPlatform || collectPlatform)({ ...settings, ...(kind && (!settings.templateType || settings.templateType === "auto") ? { templateType: kind } : {}) }, options);
    }
    if (result.status === "ok" && ["newapi", "sub2api", "general"].includes(result.kind)) kind = result.kind;
    if (["error", "config-error"].includes(result.status) && cached?.updatedAt) cached = { ...cached, status: "stale" };
    else cached = { ...meta, ...result, identity };
    return cached;
  };
}
module.exports = { readSettings, createCollector };
