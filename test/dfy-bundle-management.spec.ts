import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginManagementService } from '../src/main/plugin-management.js'
import { DfyPluginCatalog } from '../src/renderer/DfyPluginCatalog.js'
import { DFY_PLUGINS, includedDfyPlugins, normalizeDfySelection, parseDfyPluginCatalog } from '../src/shared/dfy-plugins.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const bundle = '@dfy-plugins/dsh-bundle'
const wallpaper = '@dfy-plugins/dsh-wallpaper'
const appearance = '@dfy-plugins/dsh-appearance'

async function fixture(installed = true, standalone = false) {
  const home = await mkdtemp(join(tmpdir(), 'dfy-bundle-manager-'))
  roots.push(home)
  const profile = join(home, 'profiles/web')
  const directory = join(profile, 'node_modules', bundle)
  await mkdir(directory, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dependencies: { ...(installed ? { [bundle]: '^0.1.0' } : {}), ...(standalone ? { [wallpaper]: 'link:/my-source' } : {}) },
    dsh: { profile: { bundles: installed ? [bundle] : [] } },
  }))
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: bundle, version: '0.1.0', dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
    dfy: { includes: [wallpaper, appearance, '../../outside', bundle] },
    dependencies: { [wallpaper]: '0.1.3', [appearance]: '0.1.5' },
  }))
  const member = join(directory, 'node_modules', wallpaper)
  await mkdir(member, { recursive: true })
  await writeFile(join(member, 'package.json'), JSON.stringify({ name: wallpaper, version: '0.1.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const runPnpm = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
  const service = new PluginManagementService(home, { getWindow: () => undefined, runPnpm })
  return { service, runPnpm, profile, directory }
}

it('recognizes actual nested components without flattening them into direct installs', async () => {
  const { service, profile } = await fixture()
  const plugins = (await service.getInventory()).profiles[0]!.plugins
  expect(plugins).toHaveLength(1)
  expect(plugins[0]).toMatchObject({ name: bundle, toggleable: true, active: true, includedPlugins: [
    { name: wallpaper, version: '0.1.3', status: 'ready' }, { name: appearance, status: 'missing' },
  ] })
  expect(includedDfyPlugins(plugins).get(wallpaper)?.bundle.name).toBe(bundle)
  await service.setActive({ profile: 'web', packageName: bundle, active: false })
  expect((await service.getInventory()).profiles[0]!.plugins[0]!.includedPlugins).toHaveLength(2)
  expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies[bundle]).toBe('^0.1.0')
})

it('prevents reinstalling bundled components through either desktop install entry', async () => {
  const { service, runPnpm } = await fixture()
  await expect(service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: [wallpaper] })).rejects.toThrow('已由')
  await expect(service.install({ profile: 'web', source: `${wallpaper}@latest` })).rejects.toThrow('已由')
  expect(runPnpm).not.toHaveBeenCalled()
})

it('does not silently replace existing standalone sources when installing a bundle', async () => {
  const { service, runPnpm, directory } = await fixture(false, true)
  await expect(service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: [bundle, wallpaper] })).rejects.toThrow('先迁移')
  await expect(service.install({ profile: 'web', source: `link:${directory}` })).rejects.toThrow('先迁移')
  expect(runPnpm).not.toHaveBeenCalled()
})

it('deduplicates batch installs and validates bundle membership metadata', () => {
  expect(normalizeDfySelection([wallpaper, bundle, appearance], DFY_PLUGINS)).toEqual([bundle])
  for (const includes of [[bundle], [wallpaper, wallpaper], ['../../outside'], ['@dfy-plugins/dsh-vision']]) {
    expect(() => parseDfyPluginCatalog({ version: 1, plugins: [{ ...DFY_PLUGINS[0], includes }] })).toThrow()
  }
})

it('shows bundled components with their installed version and no separate install or update', async () => {
  const { service } = await fixture()
  const plugins = (await service.getInventory()).profiles[0]!.plugins
  const html = renderToStaticMarkup(createElement(DfyPluginCatalog, { plugins, query: '壁纸', disabled: false, loading: false,
    onReload: () => {}, onOpenRepository: () => {}, onMutate: async () => true, onManage: () => {} }))
  expect(html).toContain('由DFY 插件组合包提供')
  expect(html).toContain('v0.1.3')
  expect(html).toContain('管理组合包')
  expect(html).not.toContain('选择壁纸')
  expect(html).not.toContain('>安装</button>')
})
