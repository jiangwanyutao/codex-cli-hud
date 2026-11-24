"use strict";

const { stripVTControlCharacters } = require("node:util");

function clean(value) {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function epoch(value) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = numeric(value);
  return n === null ? null : n < 1e12 ? n * 1000 : n;
}

function cellWidth(text) {
  let width = 0;
  for (const char of stripVTControlCharacters(String(text))) {
    if (/\p{Mark}/u.test(char)) continue;
    const cp = char.codePointAt(0);
    width += (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) || cp >= 0x20000)) ? 2 : 1;
  }
  return width;
}

function fit(text, width) {
  text = clean(text);
  if (cellWidth(text) <= width) return text;
  let result = "";
  for (const char of text) {
    if (cellWidth(result + char) > width - 1) break;
    result += char;
  }
  return result + "…";
}

function percent(value) {
  const n = numeric(value);
  return n !== null && n >= 0 ? n : null;
}

function bar(value, size = 10) {
  const n = percent(value);
  if (n === null) return "暂无数据";
  size = Math.min(40, Math.max(1, Math.floor(size)));
  const filled = Math.round(Math.min(n, 100) / 100 * size);
  return "█".repeat(filled) + "░".repeat(size - filled) + ` ${Number(n.toFixed(1))}%`;
}

function amount(value, unit = "") {
  const n = numeric(value);
  if (n === null) return null;
  unit = clean(unit);
  const currency = { USD: "$", CNY: "¥", RMB: "¥", EUR: "€", GBP: "£", JPY: "¥" }[unit.toUpperCase()];
  // Keep tiny balances visible and avoid falsely reporting a rounded zero.
  const valueText = n !== 0 && Math.abs(n) < 0.000001 ? String(n) :
    n.toLocaleString("en-US", { minimumFractionDigits: currency ? 2 : 0, maximumFractionDigits: Math.abs(n) >= 0.01 ? 4 : 10 });
  const unitLabel = ({ tokens: "令牌", requests: "次", credits: "积分" })[unit.toLowerCase()] || unit;
  return currency ? currency + valueText : valueText + (unit === "%" ? "%" : unitLabel ? ` ${unitLabel}` : "");
}

function money(value) { return amount(value, "USD"); }

function resetText(value, now) {
  const time = epoch(value);
  if (time === null) return "重置时间未知";
  const minutes = Math.ceil((time - now) / 60000);
  if (minutes <= 0) return "待刷新";
  if (minutes < 60) return `${minutes}分钟后重置`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时${minutes % 60}分后重置`;
  return `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60)}小时后重置`;
}

function compactReset(value, now) {
  const time = epoch(value);
  if (time === null) return "";
  const minutes = Math.ceil((time - now) / 60000);
  if (minutes <= 0) return "待刷新";
  if (minutes < 60) return `${minutes}分`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}时${minutes % 60 ? `${minutes % 60}分` : ""}`;
  return `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60) ? `${Math.floor(minutes % 1440 / 60)}时` : ""}`;
}

function compactUsage(value, size) {
  if (size) return bar(value, size);
  const n = percent(value);
  return n === null ? "?" : `${Number(n.toFixed(1))}%`;
}

function windowLabel(window) {
  const value = clean(window?.label);
  return ({ "5h": "5小时", "7d": "每周", "1d": "每日", month: "每月", Chat: "聊天", Premium: "高级请求" })[value] || value || "已用";
}

function nativeUsageRow(context, official, state, now, width, includeContext = true) {
  if (!official) return includeContext ? fit(`上下文 ${bar(context, 10)}`, width) : "";
  const windows = (Array.isArray(official?.windows) ? official.windows : []).filter(w => w && typeof w === "object").slice(0, 2);
  for (const [label, contextSize, windowSize] of [["上下文", 10, 5], ["上下文", 5, 5], ["上下文", 5, 3], ["上下文", 0, 0]]) {
    const parts = includeContext ? [`${label} ${compactUsage(context, contextSize)}`] : [];
    if (windows.length) {
      for (const [index, window] of windows.entries()) {
        const source = index === 0 ? `官方${state ? ` [${state}]` : ""} ` : "";
        const usage = windowAvailability(window) || `${compactUsage(window.usedPercent, windowSize)} ${compactReset(window.resetsAt, now)}`;
        parts.push(`${source}${fit(windowLabel(window), 8)} ${usage}`);
      }
    } else parts.push(`官方 ${state || "暂无数据"}`);
    const row = parts.join(" │ ");
    if (cellWidth(row) <= width) return row;
  }
  return fit(`${includeContext ? `上下文 ${compactUsage(context, 0)} │ ` : ""}官方 ${state || "暂无数据"}`, width);
}

