import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { registerHttpApi } from '../src/http.js';
import { fakeRes, runtimeEnv, exists } from './v10-helpers.mjs';

/** Exercise the route mounted on the host, with a real isolated runtime/store. */
async function registeredApi(t) {
  const env = await runtimeEnv(t);
  let route;
  const listeners = new Map();
  const dispose = registerHttpApi({
    get: (name) => name === 'webServer' ? {
      register(definition) {
        route = definition;
        return () => {};
      },
    } : undefined,
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  }, env.runtime);
  t.after(dispose);
  const rows = [];
  listeners.get('webserver/index-inject')(rows, { principal: { kind: 'owner' } });
  const { token } = rows.find((row) => row.name === '__CC_MEMORY_API__').value;

  async function request({
    method = 'GET', path = '/bridge', host = '127.0.0.1:61784', origin,
    authToken, remoteAddress = '127.0.0.1', body, rawHeaders, headers = {},
  } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = `${route.path}${path}`;
    req.headers = { ...headers };
    if (host !== null) req.headers.host = host;
    if (origin !== undefined) req.headers.origin = origin;
    if (authToken !== undefined) req.headers['x-cc-memory-token'] = authToken;
    req.rawHeaders = rawHeaders ?? Object.entries(req.headers).flat();
    req.httpVersion = '1.1';
    req.socket = { remoteAddress, remotePort: 50000 };
    const res = fakeRes();
    const end = res.end;
    const complete = new Promise((resolve) => {
      res.end = function (chunk) {
        end.call(this, chunk);
        resolve();
        return this;
      };
    });
    route.handler(req, res);
    await complete;
    return res;
  }
  return { ...env, token, request };
}

test('registered bridge denies an attacker Host even over a loopback socket', async (t) => {
  const env = await registeredApi(t);
  const res = await env.request({ host: 'attacker.test:61784', origin: 'http://attacker.test:61784' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'bad-host');
  assert.equal(res.json().token, undefined);
});

test('registered bridge rejects missing, malformed, and ambiguous Host authorities', async (t) => {
  const env = await registeredApi(t);
  for (const host of [
    null, '', ' localhost', 'localhost ', 'localhost\n', 'localhost\r\n',
    'localhost\t', 'localhost\0', 'localhost.', 'localhost.attacker.test',
    '127.0.0.1.attacker.test', '127.1', '2130706433', '0x7f000001',
    'attacker.test@localhost', 'localhost@attacker.test', 'localhost/path',
    'localhost?x=1', 'localhost#fragment', 'localhost\\attacker.test',
    'localhost:0', 'localhost:65536', 'localhost:', 'localhost:-1',
    'localhost:+80', 'localhost:80x', 'localhost:000080', 'localhost:80:90',
    'localhost, attacker.test', '::1', '[::1', '[::1]:0', '[::1]:65536',
    '[::ffff:127.0.0.1]', ['localhost', 'attacker.test'],
  ]) {
    await t.test(JSON.stringify(host), async () => {
      const res = await env.request({ host });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error, 'bad-host');
      assert.equal(res.json().token, undefined);
    });
  }
});

test('registered bridge rejects duplicate Host fields even when Node retains one safe value', async (t) => {
  const env = await registeredApi(t);
  for (const rawHeaders of [
    ['Host', 'localhost', 'Host', 'attacker.test'],
    ['Host', 'localhost', 'hOsT', 'localhost'],
    [],
  ]) {
    const res = await env.request({ host: 'localhost', rawHeaders });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().token, undefined);
  }
});

test('registered bridge accepts desktop loopback authorities with valid optional ports', async (t) => {
  const env = await registeredApi(t);
  for (const host of [
    'localhost', 'LOCALHOST:61784', 'localhost:1', 'localhost:65535',
    '127.0.0.1', '127.0.0.1:61784', '127.0.0.1:80', '[::1]', '[::1]:61784',
  ]) {
    const res = await env.request({ host });
    assert.equal(res.statusCode, 200, host);
    assert.equal(res.json().token, env.token, host);
  }
});

test('registered write rejects attacker Host before matching Origin can authorize a mutation', async (t) => {
  const env = await registeredApi(t);
  assert.equal(env.runtime.effectiveEnabled(), true);
  assert.equal(await exists(env.runtime.overrideFile), false);
  const res = await env.request({
    method: 'POST', path: '/toggle', host: 'attacker.test:61784',
    origin: 'http://attacker.test:61784', authToken: env.token, body: { enabled: false },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'bad-host');
  assert.equal(env.runtime.effectiveEnabled(), true);
  assert.equal(await exists(env.runtime.overrideFile), false);
});

test('forwarding headers cannot turn an attacker Host into an allowed authority', async (t) => {
  const env = await registeredApi(t);
  const res = await env.request({
    host: 'attacker.test',
    headers: { forwarded: 'host=localhost;for=127.0.0.1', 'x-forwarded-host': 'localhost' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().token, undefined);
});

test('allowed Host preserves token, Origin, and remote-socket protections', async (t) => {
  const env = await registeredApi(t);
  const missingToken = await env.request({ path: '/status' });
  assert.equal(missingToken.statusCode, 401);
  assert.equal(missingToken.json().error, 'unauthorized');

  const remoteBridge = await env.request({ remoteAddress: '10.0.0.9' });
  assert.equal(remoteBridge.statusCode, 403);
  assert.equal(remoteBridge.json().token, undefined);
  const remoteWrite = await env.request({
    method: 'POST', path: '/toggle', authToken: env.token,
    remoteAddress: '10.0.0.9', body: { enabled: false },
  });
  assert.equal(remoteWrite.statusCode, 403);
  assert.equal(remoteWrite.json().error, 'loopback-only');

  const crossOrigin = await env.request({
    method: 'POST', path: '/toggle', origin: 'http://attacker.test',
    authToken: env.token, body: { enabled: false },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(crossOrigin.json().error, 'bad-origin');
  assert.equal(env.runtime.effectiveEnabled(), true);

  const sameOrigin = await env.request({
    method: 'POST', path: '/toggle', origin: 'http://127.0.0.1:61784',
    authToken: env.token, body: { enabled: false },
  });
  assert.equal(sameOrigin.statusCode, 200);
  assert.equal(sameOrigin.json().ok, true);
  assert.equal(env.runtime.effectiveEnabled(), false);
  assert.equal(JSON.parse(await readFile(env.runtime.overrideFile, 'utf8')).enabled, false);
});
