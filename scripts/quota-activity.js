"use strict";

// Read-only, bounded rollout telemetry. A model-visible exec cell counts once;
// its JavaScript source is never evaluated or scanned for nested tool calls.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL = /^[a-zA-Z0-9_.:-]{1,160}$/;
const AGENT_PATH = /^\/[a-zA-Z0-9_/-]{1,160}$/;
const empty = status => ({ status, tools: [], activeTools: [] });
const object = value => value && typeof value === "object" && !Array.isArray(value);
function json(value) { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } }
function stateName(value) {
  if (typeof value === "string" && ["pending_init", "running", "interrupted", "shutdown", "not_found"].includes(value)) return value;
  if (object(value)) {
    if (Object.hasOwn(value, "completed")) return "completed";
    if (Object.hasOwn(value, "errored")) return "errored";
  }
  return "unknown";
}
function planCounts(value) {
  if (!Array.isArray(value?.plan) || value.plan.length > 1000 || !value.plan.every(v => ["pending", "in_progress", "completed"].includes(v?.status))) return null;
  return { completed: value.plan.filter(v => v.status === "completed").length, total: value.plan.length };
}
function fresh() {
  return { status: "unavailable", file: null, identity: null, offset: 0, pending: Buffer.alloc(0), skipping: false,
    verified: false, rejected: false, ownFrom: null, tools: new Map(), calls: new Map(), finished: new Set(), agents: new Map(), aliases: new Map(),
    plan: null, turn: null, started: null, ended: null, discoveryAfter: 0 };
}