function sourceState(source, now) {
  if (!source || typeof source !== "object") return "未配置";
  const status = clean(source.status).replace(/-/g, "_");
  if (status && !["ok", "available", "stale"].includes(status)) {
    if (["missing_auth", "login_required", "unauthorized", "credentials_required"].includes(status)) return "待登录";
    return ({ loading: "查询中", unavailable: "暂无数据", disabled: "未启用", expired: "已到期", not_configured: "未配置", error: "查询失败", network_error: "连接失败", config_error: "配置错误" })[status] || "暂不可用";
  }
  const updated = epoch(source.updatedAt);
  if (source.status === "stale" || (updated !== null && now - updated > 5 * 60000)) return "待更新";
  return "";
}

function windowAvailability(window) {
  if (window?.included === false) return "未包含";
  if (window?.unlimited === true) return "不限量";
  return "";
}

function windowPercent(window) {
  if (windowAvailability(window)) return null;
  const explicit = percent(window?.usedPercent);
  const used = numeric(window?.used);
  const limit = numeric(window?.limit);
  return explicit ?? (used !== null && used >= 0 && limit !== null && limit > 0 ? used / limit * 100 : null);
}

function windowText(window, size, now, unit) {
  if (!window || typeof window !== "object") return null;
  const label = windowLabel(window);
  if (windowAvailability(window)) return `${label} ${windowAvailability(window)}`;
  const usedPercent = windowPercent(window);
  const used = numeric(window.used);
  const limit = numeric(window.limit);
  let usage = bar(usedPercent, size);
  if (unit !== null && used !== null && limit !== null) usage += ` (${amount(used, window.unit ?? unit)}/${amount(limit, window.unit ?? unit)})`;
  return `${label} ${usage} (${resetText(window.resetsAt, now)})`;
}

function nativeProviderRow(provider, name, kind, state, summary, windows, unit, now, width) {
  const title = state || "";
  const shortWindows = windows.map(w => `${windowLabel(w)} ${windowAvailability(w) || `${bar(windowPercent(w), 3)} ${compactReset(w.resetsAt, now)}`}`);
  const simple = [title, ...summary, ...shortWindows].filter(Boolean).join(" · ");
  if (cellWidth(simple) <= width) return simple;

  const critical = [...windows].filter(w => windowPercent(w) >= 90).sort((a, b) => windowPercent(b) - windowPercent(a))[0];
  const warning = critical ? ` !${fit(windowLabel(critical), 6)} ${compactUsage(windowPercent(critical), 1)}` : "";
  const compactTitle = fit(title, Math.min(24, Math.max(8, width - 36)));
  // Each page is explicitly numbered. The largest critical window is always
  // pinned, while every total and window is included in the rotation.
  const items = [...summary];
  for (const window of windows) {
    const label = fit(windowLabel(window), 8);
    if (windowAvailability(window)) {
      items.push(`${label} ${windowAvailability(window)}`);
      continue;
    }
    items.push(`${label} ${compactUsage(windowPercent(window), 3)} ${compactReset(window.resetsAt, now)}`);
    if (numeric(window.used) !== null && numeric(window.limit) !== null) {
      items.push(`${label} 已用 ${amount(window.used, window.unit ?? unit)}`);
      items.push(`${label} 总额 ${amount(window.limit, window.unit ?? unit)}`);
    }
  }
  const budget = Math.max(1, width - cellWidth(compactTitle + warning) - 10);
  const pages = [];
  for (const item of items.length ? items : [state || "暂无数据"]) {
    // Summary atoms are separable so a long remaining/total pair never hides
    // the total permanently behind a truncation marker.
    const atoms = item.includes(" / ") ? item.split(" / ").map((v, i) => i ? `总额 ${v}` : v) : [item];
    for (const atom of atoms) {
      const previous = pages.at(-1);
      if (previous && cellWidth(previous + " · " + atom) <= budget) pages[pages.length - 1] += " · " + atom;
      else pages.push(fit(atom, budget));
    }
  }
  const page = Math.floor(now / 5000) % pages.length;
  return fit(`${compactTitle}${warning} [${page + 1}/${pages.length}] ${pages[page]}`, width);
}

