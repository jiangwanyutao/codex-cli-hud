'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { collectOfficialQuota, loginOfficial, normalizeRateLimits, resolveCodexCommand } = require('./quota-official');

function fixture(t, auth = { auth_mode: 'chatgpt', tokens: { access_token: 'test-secret' } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-official-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainHome = path.join(root, 'main');
  const officialHome = path.join(root, 'official');
  fs.mkdirSync(mainHome);
  if (auth) fs.writeFileSync(path.join(mainHome, 'auth.json'), JSON.stringify(auth));
  return { root, mainHome, officialHome, command: 'mock-codex', timeoutMs: 1000 };
}

function fake(handler) {
  const calls = [];
  let child;
  const spawnImpl = (command, args, options) => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const request = JSON.parse(chunk.toString());
      calls.push(request);
      if (request.id) queueMicrotask(() => {
        const value = handler?.(request, child) ?? { result: {} };
        if (value !== false) child.stdout.write(JSON.stringify({ id: request.id, ...value }) + '\n');
      });
      done();
    } });
    child.args = args;
    child.options = options;
    return child;
  };
  return { spawnImpl, calls, child: () => child };
}

test('normalization chooses codex bucket, matches window duration, rejects unrelated buckets', () => {
  const w = (mins, percent) => ({ windowDurationMins: mins, usedPercent: percent, resetsAt: 123 });
  const result = normalizeRateLimits({ rateLimits: { primary: w(300, 99) }, rateLimitsByLimitId: {
    codex: { secondary: w(300, 25), primary: w(10080, 70) },
    other: { primary: w(300, 100) }
  } });
  assert.deepEqual(result.windows, [{ label: '5h', usedPercent: 25, resetsAt: 123 }, { label: '7d', usedPercent: 70, resetsAt: 123 }]);
  assert.deepEqual(normalizeRateLimits({ rateLimits: { limitId: 'other', primary: w(300, 5) } }).windows, []);
  assert.deepEqual(normalizeRateLimits({ rateLimits: { primary: w(60, 5), secondary: w(300, null) } }).windows, []);
  assert.equal(normalizeRateLimits({ rateLimits: { primary: w(300, 120) } }).windows[0].usedPercent, 120);
});

test('missing, unrelated, negative and invalid windows report unavailable with a timestamp', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  for (const result of [undefined, {}, { rateLimits: { limitId: 'other' } },
    ...[-1, NaN, Infinity, null, '10'].map(usedPercent => ({
      rateLimits: { primary: { windowDurationMins: 300, usedPercent } }
    }))]) {
    assert.deepEqual(normalizeRateLimits(result, now), {
      status: 'unavailable', updatedAt: now.toISOString(), windows: []
    });
  }
});

test('isolated first-use copy excludes API keys; exact RPC lifecycle and cleanup', async t => {
  const options = fixture(t, { auth_mode: 'chatgpt', tokens: { access_token: 'test-secret' }, OPENAI_API_KEY: 'never-copy' });
  const mock = fake(req => req.method === 'account/read' ? { result: { account: { type: 'chatgpt' } } } :
    req.method === 'account/rateLimits/read' ? { result: { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 42, resetsAt: 123 } } } } : undefined);
  const result = await collectOfficialQuota({ ...options, spawnImpl: mock.spawnImpl });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows[0].usedPercent, 42);
  assert.deepEqual(mock.calls.map(r => r.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.equal(mock.child().killed, true);
  assert.equal(mock.child().options.env.CODEX_HOME, options.officialHome);
  assert.equal(mock.child().options.shell, false);
  assert.equal(mock.child().options.env.OPENAI_API_KEY, undefined);
  const copied = JSON.parse(fs.readFileSync(path.join(options.officialHome, 'auth.json')));
  assert.equal(copied.OPENAI_API_KEY, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.mainHome, 'auth.json'))).OPENAI_API_KEY, 'never-copy');
});

