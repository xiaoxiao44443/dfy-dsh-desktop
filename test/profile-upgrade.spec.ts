import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { migrateLegacyPluginState, upgradeDfyProfile } from '../src/main/profile-upgrade.js'

it('disables retired vision while retaining packages, ordering, unrelated settings and repeatability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfy-profile-upgrade-'))
  const path = join(root, 'package.json')
  const vision = '@dfy-plugins/dsh-vision'
  try {
    await upgradeDfyProfile(root)
    const manifest = { private: true, dependencies: { [vision]: 'link:/local/vision' }, dsh: {
      profile: { bundles: ['base', vision, 'appearance'], patchReload: 'live' },
      desktop: { bundleOrder: ['base', vision, 'appearance'], disabledBundles: ['wallpaper'] },
    } }
    await writeFile(path, JSON.stringify(manifest))
    await upgradeDfyProfile(root)
    const after = await readFile(path, 'utf8')
    expect(JSON.parse(after)).toEqual({ ...manifest, dsh: {
      profile: { ...manifest.dsh.profile, bundles: ['base', 'appearance'] },
    } })
    await upgradeDfyProfile(root)
    expect(await readFile(path, 'utf8')).toBe(after)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('migrates legacy disabled bundles once, retaining other desktop keys and later official choices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfy-plugin-migration-'))
  const path = join(root, 'package.json')
  try {
    const manifest = { dependencies: { first: '1', second: '2' }, dsh: {
      profile: { bundles: ['base', 'first', 'second'], patchReload: 'live' },
      desktop: { bundleOrder: ['base', 'second', 'first'], disabledBundles: ['second', 'removed'], extra: 'kept' },
    } }
    await writeFile(path, JSON.stringify(manifest))
    await Promise.all([migrateLegacyPluginState(root), migrateLegacyPluginState(root)])
    const migrated = JSON.parse(await readFile(path, 'utf8'))
    expect(migrated).toEqual({ ...manifest, dsh: {
      profile: { ...manifest.dsh.profile, bundles: ['base', 'first'] }, desktop: { extra: 'kept' },
    } })
    migrated.dsh.profile.bundles.push('second')
    await writeFile(path, JSON.stringify(migrated))
    await migrateLegacyPluginState(root)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(migrated)
  } finally { await rm(root, { recursive: true, force: true }) }
})