function layout(segments, width) {
  const rows = [];
  let row = "";
  for (const segment of segments.filter(Boolean)) {
    if (row && cellWidth(row + " │ " + segment) > width) {
      rows.push(row);
      row = "";
    }
    row += (row ? " │ " : "") + fit(segment, width);
  }
  if (row) rows.push(row);
  return rows;
}

function activitySegments(activity, runState) {
  const result = [];
  const state = ({ starting: "启动中", ready: "就绪", working: "执行中", waiting: "等待中", thinking: "思考中" })[runState];
  if (state) result.push(state);
  if (!activity || typeof activity !== "object") return result;
  if (activity.status !== "ok") {
    if (activity.status === "loading") result.push("动态读取中");
    return result;
  }
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const active = Array.isArray(activity.activeTools) ? activity.activeTools : [];
  for (const tool of active.slice(0, 32)) {
    const name = fit(clean(tool?.name), 16);
    if (name) result.push(`◐ ${name}`);
  }
  const tools = Array.isArray(activity.tools) ? activity.tools : [];
  for (const tool of tools.slice(0, 64)) {
    const name = fit(clean(tool?.name), 16);
    if (name && count(tool.count)) result.push(`${name}×${tool.count}`);
  }
  if (count(activity.agents?.running) && count(activity.agents?.total) && activity.agents.running <= activity.agents.total) {
    result.push(`子代理 ${activity.agents.running}/${activity.agents.total}`);
  } else if (count(activity.agents?.total) && activity.agents.running === undefined) {
    result.push(`子代理 ${activity.agents.total}`);
  }
  if (count(activity.plan?.completed) && count(activity.plan?.total) && activity.plan.completed <= activity.plan.total) {
    result.push(`任务 ${activity.plan.completed}/${activity.plan.total}`);
  }
  const seconds = numeric(activity.elapsedSeconds);
  if (seconds !== null && seconds >= 0) {
    const value = Math.floor(seconds);
    result.push(value < 60 ? `耗时${value}秒` : `耗时${Math.floor(value / 60)}分${value % 60}秒`);
  }
  return result;
}

function activityRow(segments, width, now) {
  if (!segments.length) return "";
  const simple = segments.join(" │ ");
  if (cellWidth(simple) <= width) return simple;
  const pinned = ["启动中", "就绪", "执行中", "等待中", "思考中"].includes(segments[0]) ? segments[0] + " │ " : "";
  const remaining = pinned ? segments.slice(1) : segments;
  const budget = Math.max(1, width - cellWidth(pinned) - 8);
  const pages = [];
  for (const segment of remaining) {
    const last = pages.at(-1);
    if (last && cellWidth(last + " · " + segment) <= budget) pages[pages.length - 1] += " · " + segment;
    else pages.push(fit(segment, budget));
  }
  const page = Math.floor(now / 5000) % pages.length;
  return fit(`${pinned}[${page + 1}/${pages.length}] ${pages[page]}`, width);
}

