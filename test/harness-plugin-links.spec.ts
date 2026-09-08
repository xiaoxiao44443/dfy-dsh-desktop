import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopPluginLinkError, ensureDesktopPluginLinks } from '../src/main/harness-plugin-links.js'

const temporaryRoots: string[] = []
const packageNames = ['dsh-desktop-bridge', 'dsh-desktop-browser'] as const
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-plugin-links-'))
  temporaryRoots.push(root)
  const resources = join(root, 'Desktop App', 'resources')
  for (const name of packageNames) {
    await mkdir(join(resources, name, 'lib'), { recursive: true })
    await writeFile(join(resources, name, 'package.json'), JSON.stringify({
      name, version: '0.1.0', type: 'module',
      exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' },
    }))
    await writeFile(join(resources, name, 'lib', 'index.js'), 'export const name = "desktop fixture"\n')
    await writeFile(join(resources, name, 'lib', 'client.js'), 'export const client = true\n')
  }
  const paths = {
    profilePath: join(root, 'DSH Home', 'profiles', 'web'),
    pluginRootPath: join(resources, packageNames[0]),
    browserPluginRootPath: join(resources, packageNames[1]),
  }
  return { root, paths, link: (name: typeof packageNames[number] = packageNames[0]) => join(paths.profilePath, 'node_modules', name) }
}

describe('desktop plugin package links', () => {
  it('makes both package manifests and client entries resolvable without editing Profile dependencies', async () => {
    const { paths } = await fixture()
    await mkdir(paths.profilePath, { recursive: true })
    const manifestPath = join(paths.profilePath, 'package.json')
    const manifest = '{"name":"dsh-profile-web","private":true}\n'
    await writeFile(manifestPath, manifest)
    await ensureDesktopPluginLinks(paths)

    const requireFromProfile = createRequire(manifestPath)
    for (const name of packageNames) {
      expect(JSON.parse(await readFile(requireFromProfile.resolve(`${name}/package.json`), 'utf8')).name).toBe(name)
      expect(requireFromProfile.resolve(`${name}/client`)).toBe(await realpath(join(paths.profilePath, 'node_modules', name, 'lib', 'client.js')))
    }
    expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
  })

  it('keeps healthy links unchanged and serializes overlapping repairs', async () => {
    const { paths, link } = await fixture()
    await Promise.all([ensureDesktopPluginLinks(paths), ensureDesktopPluginLinks(paths)])
    const before = await lstat(link())
    await ensureDesktopPluginLinks(paths)
    expect((await lstat(link())).ino).toBe(before.ino)
    expect(await realpath(link())).toBe(await realpath(paths.pluginRootPath))
  })

  it('repairs removed and dangling links left by dependency changes', async () => {
    const { root, paths, link } = await fixture()
    await ensureDesktopPluginLinks(paths)
    await unlink(link())
    await unlink(link(packageNames[1]))
    const oldRoot = join(root, 'removed-installation')
    await mkdir(oldRoot)
    await symlink(oldRoot, link(packageNames[1]), linkType)
    await rm(oldRoot, { recursive: true })

    await ensureDesktopPluginLinks(paths)
    expect(await realpath(link())).toBe(await realpath(paths.pluginRootPath))
    expect(await realpath(link(packageNames[1]))).toBe(await realpath(paths.browserPluginRootPath))
  })

  it('retargets links when the desktop app moves without deleting the previous package', async () => {
    const oldInstall = await fixture()
    const newInstall = await fixture()
    await ensureDesktopPluginLinks(oldInstall.paths)
    await ensureDesktopPluginLinks({ ...newInstall.paths, profilePath: oldInstall.paths.profilePath })
    expect(await realpath(oldInstall.link())).toBe(await realpath(newInstall.paths.pluginRootPath))
    expect(JSON.parse(await readFile(join(oldInstall.paths.pluginRootPath, 'package.json'), 'utf8')).name).toBe(packageNames[0])
  })

  it.each(['directory', 'file'])('preserves a conflicting user %s and makes no partial repair', async (kind) => {
    const { paths, link } = await fixture()
    await mkdir(join(paths.profilePath, 'node_modules'), { recursive: true })
    const conflict = link(packageNames[1])
    const userFile = kind === 'file' ? conflict : join(conflict, 'user.txt')
    if (kind === 'directory') await mkdir(conflict)
    await writeFile(userFile, 'keep my data')

    await expect(ensureDesktopPluginLinks(paths)).rejects.toBeInstanceOf(DesktopPluginLinkError)
    await expect(ensureDesktopPluginLinks(paths)).rejects.toThrow('未覆盖')
    expect(await readFile(userFile, 'utf8')).toBe('keep my data')
    await expect(lstat(link())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects incomplete bundled packages before modifying existing links', async () => {
    const { paths, link } = await fixture()
    await ensureDesktopPluginLinks(paths)
    const before = await lstat(link())
    await writeFile(join(paths.browserPluginRootPath, 'package.json'), '{"name":"dsh-desktop-browser"}')
    await expect(ensureDesktopPluginLinks(paths)).rejects.toThrow('缺少有效的包名或版本')
    expect((await lstat(link())).ino).toBe(before.ino)
  })

  it('repairs the real DSH plugin inventory failure before any model request is sent', async () => {
    const { paths } = await fixture()
    const dshRequire = createRequire(await realpath(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url)))
    const baseRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-base'))
    const { apply } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-plugin-package-inventory-deepseek')).href)
    const baseUrl = pathToFileURL(join(paths.profilePath, 'package.json')).href
    const tree = { ctx: { baseUrl } }
    let provider: { prepare(request: unknown): Promise<{ value: { packages: Array<{ name: string; version: string }> } }> } | undefined
    apply({
      baseUrl,
      get: () => undefined,
      agents: { get: () => undefined },
      loader: { entries: () => packageNames.map((name) => ({ options: { name }, parent: { tree }, fiber: { state: 2 } })) },
      deepseekLlmApiExtensions: { register: (_field: string, value: typeof provider) => { provider = value } },
    }, { enabled: true })
    if (provider === undefined) throw new Error('Inventory provider was not registered')
    const request = { body: {}, signal: new AbortController().signal }
    await expect(provider.prepare(request)).rejects.toThrow('cannot resolve active package "dsh-desktop-bridge"')
    await ensureDesktopPluginLinks(paths)
    expect((await provider.prepare(request)).value.packages).toEqual(packageNames.map((name) => ({ name, version: '0.1.0' })))
  })
})
