import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

// Actual published settings mirror/write queue and ThemeRuntime. The simulated
// Remote lets tests deliver document invalidations between queued writes.
export async function createThemeClient(dshPackagePath, settings, { initialize = true } = {}) {
  const require = createRequire(realpathSync(dshPackagePath));
  const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  // Observable storage only: the published store's Zustand/Immer engine is
  // supplied by the browser shared bundle and is not a Host dependency.
  const store = { createSnapshotStore(initial) {
    let value = initial;
    const listeners = new Set();
    const set = next => { value = next; for (const listener of listeners) listener(); };
    return { getSnapshot: () => value, set,
      update(fn) { const next = structuredClone(value); fn(next); set(next); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
  } };
  let factory;
  const messages = [];
  const window = { __ModuleLoader__: { load(entry) { factory = entry.factory; } },
    parent: { postMessage(message) { messages.push(message); } } };
  const load = file => {
    runInNewContext(readFileSync(file, 'utf8'), { window, structuredClone });
    return factory(name => {
      if (name === '@deepseek-ai/cordis') return cordis;
      if (name === '@deepseek-ai/dsh-client-store') return store;
      return {};
    });
  };
  const clientPath = name => new URL('lib/client.js', pathToFileURL(require.resolve(`${name}/package.json`)));
  const settingsClient = load(clientPath('@deepseek-ai/dsh-client-ui-settings'));
  const themeClient = load(clientPath('@deepseek-ai/dsh-client-ui-theme'));
  const bridge = load(new URL('../../resources/dsh-desktop-bridge/lib/client.js', import.meta.url));
  const ctx = new cordis.Context();
  ctx.provide('remote', { settings, $host: { isLoopback: true }, $on: () => () => {} });
  settingsClient.apply(ctx);
  const forms = ctx.configForms;
  const form = forms.get('ui-theme');
  const theme = new themeClient.ThemeRuntime(ctx, form);
  const fixture = { theme, form, refresh: () => forms.describe().load() };
  if (initialize) await fixture.refresh();
  return {
    ...fixture,
    guard: () => bridge.installThemeWriteGuard(fixture.theme, fixture.form, fixture.refresh),
    sync: () => bridge.installThemeSyncTransport(fixture.theme, fixture.form, fn => ctx.on('theme/change', fn)),
    messages,
    readPreference: () => window[Symbol.for(bridge.THEME_SYNC_TRANSPORT_KEY)]?.readPreference(),
    onChange: fn => ctx.on('theme/change', fn),
    dispose: () => ctx.fiber.dispose(),
  };
}
