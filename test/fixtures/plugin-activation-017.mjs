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
const { boot, initProfile, loadProfileDirectory, readProfilePatches, readProfileManifest, prepareProfileEntries, reportSkippedBundles } = await load('@deepseek-ai/dsh-app-boot');
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

    // rc.1: typed refusals retain every incompatible peer through the Client
    // Gateway. Both activation and boot must refuse before importing code.
    const incompatibleDir = join(dir, 'node_modules', 'incompatible');
    mkdirSync(incompatibleDir, { recursive: true });
    writeFileSync(join(incompatibleDir, 'package.json'), JSON.stringify({
      name: 'incompatible', version: '1.0.0',
      peerDependencies: { '@deepseek-ai/dsh': '>=99.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }));
    writeFileSync(join(incompatibleDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'blocked', name: './plugin.mjs' }] }]));
    writeFileSync(join(incompatibleDir, 'plugin.mjs'), 'throw new Error("Incompatible plugin must never execute")');
    const before = readProfileManifest('test', dir);
    before.dependencies.incompatible = '1.0.0';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(before));
    const refusal = await bridge.setBundleEnabled('incompatible', true);
    assert.equal(refusal.application, 'failed');
    assert.equal(refusal.error.code, 'incompatible-version');
    assert.equal(refusal.changed, false);
    assert.deepEqual(refusal.error.incompatible[0].peers, { '@deepseek-ai/dsh': '>=99.0.0' });
    assert.equal(refusal.error.incompatible[0].name, 'incompatible');
    assert.deepEqual(readProfileManifest('test', dir), before);
    const stderr = process.stderr.write;
    const diagnostics = [];
    try {
      process.stderr.write = chunk => { diagnostics.push(String(chunk)); return true; };
      const rows = prepareProfileEntries(ctx, [{ id: 'blocked', name: pathToFileURL(join(incompatibleDir, 'plugin.mjs')).href }], pathToFileURL(join(dir, 'cordis.yml')).href);
      assert.equal(rows[0].disabled, true);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...before, dsh: { profile: { bundles: [...before.dsh.profile.bundles, 'incompatible'] } } }));
      const loaded = loadProfileDirectory('dsh', dir, anchor);
      assert.ok(!loaded.layers.some(layer => layer.packageName === 'incompatible'));
      assert.equal(loaded.skippedBundles[0].packageName, 'incompatible');
      // rc.2 keeps loading silent; the official launcher reports skips once.
      loadProfileDirectory('dsh', dir, anchor);
      assert.ok(!diagnostics.join('').includes('skipping profile bundle'));
      reportSkippedBundles('dsh', loaded);
      assert.match(diagnostics.join(''), /dsh: disabling profile plugin row "blocked": Plugin incompatible@1.0.0 is incompatible/);
      assert.match(diagnostics.join(''), /dsh: skipping profile bundle "incompatible": Error: Plugin incompatible@1.0.0 is incompatible/);
      assert.equal(diagnostics.join('').match(/skipping profile bundle/g).length, 1);
    } finally {
      process.stderr.write = stderr;
      writeFileSync(join(dir, 'package.json'), JSON.stringify(before));
    }
    console.log(`PASS rc.2 typed compatibility refusal, row preflight and bundle skip (HMR ${live})`);
    await client.dispose();
    assert.equal(client.window[Symbol.for('dsh.desktop.plugin-manager.transport.v1')], undefined);
    console.log(`PASS official Client Gateway bundle switches, dependency preservation and bridge lifecycle (HMR ${live})`);
  } finally {
    await client?.dispose();
    await ctx?.fiber.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}
