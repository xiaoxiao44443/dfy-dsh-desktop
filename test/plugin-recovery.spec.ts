import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parsePluginInitializationFailure,
  parsePluginInitializationFailures,
  PluginRecoveryService,
} from '../src/main/plugin-recovery.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

describe('plugin initialization recovery', () => {
  it('extracts the failed loader entry from startup and client error output', () => {
    expect(parsePluginInitializationFailure(`Failed to load plugins\n\nfailed to apply loader entry 4948cd7e (dsh-archive-manager):\ncannot get property "slots" without inject`)).toEqual({
      entryId: '4948cd7e',
      pluginName: 'dsh-archive-manager',
      detail: 'cannot get property "slots" without inject',
      recoverable: true,
    })
  })

  it('does not offer to disable the desktop bridge that owns recovery', () => {
    expect(parsePluginInitializationFailure('failed to apply loader entry desktop-bridge (dsh-desktop-bridge): bridge failed')).toMatchObject({
      recoverable: false,
    })
  })

  it('recognizes current startup failures and ignores dependent pending entries', () => {
    expect(parsePluginInitializationFailure('dsh: warning: 2 entries did not activate\nwallpaper (@dfy-plugins/dsh-wallpaper): TypeError: invalid config\nclient (dsh-client): pending (waiting for service: wallpaper)')).toMatchObject({
      entryId: 'wallpaper', pluginName: '@dfy-plugins/dsh-wallpaper', detail: 'TypeError: invalid config', recoverable: true,
    })
    expect(parsePluginInitializationFailure('dsh: warning: 1 entry did not activate\nworkspace (@deepseek-ai/dsh-workspace): Error: damaged history')).toMatchObject({ recoverable: false })
    expect(parsePluginInitializationFailure('wallpaper (@dfy-plugins/dsh-wallpaper): Error: ordinary tool output')).toBeUndefined()
  })

  it('writes disabled entries as a final patch and restores them later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-plugin-recovery-'))
    temporaryPaths.push(root)
    const patchPath = join(root, 'plugin-recovery.patch.json')
    await writeFile(patchPath, JSON.stringify([{ id: 'old-entry', name: 'old-plugin', disabled: true }]), 'utf8')
    const service = new PluginRecoveryService(patchPath)
    await service.initialize()

    await service.disable({
      entryId: 'broken-entry',
      pluginName: 'broken-plugin',
      detail: 'apply failed',
      recoverable: true,
    })
    expect(service.disabledPlugins).toEqual([
      { entryId: 'old-entry', pluginName: 'old-plugin' },
      { entryId: 'broken-entry', pluginName: 'broken-plugin' },
    ])
    expect(JSON.parse(await readFile(patchPath, 'utf8'))).toEqual([
      { id: 'old-entry', name: 'old-plugin', disabled: true },
      { id: 'broken-entry', name: 'broken-plugin', disabled: true },
    ])

    await service.restore('broken-entry')
    expect(service.disabledPlugins).toEqual([{ entryId: 'old-entry', pluginName: 'old-plugin' }])
  })

  it('collects all grouped fatal causes, preserving stacks and excluding waiting services', () => {
    const failures = parsePluginInitializationFailures(`dsh: startup failed: 1 required plugin did not activate

Failed plugins (2):
  wallpaper
    Package: @dfy-plugins/dsh-wallpaper
    TypeError: invalid configuration
        at apply (plugin.js:10:2)
  webserver (required)
    Package: @deepseek-ai/dsh-host-webserver
    Error: port occupied

Plugins waiting for services (1):
  Plugin                  Missing services
  connection (required)   webServer
`)
    expect(failures).toEqual([
      { entryId: 'wallpaper', pluginName: '@dfy-plugins/dsh-wallpaper', detail: 'TypeError: invalid configuration\n    at apply (plugin.js:10:2)', recoverable: true },
      { entryId: 'webserver', pluginName: '@deepseek-ai/dsh-host-webserver', detail: 'Error: port occupied', recoverable: false },
    ])
  })

  it('recognizes optional import failures and deduplicates repeated loader diagnostics', () => {
    expect(parsePluginInitializationFailures(`failed to import loader entry missing (missing-package): not found
dsh: warning: 3 entries did not activate
missing (missing-package): failed to import
broken (broken-package): Error: deliberate failure
    at example.js:1:2
client (client-package): pending (waiting for service: broken)
`)).toEqual([
      { entryId: 'missing', pluginName: 'missing-package', detail: 'not found', recoverable: true },
      { entryId: 'broken', pluginName: 'broken-package', detail: 'Error: deliberate failure\n    at example.js:1:2', recoverable: true },
    ])
  })

  it('validates a batch before writing, disables only selected components, and retains recovery labels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-plugin-recovery-'))
    temporaryPaths.push(root)
    const patchPath = join(root, 'recovery.json')
    const service = new PluginRecoveryService(patchPath)
    await service.initialize()
    const broken = { entryId: 'first', pluginName: '@example/first', detail: 'broken', recoverable: true, displayName: '插件一', bundleName: '@example/bundle', bundleTitle: '示例组合包' }
    const protectedEntry = { entryId: 'webserver', pluginName: '@deepseek-ai/dsh-host-webserver', detail: 'broken', recoverable: true }
    await expect(service.disableMany([broken, protectedEntry])).rejects.toThrow('不能')
    expect(JSON.parse(await readFile(patchPath, 'utf8'))).toEqual([])
    expect(service.disabledPlugins).toEqual([])
    await service.disableMany([broken, { entryId: 'second', pluginName: '@example/second', detail: 'broken', recoverable: true }])
    expect(JSON.parse(await readFile(patchPath, 'utf8'))).toEqual([
      { id: 'first', name: '@example/first', disabled: true },
      { id: 'second', name: '@example/second', disabled: true },
    ])
    expect(service.disabledPlugins[0]).toMatchObject({ displayName: '插件一', bundleTitle: '示例组合包' })
    await service.restore('first')
    expect(service.disabledPlugins.map((entry) => entry.entryId)).toEqual(['second'])
  })
})
