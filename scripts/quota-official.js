'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

function normalizeRateLimits(result, now = new Date()) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const windows = [];
  if (bucket && (!bucket.limitId || bucket.limitId === 'codex')) {
    for (const entry of [bucket.primary, bucket.secondary]) {
      if (!entry) continue;
      const label = entry.windowDurationMins === 300 ? '5h'
        : entry.windowDurationMins === 10080 ? '7d' : null;
      if (!label || !Number.isFinite(entry.usedPercent) || entry.usedPercent < 0 || windows.some(w => w.label === label)) continue;
      windows.push({ label, usedPercent: entry.usedPercent,
        resetsAt: Number.isFinite(entry.resetsAt) ? entry.resetsAt : null });
    }
  }
  windows.sort((a, b) => a.label === b.label ? 0 : a.label === '5h' ? -1 : 1);
  return { status: windows.length ? 'ok' : 'unavailable', updatedAt: now.toISOString(), windows };
}

function homes(options) {
  const mainHome = options.mainHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const officialHome = options.officialHome || path.join(mainHome, 'quota-hud', 'official');
  if (path.resolve(mainHome).toLowerCase() === path.resolve(officialHome).toLowerCase()) {
    throw new Error('ISOLATION_REQUIRED');
  }
  return { mainHome, officialHome };
}

function prepareHome(options) {
  const { mainHome, officialHome } = homes(options);
  fs.mkdirSync(officialHome, { recursive: true, mode: 0o700 });
  const target = path.join(officialHome, 'auth.json');
  if (!fs.existsSync(target)) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(mainHome, 'auth.json'), 'utf8'));
      if (auth.auth_mode === 'chatgpt' && typeof auth.tokens?.access_token === 'string' && auth.tokens.access_token) {
        // Copy only official credentials. Never import an API key or replace refreshed isolated auth.
        const copy = { auth_mode: 'chatgpt', tokens: auth.tokens };
        if (auth.last_refresh) copy.last_refresh = auth.last_refresh;
        fs.writeFileSync(target, JSON.stringify(copy), { flag: 'wx', mode: 0o600 });
      }
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
  }
  return officialHome;
}

function resolveCodexCommand(options = {}) {
  if (options.command) return { command: options.command, args: options.commandArgs || [] };
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const exe = path.join(dir, platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(exe) && fs.statSync(exe).isFile()) return { command: exe, args: [] };
    if (platform !== 'win32') continue;
    // npm's .cmd/.ps1 shims cannot be spawned without a shell. Resolve the native
    // optional package next to that shim, without executing or parsing shell text.
    const packageRoot = path.join(dir, 'node_modules', '@openai', 'codex');
    const architecture = (options.arch || process.arch) === 'arm64' ? 'arm64' : 'x64';
    const triple = architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    for (const root of [path.join(packageRoot, 'node_modules', '@openai', `codex-win32-${architecture}`),
      path.join(dir, 'node_modules', '@openai', `codex-win32-${architecture}`)]) {
      for (const layout of ['bin', 'codex']) {
        const native = path.join(root, 'vendor', triple, layout, 'codex.exe');
        if (fs.existsSync(native)) return { command: native, args: [] };
      }
    }
    const js = path.join(packageRoot, 'bin', 'codex.js');
    if (fs.existsSync(js)) return { command: process.execPath, args: [js] };
  }
  throw new Error('CODEX_NOT_FOUND');
}

class Rpc {
  constructor(child) {
    this.child = child;
    this.events = new EventEmitter();
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.closed = false;
    child.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 2 * 1024 * 1024) return this.fail('RPC_RESPONSE_TOO_LARGE');
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id != null && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          // Server errors can include tokens and request details; never forward them.
          if (message.error) reject(new Error('OFFICIAL_RPC_FAILED'));
          else resolve(message.result);
        } else if (message.method) this.events.emit(message.method, message.params);
      }
    });
    child.stdin.on('error', () => this.fail('OFFICIAL_PROCESS_FAILED'));
    child.stderr.on('data', () => {});
    child.on('error', () => this.fail('OFFICIAL_PROCESS_FAILED'));
    child.on('exit', () => this.fail('OFFICIAL_PROCESS_EXITED'));
  }

  fail(code) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error(code));
    this.pending.clear();
    this.events.emit('failed', code);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('OFFICIAL_PROCESS_EXITED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }

  notify(method) { this.child.stdin.write(JSON.stringify({ method }) + '\n'); }
  close() {
    this.fail('OFFICIAL_CLOSED');
    this.child.stdin.end();
    this.child.kill();
  }
}

