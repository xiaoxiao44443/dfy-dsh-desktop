import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginManagementService } from '../src/main/plugin-management.js'
import { DFY_PLUGINS, DFY_PLUGIN_CATALOG_URL, isDfyRegistrySource, parseDfyPluginCatalog } from '../src/shared/dfy-plugins.js'
import type { DfyPluginDefinition, DfyPluginMutationRequest } from '../src/shared/contracts.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const wallpaper = '@dfy-plugins/dsh-wallpaper'
const vision = '@dfy-plugins/dsh-vision'

async function fixture(dependencies: Record<string, string> = {}, plugins: DfyPluginDefinition[] = DFY_PLUGINS) {
  const home = await mkdtemp(join(tmpdir(), 'dfy-catalog-test-'))
  roots.push(home)
  const profileDir = join(home, 'profiles/web')
  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  await writeFile(manifestPath, JSON.stringify({ dependencies, dsh: {
    profile: { bundles: ['@deepseek-ai/dsh-base'] },
    desktop: { disabledBundles: [wallpaper], bundleOrder: ['@deepseek-ai/dsh-base', wallpaper] },
  } }))
  const runPnpm = vi.fn(async (_profile: string, args: string[]) => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const arg of args.slice(1).filter((arg) => arg.startsWith('@dfy-plugins/'))) {
      const name = arg.replace(/@latest$/u, '')
      manifest.dependencies[name] = '^0.1.3'
      manifest.dsh.profile.bundles.push(name)
      const dir = join(profileDir, 'node_modules', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    }
    await writeFile(manifestPath, JSON.stringify(manifest))
    return { exitCode: 0, stdout: 'done', stderr: '' }
  })
  const request = vi.fn(async (input: string | URL | Request) => String(input) === DFY_PLUGIN_CATALOG_URL
    ? Response.json({ version: 1, plugins })
    : Response.json({ name: decodeURIComponent(new URL(String(input)).pathname.split('/')[1]!), version: '0.1.3' }))
  const service = new PluginManagementService(home, { getWindow: () => undefined, runPnpm, fetch: request as typeof fetch })
  return { service, runPnpm, manifestPath, request, home }
}

