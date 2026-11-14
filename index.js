/**
 * dsh-cc-dream-memory — Claude Code style auto memory and dreaming for DeepSeek Harness.
 *
 * Host half. Designed as a self-contained Cordis plugin for upgrade safety:
 * - only `tools` and `systemPrompt` are hard dependencies; `commands`, `agents`,
 *   `workingDirectory` and `webServer` are resolved optionally and degrade one
 *   capability each instead of keeping the plugin inactive;
 * - every module mounts through `mount()`, so one failing capability cannot
 *   abort the rest or throw into the Harness;
 * - every registration is owned by this plugin's context (one disposable each);
 *   `createMemoryPlugin()` additionally exposes an **awaitable** `dispose()` so
 *   tests and tooling can wait for in-flight background writes instead of
 *   racing the filesystem after unload.
 */
import { resolveConfig } from './src/config.js';
import { MemoryRuntime } from './src/runtime.js';
import { registerInjection } from './src/inject.js';
import { registerTools } from './src/tools.js';
import { registerCommands } from './src/commands.js';
import { registerScheduler } from './src/scheduler.js';
import { registerHttpApi } from './src/http.js';
import { VERSION } from './src/meta.js';

/** Hard dependencies only; everything else is looked up optionally. */
export const inject = ['tools', 'systemPrompt'];

function warn(scope, error) {
  // eslint-disable-next-line no-console
  console.warn(`[cc-memory] ${scope}:`, error?.message ?? error);
}

/**
 * Build the plugin without Cordis ownership. Exported so tests can dispose and
 * await pending background work deterministically.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 * @returns {{runtime: MemoryRuntime|null, dispose: () => Promise<void>}}
 */
export function createMemoryPlugin(ctx, rawConfig) {
  const cleanups = [];
  let runtime = null;
  try {
    const config = resolveConfig(rawConfig, { env: typeof process !== 'undefined' ? process.env : {} });
    runtime = new MemoryRuntime(ctx, config);

    const mount = (name, register) => {
      try {
        const dispose = register();
        if (typeof dispose === 'function') cleanups.push(dispose);
      } catch (error) {
        warn(`${name} registration`, error);
      }
    };

    mount('prompt injection', () => registerInjection(ctx, runtime));
    if (config.tools) mount('memory tools', () => registerTools(ctx, runtime));
    mount('slash commands', () => registerCommands(ctx, runtime));
    mount('dream scheduler', () => registerScheduler(ctx, runtime));
    mount('web api', () => registerHttpApi(ctx, runtime));

    // Prewarm contexts for agents that already exist when this plugin loads
    // through HMR (their `agent/created` event already fired). Tracked so
    // dispose() can wait for the resulting writes.
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      if (agents && typeof agents.list === 'function') {
        for (const agent of agents.list()) {
          runtime.track(runtime.forAgent(agent));
        }
      }
    } catch (error) {
      warn('prewarm', error);
    }

    // eslint-disable-next-line no-console
    console.info(`[cc-memory] dsh-cc-dream-memory v${VERSION} loaded`);
  } catch (error) {
    // Never let a plugin initialization failure reach the Host.
    warn('apply', error);
  }

  return {
    runtime,
    async dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup();
        } catch (error) {
          warn('cleanup', error);
        }
      }
      if (runtime) {
        try {
          await runtime.drain();
        } catch (error) {
          warn('drain', error);
        }
      }
    },
  };
}

/**
 * Cordis plugin entry.
 *
 * `enabled` no longer stops the plugin from loading: a disabled plugin must
 * still be able to re-enable itself through `/memory plugin on` or the Web UI.
 * The effective switch is `runtime.config` (row config + live overrides).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig row config from cordis.patch.yml
 */
export function apply(ctx, rawConfig) {
  const plugin = createMemoryPlugin(ctx, rawConfig);
  ctx.effect(() => () => {
    void plugin.dispose();
  });
}
