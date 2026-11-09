/**
 * The Host starts webServer asynchronously. In a clean web profile it comes up
 * after this plugin, so a lookup at load time misses it and every
 * /api/cc-memory route returns 404. Found by installing the packed plugin into
 * a fresh profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnv } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

test('the API registers when webServer starts after the plugin', async (t) => {
  const env = await runtimeEnv(t);
  const { registerHttpApi } = await loadModule('../src/http.js', { requireExports: ['registerHttpApi'] });

  const registered = [];
  const server = {
    register(route) {
      registered.push(route.path);
      return () => registered.pop();
    },
  };
  const services = {};
  let whenReady;
  let fiberDisposed = false;
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer']);
      whenReady = callback;
      return {
        dispose() {
          fiberDisposed = true;
        },
      };
    },
  };

  const dispose = registerHttpApi(ctx, env.runtime);
  assert.deepEqual(registered, [], 'nothing to register on yet');

  services.webServer = server;
  const effects = [];
  whenReady({
    ...ctx,
    effect(factory) {
      effects.push(factory());
    },
  });
  assert.deepEqual(registered, ['/api/cc-memory']);

  for (const stop of effects) stop();
  assert.deepEqual(registered, [], 'the route goes away with the service');

  dispose();
  assert.equal(fiberDisposed, true);
});
