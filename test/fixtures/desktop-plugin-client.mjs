import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

// Use the shipped Client Gateway, generated Remote contract, and Cordis injection
// checks. Only the network carrier and unrelated UI services are stand-ins.
export async function createDesktopPluginClient(dshPackagePath, call) {
  const require = createRequire(realpathSync(dshPackagePath));
  const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const { default: remotes } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/remote')));
  let factory;
  const window = {
    __ModuleLoader__: { load(entry) { factory = entry.factory; } },
    addEventListener() {},
    removeEventListener() {},
  };
  const loadClient = (file) => {
    factory = undefined;
    runInNewContext(readFileSync(file, 'utf8'), { window, AbortController, AbortSignal, crypto: globalThis.crypto });
    if (!factory) throw new Error(`Client module did not register: ${file}`);
    return factory(name => {
      if (name === '@deepseek-ai/cordis') return cordis;
      if (name === 'react' || name === '@deepseek-ai/dsh-client-ui-primitives') return {};
      throw new Error(`Unexpected client dependency: ${name}`);
    });
  };
  const gateway = loadClient(new URL('lib/client.js', pathToFileURL(require.resolve('@deepseek-ai/dsh-api-gateway/package.json'))));
  const client = loadClient(new URL('../../resources/dsh-desktop-bridge/lib/client.js', import.meta.url));
  const ctx = new cordis.Context();
  try {
    ctx.provide('connection', {
      rpc: { call, open() { throw new Error('Unexpected stream request'); } },
      start() { return { stop() {} }; },
      registerGenerationSource() { return () => {}; },
    });
    ctx.provide('typert', { remotes: { register() { return () => {}; } } });
    await ctx.plugin(gateway);
    await ctx.remote.$mount(remotes);

    const observable = value => ({ getSnapshot: () => value, subscribe: () => () => {} });
    ctx.provide('slots', { inject() {} });
    ctx.provide('sessions', { list: observable({ byId: {} }) });
    ctx.provide('uiSession', { sessionStatus: observable(new Map()) });
    ctx.provide('uiConversation', {});
    ctx.provide('uiWorkspace', { openSession() {} });
    ctx.provide('cordisInspect', { register() { return () => {}; } });
    await ctx.plugin(client);
    const key = Symbol.for('dsh.desktop.plugin-manager.transport.v1');
    return { transport: window[key], window, dispose: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