function createActivityTracker(options = {}) {
  const home = path.resolve(options.home || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const root = path.join(home, "sessions");
  const clock = typeof options.now === "function" ? options.now : () => options.now ?? Date.now();
  const maxBytes = Math.max(128, Math.min(options.maxBytesPerUpdate || 256 * 1024, 4 * 1024 * 1024));
  const maxLine = Math.max(128, Math.min(options.maxLineBytes || 512 * 1024, 2 * 1024 * 1024));
  const maxEntries = Math.max(10, Math.min(options.maxDiscoveryEntries || 5000, 20000));
  const states = new Map();
  const inFlight = new Map();
  let stopped = false;

  function get(id) {
    if (!UUID.test(id || "")) return null;
    if (!states.has(id)) {
      if (states.size >= 16) states.delete(states.keys().next().value);
      states.set(id, fresh());
    }
    return states.get(id);
  }
  function snapshot(threadId) {
    const s = states.get(threadId);
    if (!s || !s.verified) return empty(s?.status || "unavailable");
    const value = { status: s.status, tools: [...s.tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      activeTools: [...new Set([...s.calls.values()].map(v => v.name))].map(name => ({ name })) };
    if (s.agents.size) {
      value.agents = { total: s.agents.size };
      // Successful spawn establishes existence, not the agent's live status.
      if (![...s.agents.values()].includes("unknown")) value.agents.running = [...s.agents.values()].filter(v => v === "running").length;
    }
    if (s.plan) value.plan = { ...s.plan };
    if (s.started !== null) value.elapsedSeconds = Math.max(0, Math.floor(((s.ended ?? clock()) - s.started) / 1000));
    return value;
  }
  async function matches(file, id) {
    let handle;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) return false;
      handle = await fs.open(file, "r");
      const chunks = [];
      let position = 0;
      while (position < 2 * 1024 * 1024) {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) return false;
        const chunk = buffer.subarray(0, bytesRead);
        const end = chunk.indexOf(10);
        chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
        if (end >= 0) {
          const first = json(Buffer.concat(chunks).toString("utf8"));
          return first?.type === "session_meta" && first.payload?.id === id ? first.payload : false;
        }
        position += bytesRead;
      }
      return false;
    } catch { return false; } finally { await handle?.close().catch(() => {}); }
  }
  async function discover(id) {
    let entries = 0;
    const candidates = [];
    const visited = new Set();
    async function visit(dir, depth) {
      if (stopped || depth > 3 || entries >= maxEntries || visited.has(dir)) return;
      visited.add(dir);
      let directory;
      try {
        directory = await fs.opendir(dir);
        const children = [];
        for await (const item of directory) {
          if (++entries > maxEntries) break;
          if (item.isSymbolicLink()) continue;
          if (item.isDirectory() && /^\d{2,4}$/.test(item.name)) children.push(path.join(dir, item.name));
          else if (item.isFile() && item.name.startsWith("rollout-") && item.name.endsWith(".jsonl") && item.name.includes(id)) candidates.push(path.join(dir, item.name));
        }
        for (const child of children.sort().reverse()) await visit(child, depth + 1);
      } catch { /* Missing directories are normal before the first persisted turn. */ }
    }
    // UUIDv7 encodes creation time. Check local and UTC dates before bounded fallback.
    if (id[14] === "7") {
      const date = new Date(parseInt(id.replaceAll("-", "").slice(0, 12), 16));
      if (Number.isFinite(date.getTime())) {
        for (const [year, month, day] of [[date.getFullYear(), date.getMonth() + 1, date.getDate()], [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]]) {
          await visit(path.join(root, String(year), String(month).padStart(2, "0"), String(day).padStart(2, "0")), 3);
        }
      }
    }
    if (!candidates.length) await visit(root, 0);
    // Reverts can produce multiple physical rollouts for one stable thread ID.
    const matching = [];
    for (const file of candidates.slice(0, 100)) {
      if (await matches(file, id)) matching.push({ file, time: (await fs.stat(file)).mtimeMs });
    }
    return matching.sort((a, b) => b.time - a.time)[0]?.file || null;
  }
  function agent(s, id, status, alias) {
    if (!(UUID.test(id || "") || AGENT_PATH.test(id || ""))) return;
    if (alias && AGENT_PATH.test(alias) && id !== alias) {
      const old = s.agents.get(alias);
      s.agents.delete(alias);
      s.aliases.set(alias, id);
      if (status === "unknown" && old) status = old;
    }
    id = s.aliases.get(id) || id;
    if (s.agents.size < 256 || s.agents.has(id)) s.agents.set(id, status === "unknown" ? s.agents.get(id) || status : status);
  }
  function begin(s, payload) {
    const id = payload.call_id;
    if (typeof id !== "string" || id.length > 200 || s.calls.has(id) || s.finished.has(id)) return;
    if (!TOOL.test(payload.name || "")) return;
    const name = payload.namespace && TOOL.test(payload.namespace) ? `${payload.namespace}.${payload.name}` : payload.name;
    if (s.tools.size < 128 || s.tools.has(name)) s.tools.set(name, (s.tools.get(name) || 0) + 1);
    const call = { name, tool: payload.name.split(".").at(-1) };
    // Retain only counts or an agent ID, never plan text, prompts, or arbitrary arguments.
    if (["update_plan", "close_agent", "resume_agent", "interrupt_agent", "followup_task"].includes(call.tool)) {
      const args = json(payload.arguments);
      if (call.tool === "update_plan") call.plan = planCounts(args);
      else if (UUID.test(args?.id || args?.target || "") || AGENT_PATH.test(args?.target || "")) call.target = args.id || args.target;
    }
    if (s.calls.size < 512) s.calls.set(id, call);
  }
  function complete(s, payload) {
    const id = payload.call_id || payload.id;
    const call = s.calls.get(id);
    if (!call) return;
    s.calls.delete(id);
    if (s.finished.size >= 10000) s.finished.delete(s.finished.values().next().value);
    s.finished.add(id);
    if (call.tool === "update_plan" && call.plan && payload.output === "Plan updated") s.plan = call.plan;
    if (!["spawn_agent", "wait", "wait_agent", "close_agent", "resume_agent", "list_agents"].includes(call.tool)) return;
    const result = json(payload.output);
    if (!object(result) || result.error) return;
    if (call.tool === "spawn_agent") agent(s, result.agent_id || result.task_name, stateName(result.status));
    else if (["wait", "wait_agent"].includes(call.tool) && object(result.status)) {
      for (const [key, value] of Object.entries(result.status).slice(0, 256)) agent(s, key, stateName(value));
    } else if (call.tool === "close_agent" && Object.hasOwn(result, "previous_status") && call.target) agent(s, call.target, "shutdown");
    else if (call.tool === "resume_agent" && result.status && call.target) agent(s, call.target, stateName(result.status));
    else if (call.tool === "list_agents" && Array.isArray(result.agents)) {
      for (const entry of result.agents.slice(0, 256)) agent(s, entry.agent_name, stateName(entry.agent_status));
    }
  }
  function consume(s, record, id) {
    const p = record?.payload;
    if (!object(p)) return;
    // Codex's own projection excludes inherited fork context by this exact ordinal.
    if (s.ownFrom !== null && (!Number.isSafeInteger(record.ordinal) || record.ordinal < s.ownFrom)) return;
    if (record.type === "session_meta") {
      if (p.id !== id) { s.verified = false; s.rejected = true; s.status = "unavailable"; }
      return;
    }
    if (!s.verified) return;
    if (record.type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(p.type)) begin(s, p);
      else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) complete(s, p);
      return;
    }
    if (record.type !== "event_msg") return;
    if (p.thread_id && p.thread_id !== id) return;
    if (["task_started", "turn_started"].includes(p.type)) {
      if (typeof p.turn_id !== "string" || p.turn_id === s.turn) return;
      s.turn = p.turn_id; s.calls.clear(); s.plan = null;
      const time = Number.isFinite(p.started_at) ? p.started_at * 1000 : Date.parse(record.timestamp);
      s.started = Number.isFinite(time) ? time : null; s.ended = null;
    } else if (["task_complete", "turn_complete", "turn_aborted"].includes(p.type)) {
      if (p.turn_id && s.turn && p.turn_id !== s.turn) return;
      s.calls.clear();
      const time = Number.isFinite(p.completed_at) ? p.completed_at * 1000 : Date.parse(record.timestamp);
      s.ended = Number.isFinite(time) ? time : clock();
    } else if (p.type === "sub_agent_activity" || (p.type === "item_completed" && p.item?.type === "SubAgentActivity")) {
      const item = p.item || p;
      const state = { started: "running", completed: "completed", interrupted: "interrupted" }[item.kind];
      if (state) agent(s, item.agent_thread_id, state, item.agent_path);
    } else if (p.type === "item_completed") {
      const item = p.item;
      if (!object(item)) return;
      if (item.type === "FunctionCallOutput") complete(s, item);
      if (item.type === "CollabAgentToolCall") {
        for (const [key, value] of Object.entries(item.agents_states || {}).slice(0, 256)) {
          agent(s, key, item.tool === "close_agent" && item.status === "completed" ? "shutdown" : stateName(value));
        }
      }
      const names = { CommandExecution: "exec_command", McpToolCall: item.tool, DynamicToolCall: item.tool, CollabAgentToolCall: item.tool };
      const name = names[item.type];
      if (name && typeof item.id === "string") {
        if (!s.calls.has(item.id) && !s.finished.has(item.id)) begin(s, { call_id: item.id, name });
        complete(s, { call_id: item.id });
      }
    }
  }
  async function read(id, s) {
    if (stopped) return;
    if (!s.file) {
      if (clock() < s.discoveryAfter) return;
      s.discoveryAfter = clock() + 10000;
      s.file = await discover(id);
      if (!s.file) return;
    }
    let handle;
    try {
      handle = await fs.open(s.file, "r");
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}`;
      if ((s.identity && s.identity !== identity) || info.size < s.offset) {
        const file = s.file;
        Object.assign(s, fresh(), { file });
      }
      if (s.rejected) return;
      if (!s.verified) {
        const metadata = await matches(s.file, id);
        if (!metadata) { s.file = null; s.status = "unavailable"; return; }
        s.ownFrom = Number.isSafeInteger(metadata.subagent_history_start_ordinal) && metadata.subagent_history_start_ordinal >= 0 ? metadata.subagent_history_start_ordinal : null;
        s.verified = true;
      }
      s.identity = identity;
      const amount = Math.min(maxBytes, Math.max(0, info.size - s.offset));
      const buffer = Buffer.alloc(amount);
      const { bytesRead } = amount ? await handle.read(buffer, 0, amount, s.offset) : { bytesRead: 0 };
      s.offset += bytesRead;
      let pending = Buffer.concat([s.pending, buffer.subarray(0, bytesRead)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline);
        if (!s.skipping && line.length <= maxLine) consume(s, json(line.toString("utf8")), id);
        s.skipping = false;
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > maxLine) { s.skipping = true; s.pending = Buffer.alloc(0); }
      else s.pending = Buffer.from(pending);
      s.status = s.verified ? s.offset < info.size ? "loading" : "ok" : "unavailable";
    } catch {
      s.status = "unavailable";
      s.file = null;
    } finally { await handle?.close().catch(() => {}); }
  }
  async function update(threadId) {
    if (stopped) return empty("unavailable");
    const s = get(threadId);
    if (!s) return empty("unavailable");
    if (!inFlight.has(threadId)) inFlight.set(threadId, read(threadId, s).finally(() => inFlight.delete(threadId)));
    await inFlight.get(threadId);
    return snapshot(threadId);
  }
  function stop() { stopped = true; states.clear(); }
  return { snapshot, update, stop };
}

module.exports = { createActivityTracker };
