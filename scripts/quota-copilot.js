"use strict";

// Protocol reference: CC Switch copilot_auth.rs (MIT, copyright 2025 Jason Young).
// The caller resolves the managed account; inference API tokens are not accepted here.
function normalizeCopilot(body, now = Date.now()) {
  const result = { status: "unavailable", updatedAt: now, name: "GitHub Copilot",
    kind: "github_copilot", unit: "requests", windows: [] };
  const reset = typeof body?.quota_reset_date === "string" ? Date.parse(body.quota_reset_date) : NaN;
  for (const [key, label] of [["premium_interactions", "Premium"], ["chat", "Chat"], ["completions", "Completions"]]) {
    const quota = body?.quota_snapshots?.[key];
    if (!quota || typeof quota !== "object" || Array.isArray(quota)) continue;
    const window = { label, unit: "requests", ...(Number.isFinite(reset) ? { resetsAt: reset } : {}) };
    if (quota.has_quota === false) {
      result.windows.push({ ...window, included: false });
    } else if (quota.unlimited === true) {
      result.windows.push({ ...window, unlimited: true });
    } else if (Number.isFinite(quota.entitlement) && quota.entitlement > 0 &&
        Number.isFinite(quota.remaining) && quota.remaining >= 0 && quota.remaining <= quota.entitlement) {
      const used = quota.entitlement - quota.remaining;
      result.windows.push({ ...window, limit: quota.entitlement, remaining: quota.remaining,
        used, usedPercent: used / quota.entitlement * 100 });
    }
  }
  if (result.windows.length) result.status = "ok";
  return result;
}

function usageUrl(domain = "github.com") {
  if (typeof domain !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(domain)) return null;
  domain = domain.toLowerCase();
  return domain === "github.com" ? "https://api.github.com/copilot_internal/user"
    : `https://${domain}/api/v3/copilot_internal/user`;
}

async function collectCopilot(settings = {}, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  const empty = normalizeCopilot(null, now);
  if (typeof settings?.githubToken !== "string" || !settings.githubToken.trim()) {
    return { ...empty, status: "login-required", error: "COPILOT_ACCOUNT_REQUIRED" };
  }
  const url = usageUrl(settings.githubDomain);
  if (!url) return { ...empty, status: "error", error: "COPILOT_DOMAIN_INVALID" };
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    const work = async () => {
      const response = await (options.fetch || globalThis.fetch)(url, {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { Authorization: `token ${settings.githubToken}`, "Content-Type": "application/json",
          "editor-version": "vscode/1.110.1", "editor-plugin-version": "copilot-chat/0.38.2",
          "user-agent": "GitHubCopilotChat/0.38.2", "x-github-api-version": "2025-10-01" },
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        return { ...empty, status: "error", error: "COPILOT_REDIRECT_REJECTED" };
      }
      if (response.status === 401 || response.status === 403) {
        return { ...empty, status: "unauthorized", error: "COPILOT_AUTH_REJECTED" };
      }
      if (!response.ok) return { ...empty, status: "error", error: "COPILOT_HTTP_FAILED" };
      return normalizeCopilot(await response.json(), now);
    };
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
    return await Promise.race([work(), new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ ...empty, status: "error", error: "COPILOT_TIMEOUT" });
      }, timeoutMs);
    })]);
  } catch {
    return { ...empty, status: "error", error: timedOut ? "COPILOT_TIMEOUT" : "COPILOT_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { collectCopilot, normalizeCopilot };
