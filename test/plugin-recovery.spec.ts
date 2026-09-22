import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parsePluginInitializationFailure,
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
})
