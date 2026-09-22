// Run with Node --expose-internals and the desktop's compiled internals preload.
// Uses an isolated Profile and actual DSH services; never reads user sessions.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createDesktopPluginClient } from './desktop-plugin-client.mjs';

const require = createRequire(realpathSync(resolve(process.argv[2])));
const load = name => import(pathToFileURL(require.resolve(name)));
const { boot, initProfile, loadProfileDirectory, readProfilePatches, readProfileManifest } = await load('@deepseek-ai/dsh-app-boot');
const { default: PluginManager } = await load('@deepseek-ai/dsh-plugin-manager');
const { default: Hmr } = await load('@deepseek-ai/dsh-hmr');
const { default: Timer } = await load('@deepseek-ai/cordis-plugin-timer');

for (const live of [false, true]) {
  const home = mkdtempSync(join(tmpdir(), 'dfy-official-switch-'));
  let ctx;
  let client;
  try {
    const dir = join(home, 'profiles', 'test');
    const anchor = join(home, 'package.json');
    writeFileSync(anchor, '{"name":"installation","dependencies":{}}');
    initProfile(dir, ['core', 'extra']);
    for (const [name, rows] of [
      ['core', [{ id: 'manager', name: 'cordis:manager', config: {} }]],
      ['extra', [{ id: 'managed', name: './plugin.mjs' }]],
    ]) {
      const path = join(dir, 'node_modules', name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
      writeFileSync(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]));
      writeFileSync(join(path, 'plugin.mjs'), 'export function apply(ctx) { ctx.provide("managedProbe", true) }');
    }
    const manifest = readProfileManifest('test', dir);
    manifest.dependencies = { extra: '1.0.0' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'cordis.yml'), '[]\n');
    const profile = {
      name: 'test', dir, home, cwd: home, installAnchor: anchor,
      startedBundles: loadProfileDirectory('test', dir, anchor).layers.map(layer => layer.packageName),
      patchPath: join(dir, 'cordis.patch.yml'), overlays: [], telemetryDisabledEnv: undefined,
    };
    ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), owner => {
      ctx = owner;
      owner.provide('appReady', { onReady(listener) { listener(); return () => {}; } });
      owner.provide('profileContext', profile);
      owner.loader.builtins.manager = PluginManager;
    });
    if (live) {
      await ctx.plugin(Timer);
      await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 });
      await ctx.hmr.runExclusive(async () => {});
    }
    client = await createDesktopPluginClient(resolve(process.argv[2]), async (path, endpoint, payload) => {
      assert.equal(path, '/api');
      assert.equal(endpoint, 'pluginManager/setBundleEnabled');
      return { ok: true, value: await ctx.pluginManager.setBundleEnabled(payload.args.name, payload.args.enabled) };
    });
    const bridge = client.transport;
    assert.equal(ctx.managedProbe, true);
    assert.equal((await bridge.setBundleEnabled('extra', false)).application, live ? 'applied' : 'restart-required');
    assert.deepEqual(readProfileManifest('test', dir).dsh.profile.bundles, ['core']);
    assert.equal(readProfileManifest('test', dir).dependencies.extra, '1.0.0');
    assert.equal(ctx.managedProbe, live ? undefined : true);
    assert.equal((await bridge.setBundleEnabled('extra', true)).application, live ? 'applied' : 'restart-required');
    assert.deepEqual(readProfileManifest('test', dir).dsh.profile.bundles, ['core', 'extra']);
    assert.equal(ctx.managedProbe, true);
    if (live) {
      assert.equal((await ctx.pluginManager.setPluginEnabled('include:managed', false)).application, 'applied');
      assert.equal(ctx.managedProbe, undefined);
      assert.equal((await ctx.pluginManager.setPluginEnabled('include:managed', true)).application, 'applied');
      assert.equal(ctx.managedProbe, true);
    }
    assert.equal((await bridge.setBundleEnabled('core', false)).error.code, 'management-required');
    await client.dispose();
    assert.equal(client.window[Symbol.for('dsh.desktop.plugin-manager.transport.v1')], undefined);
    console.log(`PASS official Client Gateway bundle switches, dependency preservation and bridge lifecycle (HMR ${live})`);
  } finally {
    await client?.dispose();
    await ctx?.fiber.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}
