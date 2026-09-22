import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyPluginSource, PluginManagementService } from '../src/main/plugin-management.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('PluginManagementService', () => {
  it('ignores dependency storage and directories without a Profile manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-profiles-'))
    roots.push(root)
    const harnessHome = join(root, 'home')
    const profilesRoot = join(harnessHome, 'profiles')
    await mkdir(join(profilesRoot, 'web'), { recursive: true })
    await mkdir(join(profilesRoot, 'node_modules'), { recursive: true })
    await mkdir(join(profilesRoot, 'cache'), { recursive: true })
    await writeFile(join(profilesRoot, 'web', 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: [] } },
    }))
    await writeFile(join(profilesRoot, 'node_modules', 'package.json'), JSON.stringify({
      name: 'dependency-storage',
    }))

    const service = new PluginManagementService(harnessHome, {
      getWindow: () => undefined,
      runPnpm: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })

    expect((await service.getInventory()).profiles.map((profile) => profile.name)).toEqual(['web'])
  })

  it('separates built-in, local, registry, and inactive dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-management-'))
    roots.push(root)
    const harnessHome = join(root, 'home')
    const profileDir = join(harnessHome, 'profiles', 'web')
    const localPlugin = join(root, 'plugins', 'local-plugin')
    const npmPlugin = join(profileDir, 'node_modules', '@sample', 'npm-plugin')
    await mkdir(profileDir, { recursive: true })
    await mkdir(localPlugin, { recursive: true })
    await mkdir(npmPlugin, { recursive: true })
    await writeFile(join(localPlugin, 'package.json'), JSON.stringify({
      name: '@sample/local-plugin',
      version: '1.2.3',
      description: 'Local plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(npmPlugin, 'package.json'), JSON.stringify({
      name: '@sample/npm-plugin',
      version: '4.5.6',
      description: 'Registry plugin',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@sample/local-plugin', '@sample/npm-plugin'] } },
      dependencies: {
        '@sample/local-plugin': `link:${localPlugin}`,
        '@sample/npm-plugin': '^4.0.0',
        '@sample/missing-library': '^1.0.0',
      },
    }))

    const service = new PluginManagementService(harnessHome, {
      getWindow: () => undefined,
      runPnpm: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    const inventory = await service.getInventory()
    const plugins = inventory.profiles[0]?.plugins ?? []

    expect(inventory.profiles.map((profile) => profile.name)).toEqual(['web'])
    expect(plugins).toMatchObject([
      { name: '@deepseek-ai/dsh-base', sourceType: 'builtin', active: true, removable: false, status: 'ready' },
      { name: '@sample/local-plugin', sourceType: 'local', version: '1.2.3', active: true, toggleable: true, status: 'ready' },
      { name: '@sample/npm-plugin', sourceType: 'npm', version: '4.5.6', active: true, toggleable: true, status: 'ready' },
      { name: '@sample/missing-library', sourceType: 'npm', active: false, toggleable: false, status: 'missing' },
    ])
  })

  it('forwards safe install, update, and remove operations to the bundled pnpm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-commands-'))
    roots.push(root)
    const harnessHome = join(root, 'home')
    const profileDir = join(harnessHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: [] } },
      dependencies: { '@sample/plugin': 'github:sample/plugin' },
    }))
    const calls: Array<{ profile: string; args: string[] }> = []
    const service = new PluginManagementService(harnessHome, {
      getWindow: () => undefined,
      runPnpm: async (profile, args) => {
        calls.push({ profile, args })
        return { exitCode: 0, stdout: 'done', stderr: '' }
      },
    })

    const installed = await service.install({ profile: 'web', source: '/tmp/My Plugin' })
    const updated = await service.update({ profile: 'web', packageName: '@sample/plugin' })
    const removed = await service.remove({ profile: 'web', packageName: '@sample/plugin' })

    expect(calls).toEqual([
      { profile: 'web', args: ['add', '/tmp/My Plugin'] },
      { profile: 'web', args: ['update', '@sample/plugin'] },
      { profile: 'web', args: ['remove', '@sample/plugin'] },
    ])
    expect(installed.command).toBe('pnpm add "/tmp/My Plugin" (Profile web)')
    expect(updated.command).toBe('pnpm update @sample/plugin (Profile web)')
    expect(removed.output).toBe('done')
  })

  it('rejects online updates for local links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-local-update-'))
    roots.push(root)
    const harnessHome = join(root, 'home')
    const profileDir = join(harnessHome, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: [] } },
      dependencies: { '@sample/local': 'link:../../../plugins/local' },
    }))
    const service = new PluginManagementService(harnessHome, {
      getWindow: () => undefined,
      runPnpm: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })

    await expect(service.update({ profile: 'web', packageName: '@sample/local' }))
      .rejects.toThrow('本地 Link')
  })

  it('reconciles bundle configuration after pnpm changes dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-reconcile-'))
    roots.push(root)
    const harnessHome = join(root, 'home')
    const profileDir = join(harnessHome, 'profiles', 'web')
    const manifestPath = join(profileDir, 'package.json')
    const packageName = '@sample/plugin'
    const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: packageName,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(manifestPath, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: {},
    }))

    const service = new PluginManagementService(harnessHome, {
      getWindow: () => undefined,
      runPnpm: async (_profile, args) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          dependencies: Record<string, string>
          dsh: { profile: { bundles: string[] } }
        }
        if (args[0] === 'add') manifest.dependencies[packageName] = '^1.0.0'
        if (args[0] === 'remove') delete manifest.dependencies[packageName]
        await writeFile(manifestPath, JSON.stringify(manifest))
        return { exitCode: 0, stdout: 'done', stderr: '' }
      },
    })

    await service.install({ profile: 'web', source: packageName })
    let manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] }; desktop?: { bundleOrder: string[]; disabledBundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', packageName])

    await service.setActive({ profile: 'web', packageName, active: false })
    await service.remove({ profile: 'web', packageName })
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(manifest.dsh.desktop).toBeUndefined()
  })

  it('shares official bundle choices, preserves disabled plugins during updates and appends on re-enable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-activation-'))
    roots.push(root)
    const harnessHome = join(root, 'home')
    const profileDir = join(harnessHome, 'profiles', 'web')
    const pluginNames = ['@sample/first', '@sample/second', '@sample/third']
    await mkdir(profileDir, { recursive: true })
    for (const packageName of pluginNames) {
      const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({
        name: packageName,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
    }
    const manifestPath = join(profileDir, 'package.json')
    await writeFile(manifestPath, JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...pluginNames] } },
      dependencies: Object.fromEntries(pluginNames.map((name) => [name, '^1.0.0'])),
    }))

    const service = new PluginManagementService(harnessHome, {
      getWindow: () => undefined,
      runPnpm: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    const bundles = async (): Promise<string[]> => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
      }
      return manifest.dsh.profile.bundles
    }

    await service.setActive({ profile: 'web', packageName: '@sample/second', active: false })
    await service.setActive({ profile: 'web', packageName: '@sample/third', active: false })
    expect(await bundles()).toEqual(['@deepseek-ai/dsh-base', '@sample/first'])

    await service.update({ profile: 'web', packageName: '@sample/second' })
    expect(await bundles()).toEqual(['@deepseek-ai/dsh-base', '@sample/first'])

    await service.setActive({ profile: 'web', packageName: '@sample/third', active: true })
    await service.setActive({ profile: 'web', packageName: '@sample/second', active: true })
    expect(await bundles()).toEqual(['@deepseek-ai/dsh-base', '@sample/first', '@sample/third', '@sample/second'])
    expect((await service.getInventory()).profiles[0]?.plugins.filter((plugin) => plugin.sourceType !== 'builtin'))
      .toMatchObject(['@sample/first', '@sample/third', '@sample/second'].map((name) => ({ name, active: true, toggleable: true })))

    // A switch made by the official UI remains authoritative on the next read.
    const official = JSON.parse(await readFile(manifestPath, 'utf8'))
    official.dsh.profile.bundles = official.dsh.profile.bundles.filter((name: string) => name !== '@sample/first')
    await writeFile(manifestPath, JSON.stringify(official))
    expect((await service.getInventory()).profiles[0]?.plugins.find(plugin => plugin.name === '@sample/first')?.active).toBe(false)
    expect(official.dsh.desktop).toBeUndefined()
  })

  it('does not enable an installed dependency without a DSH bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-library-'))
    roots.push(root)
    const harnessHome = join(root, 'home')
    const profileDir = join(harnessHome, 'profiles', 'web')
    const packageDir = join(profileDir, 'node_modules', '@sample', 'library')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@sample/library' }))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: [] } },
      dependencies: { '@sample/library': '^1.0.0' },
    }))
    const service = new PluginManagementService(harnessHome, {
      getWindow: () => undefined,
      runPnpm: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })

    await expect(service.setActive({ profile: 'web', packageName: '@sample/library', active: true }))
      .rejects.toThrow('没有声明 DSH bundle')
  })

  it('delegates live switches and reports the official outcome without a fallback write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-live-switch-'))
    roots.push(root)
    const profile = join(root, 'profiles/web')
    await mkdir(profile, { recursive: true })
    const path = join(profile, 'package.json')
    const initial = JSON.stringify({ dependencies: { broken: '1.0.0' }, dsh: { profile: { bundles: ['base', 'broken'] } } })
    await writeFile(path, initial)
    const setBundleEnabled = vi.fn(async () => ({
      changed: true, target: 'broken', application: 'applied' as const,
    }))
    const service = new PluginManagementService(root, { getWindow: () => undefined,
      runPnpm: vi.fn(), setBundleEnabled,
    })
    const request = { profile: 'web', packageName: 'broken', active: false }
    const result = await service.setActive(request)
    expect(setBundleEnabled).toHaveBeenCalledExactlyOnceWith(request)
    expect(result).toMatchObject({ exitCode: 0, restartRequired: false, output: expect.stringContaining('官方') })
    expect(await readFile(path, 'utf8')).toBe(initial)
    setBundleEnabled.mockRejectedValueOnce(new Error('manager disconnected'))
    await expect(service.setActive(request)).rejects.toThrow('manager disconnected')
    expect(await readFile(path, 'utf8')).toBe(initial)
  })

  it.each(['failed', 'restart-required', 'overridden'] as const)('surfaces %s without reporting immediate activation', async (application) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-switch-outcome-'))
    roots.push(root)
    const profile = join(root, 'profiles/web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { demo: '1' }, dsh: { profile: { bundles: ['demo'] } } }))
    const service = new PluginManagementService(root, { getWindow: () => undefined, runPnpm: vi.fn(),
      setBundleEnabled: async () => ({ changed: true, target: 'demo', application,
        ...(application === 'failed' ? { error: { code: 'operation-error', diagnostic: 'activation failed' } } : {}),
      }),
    })
    const result = await service.setActive({ profile: 'web', packageName: 'demo', active: false })
    expect(result.restartRequired).toBe(application === 'restart-required')
    expect(result.exitCode).toBe(application === 'failed' ? 1 : 0)
    expect(result.output).toContain(application === 'failed' ? 'activation failed' : application === 'overridden' ? '覆盖' : '重启')
  })
})

describe('classifyPluginSource', () => {
  it('recognizes the supported source families', () => {
    expect(classifyPluginSource(undefined)).toBe('builtin')
    expect(classifyPluginSource('link:../plugin')).toBe('local')
    expect(classifyPluginSource('workspace:*')).toBe('workspace')
    expect(classifyPluginSource('github:owner/repo')).toBe('git')
    expect(classifyPluginSource('git@github.com:owner/repo.git')).toBe('git')
    expect(classifyPluginSource('https://github.com/owner/repo.git')).toBe('git')
    expect(classifyPluginSource('@scope/plugin@^1.0.0')).toBe('npm')
  })
})