const safeErrors = new Set(['ISOLATION_REQUIRED', 'CODEX_NOT_FOUND', 'OFFICIAL_TIMEOUT',
  'OFFICIAL_RPC_FAILED', 'OFFICIAL_PROCESS_FAILED', 'OFFICIAL_PROCESS_EXITED',
  'RPC_RESPONSE_TOO_LARGE', 'OFFICIAL_LOGIN_FAILED']);

async function run(options, login) {
  let rpc;
  let timeout;
  const empty = status => ({ status, updatedAt: new Date().toISOString(), windows: [] });
  try {
    const officialHome = prepareHome(options);
    if (!login && !fs.existsSync(path.join(officialHome, 'auth.json'))) return empty('login-required');
    const command = resolveCodexCommand(options);
    const env = { ...process.env, CODEX_HOME: officialHome };
    // Keep OS/network settings (including proxies), but never inherit credential
    // or auth endpoint overrides from the provider used by the active session.
    const overrides = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_AUTH_TOKEN',
      'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'CODEX_APP_SERVER_CHATGPT_BASE_URL',
      'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
      'CODEX_AUTHAPI_BASE_URL', 'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
      'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL', 'CODEX_AGENT_IDENTITY_JWKS_BASE_URL']);
    for (const key of Object.keys(env)) if (overrides.has(key.toUpperCase())) delete env[key];
    // Isolated cwd avoids loading an unrelated project's configuration or plugins.
    const child = (options.spawnImpl || spawn)(command.command, [...command.args,
      '-c', 'model_provider="openai"', '-c', 'cli_auth_credentials_store="file"',
      '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
      'app-server'], { env, cwd: officialHome, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    rpc = new Rpc(child);
    const work = async () => {
      await rpc.request('initialize', { clientInfo: { name: 'codex_quota_hud', version: '0.1.0' }, capabilities: {} });
      rpc.notify('initialized');
      if (login) {
        // Register before starting the flow: completion can precede the RPC response.
        let resolveCompletion;
        const completion = new Promise(resolve => { resolveCompletion = resolve; });
        rpc.events.once('account/login/completed', result => resolveCompletion(result));
        rpc.events.once('failed', () => resolveCompletion({ success: false }));
        const started = await rpc.request('account/login/start', { type: 'chatgpt' });
        if (typeof started?.authUrl !== 'string') throw new Error('OFFICIAL_LOGIN_FAILED');
        if (options.onLoginUrl) await options.onLoginUrl(started.authUrl);
        const completed = await completion;
        if (!completed?.success) throw new Error('OFFICIAL_LOGIN_FAILED');
      }
      const account = await rpc.request('account/read', { refreshToken: false });
      if (account?.account?.type !== 'chatgpt') return empty('login-required');
      return normalizeRateLimits(await rpc.request('account/rateLimits/read'));
    };
    return await Promise.race([work(), new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('OFFICIAL_TIMEOUT')), options.timeoutMs ?? (login ? 120000 : 20000));
    })]);
  } catch (error) {
    return { ...empty('error'), error: safeErrors.has(error.message) ? error.message : 'OFFICIAL_UNAVAILABLE' };
  } finally {
    clearTimeout(timeout);
    if (rpc) rpc.close();
  }
}

function collectOfficialQuota(options = {}) { return run(options, false); }
function loginOfficial(options = {}) { return run(options, true); }

module.exports = { collectOfficialQuota, loginOfficial, normalizeRateLimits, resolveCodexCommand };
