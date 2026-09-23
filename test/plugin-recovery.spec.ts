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

  it('reports rc.1 admission refusals for a component and a whole bundle without offering recovery patches', () => {
    const warning = 'Plugin @sample/component@1.2.0 is incompatible with dsh 0.1.7-rc.1: peerDependencies {"@deepseek-ai/dsh":"<0.1.7"}. Update the plugin.'
    const failures = parsePluginInitializationFailures(`dsh: disabling profile plugin row "component": ${warning}\n`
      + `dsh: skipping profile bundle "@sample/bundle": Error: ${warning.replace('@sample/component', '@sample/bundle')}\n`
      + `dsh: disabling profile plugin row "component": ${warning}\n`)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({ entryId: 'component', pluginName: '@sample/component', recoverable: false, blockedByCompatibility: true,
      incompatibility: { name: '@sample/component', version: '1.2.0', runtimeVersion: '0.1.7-rc.1', peers: { '@deepseek-ai/dsh': '<0.1.7' } } })
    expect(failures[0]?.detail).toContain('与当前 DSH 0.1.7-rc.1 不兼容')
    expect(failures[1]).toMatchObject({ scope: 'bundle', bundleName: '@sample/bundle', pluginName: '@sample/bundle', recoverable: false })
  })

  it('handles id-less rows and metadata validation failures, ignoring unrelated output', () => {
    const warning = 'Plugin @sample/component@1.0.0 is incompatible with dsh 0.1.7-rc.1: peerDependencies {"@deepseek-ai/dsh":">=9"}.'
    const failures = parsePluginInitializationFailures(`dsh: disabling profile plugin file:///E:/plugin/index.js: ${warning}\n`
      + 'dsh: disabling profile plugin row "broken": its declared peer dependencies cannot be validated: malformed manifest\n'
      + `ordinary output: ${warning}\n`
      + 'dsh: skipping profile bundle "unreadable": Error: no bundle declaration\n')
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({ entryId: 'file:///E:/plugin/index.js', pluginName: '@sample/component', blockedByCompatibility: true })
    expect(failures[1]).toMatchObject({ entryId: 'broken', recoverable: false, blockedByCompatibility: true })
    expect(failures[1]?.detail).toContain('malformed manifest')
  })

  it('never writes a compatibility refusal as a recovery override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-compatibility-recovery-'))
    temporaryPaths.push(root)
    const patch = join(root, 'recovery.json')
    const service = new PluginRecoveryService(patch)
    await service.initialize()
    await expect(service.disableMany([{ entryId: 'bundle', pluginName: 'bundle', recoverable: true,
      blockedByCompatibility: true, detail: 'incompatible' }])).rejects.toThrow('不能')
    expect(JSON.parse(await readFile(patch, 'utf8'))).toEqual([])
  })
})