describe('DFY catalog operations', () => {
  it('installs a deduplicated selection in one command and preserves disabled plugins', async () => {
    const { service, runPnpm } = await fixture()
    const result = await service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: [wallpaper, vision, wallpaper] })
    expect(runPnpm).toHaveBeenCalledExactlyOnceWith('web', ['add', `${wallpaper}@latest`, `${vision}@latest`, '--registry=https://registry.npmjs.org'])
    expect(result.exitCode).toBe(0)
    expect(result.inventory.profiles[0]?.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: wallpaper, active: false }), expect.objectContaining({ name: vision, active: true }),
    ]))
  })

  it('updates only selected installed registry packages across version ranges', async () => {
    const { service, runPnpm } = await fixture({ [wallpaper]: '^0.1.0', [vision]: 'latest', '@sample/plugin': '^1.0.0' })
    await service.mutateDfyPlugins({ profile: 'web', action: 'update', packageNames: [wallpaper, vision] })
    expect(runPnpm).toHaveBeenCalledExactlyOnceWith('web', ['update', wallpaper, vision, '--latest', '--registry=https://registry.npmjs.org'])
  })

  it.each(['link:/local/dev', 'workspace:*', 'github:owner/repo', 'https://example.com/plugin.tgz', 'npm:other-package@latest'])(
    'preserves an existing %s source even when grouped with uninstalled plugins', async (source) => {
      const { service, runPnpm } = await fixture({ [wallpaper]: source })
      await expect(service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: [vision, wallpaper] })).rejects.toThrow('已安装')
      await expect(service.mutateDfyPlugins({ profile: 'web', action: 'update', packageNames: [wallpaper] })).rejects.toThrow('已安装')
      expect(runPnpm).not.toHaveBeenCalled()
    },
  )

  it('rejects unsupported selections, actions and missing update targets before execution', async () => {
    const { service, runPnpm } = await fixture()
    for (const packageNames of [[], ['--global'], ['@dfy-plugins/resource-core'], ['@other/plugin'], Array(10).fill(wallpaper)]) {
      await expect(service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames })).rejects.toThrow('请选择')
    }
    await expect(service.mutateDfyPlugins({ profile: 'web', action: 'remove', packageNames: [wallpaper] } as unknown as DfyPluginMutationRequest)).rejects.toThrow('操作无效')
    await expect(service.mutateDfyPlugins({ profile: 'web', action: 'update', packageNames: [wallpaper] })).rejects.toThrow('尚未安装')
    expect(runPnpm).not.toHaveBeenCalled()
  })

  it('rejects stale install selections and releases the operation lock after validation errors', async () => {
    const { service, runPnpm } = await fixture()
    await service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: [wallpaper] })
    await expect(service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: [wallpaper] })).rejects.toThrow('已经安装')
    await service.mutateDfyPlugins({ profile: 'web', action: 'update', packageNames: [wallpaper] })
    expect(runPnpm).toHaveBeenCalledTimes(2)
  })

  it('keeps catalog entries available when the registry partially fails', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === DFY_PLUGIN_CATALOG_URL) return Response.json({ version: 1, plugins: DFY_PLUGINS })
      const name = decodeURIComponent(new URL(String(input)).pathname.split('/')[1]!)
      if (name === wallpaper) return Response.json({ name, version: '0.1.3' })
      if (name === vision) throw new Error('offline')
      return Response.json({ name: 'wrong-package', version: 'invalid' })
    }) as unknown as typeof fetch
    const service = new PluginManagementService('/unused', { getWindow: () => undefined, runPnpm: vi.fn(), fetch: request })
    const catalog = await service.getDfyCatalog()
    expect(catalog.releases).toHaveLength(DFY_PLUGINS.length)
    expect(catalog.releases.find(({ name }) => name === wallpaper)?.version).toBe('0.1.3')
    expect(catalog.releases.find(({ name }) => name === vision)?.version).toBeUndefined()
    expect(catalog.error).toContain('8 个插件')
  })

  it('discovers and installs a newly listed plugin without a desktop allowlist change', async () => {
    const entry = { name: '@dfy-plugins/dsh-new-plugin', title: '新插件', category: '工具', description: '来自仓库的新条目。', repository: 'https://github.com/dfy/new-plugin' }
    const { service, runPnpm, request } = await fixture({}, [...DFY_PLUGINS, entry])
    const catalog = await service.getDfyCatalog()
    expect(catalog.plugins).toContainEqual(entry)
    expect(service.getDfyRepositoryUrl(entry.name)).toBe(entry.repository)
    expect(() => service.getDfyRepositoryUrl('https://untrusted.example')).toThrow('插件不在')
    expect(catalog.releases).toContainEqual({ name: entry.name, version: '0.1.3' })
    expect(request).toHaveBeenCalledWith(DFY_PLUGIN_CATALOG_URL, expect.any(Object))
    await service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: [entry.name] })
    expect(runPnpm).toHaveBeenCalledExactlyOnceWith('web', ['add', `${entry.name}@latest`, '--registry=https://registry.npmjs.org'])
    await expect(service.mutateDfyPlugins({ profile: 'web', action: 'install', packageNames: ['@dfy-plugins/not-listed'] })).rejects.toThrow('请选择')
  })

  it('shares concurrent directory and npm requests', async () => {
    const { service, request } = await fixture()
    const first = service.getDfyCatalog()
    expect(service.getDfyCatalog()).toBe(first)
    await first
    expect(request).toHaveBeenCalledTimes(DFY_PLUGINS.length + 1)
    await service.getDfyCatalog()
    expect(request).toHaveBeenCalledTimes((DFY_PLUGINS.length + 1) * 2)
  })

  it('retains the last valid directory when a refresh fails or contains invalid data', async () => {
    const { service, request } = await fixture({}, DFY_PLUGINS.slice(0, 1))
    await service.getDfyCatalog()
    request.mockRejectedValueOnce(new Error('offline'))
    const offline = await service.getDfyCatalog()
    expect(offline.plugins).toEqual(DFY_PLUGINS.slice(0, 1))
    expect(offline.error).toContain('上次读取')
    request.mockResolvedValueOnce(Response.json({ version: 1, plugins: [{ ...DFY_PLUGINS[0], name: 'https://untrusted/plugin.tgz' }] }))
    expect((await service.getDfyCatalog()).plugins).toEqual(offline.plugins)
  })

  it('uses the bundled directory when the first fetch fails', async () => {
    const { service, request } = await fixture()
    request.mockResolvedValueOnce(new Response('', { status: 404 }))
    const catalog = await service.getDfyCatalog()
    expect(catalog.plugins).toEqual(DFY_PLUGINS)
    expect(catalog.error).toContain('内置备用列表')
  })

  it('can preview a local directory file with the same parser', async () => {
    const { home, request, runPnpm } = await fixture()
    const path = join(home, 'catalog.json')
    await writeFile(path, JSON.stringify({ version: 1, plugins: DFY_PLUGINS.slice(0, 1) }))
    const service = new PluginManagementService(home, { getWindow: () => undefined, runPnpm, fetch: request as typeof fetch, catalogFile: path })
    expect((await service.getDfyCatalog()).plugins).toEqual(DFY_PLUGINS.slice(0, 1))
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported formats, duplicate names, arbitrary sources and malformed display fields', () => {
    for (const value of [null, { version: 2, plugins: [] }, { version: 1, plugins: [DFY_PLUGINS[0], DFY_PLUGINS[0]] },
      ...['--global', '@other/plugin', '@dfy-plugins/a@latest', 'file:/tmp/plugin'].map((name) => ({ version: 1, plugins: [{ ...DFY_PLUGINS[0], name }] })),
      { version: 1, plugins: [{ ...DFY_PLUGINS[0], title: '' }] }, { version: 1, plugins: [{ ...DFY_PLUGINS[0], description: 'a'.repeat(401) }] },
      ...['javascript:alert(1)', 'https://github.com.evil.example/owner/repo', 'https://user:pass@github.com/owner/repo'].map((repository) => ({ version: 1, plugins: [{ ...DFY_PLUGINS[0], repository }] })),
    ]) expect(() => parseDfyPluginCatalog(value)).toThrow()
  })

  it('recognizes registry versions and tags without treating aliases or URLs as registry ranges', () => {
    for (const source of ['^0.1.3', '~0.1.2', '*', 'latest', 'next', '>=0.1.2 <0.2']) expect(isDfyRegistrySource(source)).toBe(true)
    for (const source of ['', 'file:/tmp/a', 'link:/tmp/a', 'npm:other@latest', 'https://host/plugin.tgz']) expect(isDfyRegistrySource(source)).toBe(false)
  })
})
