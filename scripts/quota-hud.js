#!/usr/bin/env node
"use strict";
const readline = require("node:readline");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { render, renderTree } = require("./quota-hud-render");
const { createCollector } = require("./quota-provider");
const { normalizeRateLimits } = require("./quota-official");
const { createActivityTracker } = require("./quota-activity");

const URI = "ui://codex-quota-hud/footer";
const TOOL = {
  name: "quota_statusline", title: "Codex CLI HUD",
  description: "Display current Codex quotas, workspace, tool calls and session activity.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: URI }] } },
};

function createProvider(options = {}) {
  const sources = { provider: { status: "loading" } };
  const collectProvider = options.collectProvider || options.collectCowork6 || createCollector({
    ...options.collectorOptions,
    onIdentityChange: value => { sources.provider = value; },
  });
  const jobs = new Map();
  const branches = new Map();
  const now = options.now || Date.now;
  const activity = options.activityTracker || createActivityTracker({ now });
  const activityJobs = new Map();
  let stopped = false;
  function refreshActivity(id) {
    if (!id || stopped || activityJobs.has(id)) return;
    const job = (async () => {
      // Catch up existing transcripts without one second of delay per 256 KiB.
      // Yield between chunks so resource reads always remain responsive.
      for (let chunk = 0; chunk < 32 && !stopped; chunk++) {
        await activity.update(id);
        if (activity.snapshot(id).status !== "loading") break;
        await new Promise(resolve => setImmediate(resolve));
      }
    })().catch(() => {}).finally(() => activityJobs.delete(id));
    activityJobs.set(id, job);
  }
  function refreshSource(name, collect) {
    const job = jobs.get(name);
    if (stopped || job?.pending || (job && now() - job.started < (name === "provider" ? 5000 : 60000))) return job?.promise;
    const next = { pending: true, started: now() };
    next.promise = Promise.resolve().then(collect).then(result => {
      if (!["error", "config-error"].includes(result.status) || !sources[name].updatedAt || result.identity !== sources[name].identity) sources[name] = result;
      else sources[name] = { ...sources[name], status: "stale" };
    }).catch(() => {
      sources[name] = sources[name].updatedAt ? { ...sources[name], status: "stale" } : { status: "error" };
    }).finally(() => { next.pending = false; });
    jobs.set(name, next);
    return next.promise;
  }
  function refresh() {
    return refreshSource("provider", collectProvider);
  }
  function branch(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || stopped) return undefined;
    const cached = branches.get(cwd);
    if (!cached || (!cached.pending && now() - cached.time > 15000)) {
      if (branches.size > 32) branches.delete(branches.keys().next().value);
      const entry = { time: now(), pending: true, value: cached?.value };
      branches.set(cwd, entry);
      execFile("git", ["-C", cwd, "branch", "--show-current"], { windowsHide: true, timeout: 2000, maxBuffer: 8192 }, (error, out) => {
        entry.pending = false;
        if (!error) entry.value = out.trim();
      });
    }
    return cached?.value;
  }
  function snapshot(state = {}) {
    const thread = state?.thread || {};
    const cwd = thread.workspace?.cwd;
    let official;
    if (sources.provider.kind === "official_subscription" || sources.provider.status === "official") {
      const bucket = state.account?.rate_limits?.find(b => b.limit_id === "codex");
      const window = w => w && ({ usedPercent: w.used_percent, windowDurationMins: w.window_minutes, resetsAt: w.resets_at });
      official = normalizeRateLimits({ rateLimits: bucket && { limitId: "codex", primary: window(bucket.primary_limit), secondary: window(bucket.secondary_limit) } }, new Date(now()));
    }
    return {
      model: thread.model?.display_name || thread.model?.id || "Codex",
      project: typeof cwd === "string" ? cwd : "workspace",
      branch: branch(cwd), contextPercent: thread.usage?.context?.used_percentage,
      runState: thread.agent?.state,
      activity: activity.snapshot(thread.id),
      ...sources, ...(official ? { official } : {}),
    };
  }
  function respond(method, params = {}) {
    switch (method) {
      case "initialize": return { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "codex-quota-hud", version: "1.2.0" } };
      case "ping": return {};
      case "tools/list": return { tools: [TOOL] };
      case "tools/call":
        if (params.name !== TOOL.name) throw new RangeError("Unknown tool");
        return { content: [{ type: "text", text: "Choose Codex CLI HUD in /statusline to display the footer." }] };
      case "resources/list": return { resources: [{ name: "quota-footer", uri: URI, mimeType: "application/json" }] };
      case "resources/templates/list": return { resourceTemplates: [] };
      case "resources/read": {
        if (params.uri !== URI) throw new RangeError("Unknown resource");
        // Network requests are detached: Codex stops polling if a read takes 1s.
        void refresh();
        const state = params._meta?.["com.openai/codex-statusline-state"];
        refreshActivity(state?.thread?.id);
        return { contents: [{ uri: URI, mimeType: "application/json", text: JSON.stringify(renderTree(snapshot(state), { now: now() })) }] };
      }
      default: throw new Error("Unknown method");
    }
  }
  return { respond, snapshot, refresh, stop() { stopped = true; activity.stop(); } };
}

function serve() {
  const provider = createProvider();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => {
    let request;
    let response;
    try {
      request = JSON.parse(line);
      if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
        response = { error: { code: -32600, message: "Invalid request" } };
      } else if (!Object.hasOwn(request, "id")) return;
      else if (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) {
        response = { error: { code: -32602, message: "Invalid parameters" } };
      } else {
        try { response = { result: provider.respond(request.method, request.params) }; }
        catch (error) { response = { error: { code: error instanceof RangeError ? -32602 : -32601, message: error instanceof RangeError ? "Invalid parameters" : "Method not found" } }; }
      }
    } catch { response = { error: { code: -32700, message: "Parse error" } }; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, ...response }) + "\n");
  });
  input.on("close", () => { provider.stop(); });
}

async function main() {
  if (process.argv.includes("--check") || process.argv.includes("--preview")) {
    const provider = createProvider();
    await provider.refresh();
    const snapshot = provider.snapshot({ thread: { workspace: { cwd: process.cwd() } } });
    provider.stop();
    console.log(process.argv.includes("--check") ? JSON.stringify(snapshot, null, 2) : render(snapshot, { color: true, width: process.stdout.columns || 160 }));
  } else if (process.argv.includes("--login")) {
    const { loginOfficial } = require("./quota-official");
    const result = await loginOfficial({ onLoginUrl: url => console.log(`Open this official login URL in your browser:\n${url}`) });
    console.log(JSON.stringify(result, null, 2));
  } else serve();
}
if (require.main === module) main().catch(() => { process.stderr.write("Quota HUD could not start. Run --check for source status.\n"); process.exitCode = 1; });
module.exports = { createProvider, URI, TOOL };