test('official child strips inherited endpoint overrides and explicitly pins the backend', async t => {
  const options = fixture(t);
  const overrides = ['OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
    'CODEX_REVOKE_TOKEN_URL_OVERRIDE', 'CODEX_AUTHAPI_BASE_URL', 'CODEX_APP_SERVER_CHATGPT_BASE_URL',
    'CODEX_APP_SERVER_LOGIN_CLIENT_ID'];
  const previous = new Map(overrides.map(key => [key, process.env[key]]));
  for (const key of overrides) process.env[key] = 'https://custom.example';
  try {
    const mock = fake(() => ({ result: { account: null } }));
    await collectOfficialQuota({ ...options, spawnImpl: mock.spawnImpl });
    for (const key of overrides) {
      assert.equal(mock.child().options.env[key], undefined, key);
      assert.equal(process.env[key], 'https://custom.example', 'parent environment preserved');
    }
    assert.ok(mock.child().args.includes('chatgpt_base_url="https://chatgpt.com/backend-api/"'));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('never replaces refreshed isolated credentials', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.officialHome);
  const authPath = path.join(options.officialHome, 'auth.json');
  fs.writeFileSync(authPath, 'isolated-value');
  const mock = fake(() => ({ result: { account: null } }));
  assert.equal((await collectOfficialQuota({ ...options, spawnImpl: mock.spawnImpl })).status, 'login-required');
  assert.equal(fs.readFileSync(authPath, 'utf8'), 'isolated-value');
});

test('API key and absent main auth require login without launching process', async t => {
  for (const auth of [null, { auth_mode: 'apikey', tokens: { access_token: 'not-official' } }]) {
    const options = fixture(t, auth);
    const result = await collectOfficialQuota({ ...options, spawnImpl: () => { throw new Error('must not spawn'); } });
    assert.equal(result.status, 'login-required');
    assert.equal(fs.existsSync(path.join(options.officialHome, 'auth.json')), false);
  }
});

test('timeout kills child and server errors never leak response details', async t => {
  const options = fixture(t);
  const mock = fake(() => false);
  const result = await collectOfficialQuota({ ...options, timeoutMs: 10, spawnImpl: mock.spawnImpl });
  assert.equal(result.error, 'OFFICIAL_TIMEOUT');
  assert.equal(mock.child().killed, true);
  const errorMock = fake(() => ({ error: { message: 'Bearer secret-value', data: 'private' } }));
  const error = await collectOfficialQuota({ ...options, spawnImpl: errorMock.spawnImpl });
  assert.equal(error.error, 'OFFICIAL_RPC_FAILED');
  assert.ok(!JSON.stringify(error).includes('secret'));
  assert.equal(errorMock.child().killed, true);
});

test('explicit browser login invokes callback and then reads quota', async t => {
  const options = fixture(t, null);
  let authUrl;
  const mock = fake((req, child) => {
    if (req.method === 'account/login/start') {
      child.stdout.write(JSON.stringify({ method: 'account/login/completed', params: { success: true } }) + '\n');
      return { result: { authUrl: 'https://auth.openai.com/example' } };
    }
    if (req.method === 'account/read') return { result: { account: { type: 'chatgpt' } } };
  });
  const result = await loginOfficial({ ...options, spawnImpl: mock.spawnImpl, onLoginUrl: url => { authUrl = url; } });
  assert.equal(result.status, 'unavailable');
  assert.equal(authUrl, 'https://auth.openai.com/example');
  assert.equal(mock.child().killed, true);
});

test('rejects main-home reuse and resolves Windows npm native binary with spaces safely', async t => {
  const options = fixture(t);
  assert.equal((await collectOfficialQuota({ ...options, officialHome: options.mainHome })).error, 'ISOLATION_REQUIRED');
  const binDir = path.join(options.root, 'Program Files');
  const exe = path.join(binDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  assert.deepEqual(resolveCodexCommand({ platform: 'win32', arch: 'x64', env: { PATH: binDir } }), { command: exe, args: [] });
});