function render(snapshot = {}, options = {}) {
  if (!snapshot || typeof snapshot !== "object") snapshot = {};
  const width = Math.max(8, Math.floor(options.native ? Math.min(numeric(options.width) ?? 76, 76) : numeric(options.width) ?? 160));
  const now = numeric(options.now) ?? Date.now();
  const size = width < 80 ? 5 : 10;
  const official = snapshot.official;
  const cowork = snapshot.provider ?? snapshot.cowork6;
  const legacyProvider = !snapshot.provider && Boolean(snapshot.cowork6);
  const unit = cowork?.unit ?? (legacyProvider ? "USD" : "");
  const providerName = clean(cowork?.name) || (legacyProvider ? "cowork6" : "当前服务");
  const providerKind = clean(cowork?.kind);
  const officialState = sourceState(official, now);
  const coworkState = sourceState(cowork, now);
  const title = `[${clean(snapshot.model) || "Codex"}] │ ${clean(snapshot.project) || "工作区"}` +
    (snapshot.branch ? ` 分支:(${clean(snapshot.branch)})` : "");
  const officialSegments = (Array.isArray(official?.windows) ? official.windows : [])
    .map(w => windowText(w, size, now, null)).filter(Boolean);
  if (officialSegments.length) officialSegments[0] = `官方${officialState ? ` [${officialState}]` : ""} ` + officialSegments[0];
  else if (official) officialSegments.push(`官方 ${officialState || "暂无数据"}`);
  const coworkSegments = [];
  const quotaLimit = numeric(cowork?.limit);
  const quotaUsed = numeric(cowork?.used);
  if (quotaLimit !== null && quotaLimit > 0 && quotaUsed !== null && quotaUsed >= 0) {
    coworkSegments.push(`已用 ${bar(quotaUsed / quotaLimit * 100, size)}`);
    const remaining = amount(cowork?.remaining, unit);
    coworkSegments.push(remaining === null ? `总额 ${amount(quotaLimit, unit)}` : `剩余 ${remaining} / ${amount(quotaLimit, unit)}`);
  } else {
    for (const [key, label] of [["balance", "余额"], ["remaining", "剩余"], ["used", "已用"], ["limit", "总额"]]) {
      const valueText = amount(cowork?.[key], unit);
      if (valueText !== null) coworkSegments.push(`${label} ${valueText}`);
    }
  }
  const rawWindows = (Array.isArray(cowork?.windows) ? cowork.windows : []).filter(w => w && typeof w === "object");
  const coworkWindows = rawWindows.map(w => windowText(w, size, now, unit)).filter(Boolean);
  const coworkLabel = coworkState || "";
  const coworkSummary = coworkSegments.length ? coworkSegments.join(" · ") : coworkWindows.length || coworkState ? "" : "暂无数据";
  const officialOnly = cowork?.status === "official" || (!cowork && Boolean(official));
  const activity = activitySegments(snapshot.activity, snapshot.runState);
  const activityWithOfficial = [...activity, ...(officialOnly ? [] : officialSegments)];
  const contextLabel = `上下文 ${compactUsage(snapshot.contextPercent, width >= 60 ? 3 : 0)}`;
  const quotaWidth = Math.max(1, width - cellWidth(contextLabel) - 3);
  const compactSummary = coworkSegments.map(segment => segment.replace(/([█░]+) (\d+(?:\.\d+)?)%/g,
    (_, glyphs, value) => bar(Number(value), 3)));
  const quotaRow = officialOnly ? nativeUsageRow(undefined, official, officialState, now, quotaWidth, false) :
    nativeProviderRow(cowork, providerName, providerKind, coworkState,
      compactSummary.length ? compactSummary : rawWindows.length || coworkState ? [] : ["暂无数据"], rawWindows, unit, now, quotaWidth);
  const usageRow = cellWidth(contextLabel) + 4 > width ? fit(contextLabel, width) : `${quotaRow} │ ${contextLabel}`;
  const rows = options.native ? [fit(title, width), usageRow,
    activityRow(activityWithOfficial, width, now),
  ] : [fit(title, width),
    ...layout(officialOnly ? officialSegments : [[coworkLabel, coworkSummary].filter(Boolean).join(" · "), ...coworkWindows], width),
    ...layout([`上下文 ${bar(snapshot.contextPercent, size)}`, ...activityWithOfficial], width)];
  let output = rows.join("\n");
  if (options.color) {
    output = output.replace(/([█░]+) (\d+(?:\.\d+)?)%/g, (all, glyphs, value) => {
      const code = Number(value) >= 90 ? 31 : Number(value) >= 70 ? 33 : 32;
      return `\x1b[${code}m${all}\x1b[0m`;
    });
    output = output.replace(/^\[([^\]\n]+)\]/, options.native ? "\x1b[36m[$1]\x1b[0m" : "\x1b[35m[$1]\x1b[0m");
  }
  return output;
}

function renderTree(snapshot, options = {}) {
  // Parse only ANSI emitted by our renderer, never terminal control sequences
  // from provider data. The native text element wraps each explicit line.
  const text = render(snapshot, { ...options, native: true, color: true });
  const colors = { 31: "red", 32: "green", 33: "yellow", 35: "magenta", 36: "cyan" };
  const children = [];
  let color = null;
  let offset = 0;
  for (const match of text.matchAll(/\x1b\[(\d+)m/g)) {
    const value = text.slice(offset, match.index);
    if (value) children.push(color ? { type: "text", props: { color }, children: [value] } : value);
    color = colors[match[1]] ?? null;
    offset = match.index + match[0].length;
  }
  const remainder = text.slice(offset);
  if (remainder) children.push(color ? { type: "text", props: { color }, children: [remainder] } : remainder);
  return { type: "text", children };
}

module.exports = { render, renderTree, clean, numeric, epoch, cellWidth, fit, percent, bar, money, amount, resetText, sourceState };
