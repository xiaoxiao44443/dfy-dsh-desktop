import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readStartupThemePreference } from '../src/main/harness-theme.js'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture(profile?: string) {
  const home = await mkdtemp(join(tmpdir(), 'dfy-theme-'))
  homes.push(home)
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  if (profile !== undefined) await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), profile)
  return home
}

describe('startup theme before a Harness frame exists', () => {
  it.each(['light', 'dark', 'system'])('reads the official %s preference', async (preference) => {
    const home = await fixture(`- id: ui-theme\n  name: '@deepseek-ai/dsh-client-ui-theme'\n  config:\n    preference: ${preference}\n`)
    expect(await readStartupThemePreference(home)).toBe(preference)
  })

  it('honors home and command-line overrides in official order', async () => {
    const home = await fixture('- id: ui-theme\n  config: { preference: light }')
    await writeFile(join(home, 'cordis.patch.yml'), '- id: ui-theme\n  config: { preference: dark }')
    expect(await readStartupThemePreference(home)).toBe('dark')
    const patch = join(home, 'extra.json')
    await writeFile(patch, JSON.stringify([{ id: 'ui-theme', config: { preference: 'system' } }]))
    expect(await readStartupThemePreference(home, patch)).toBe('system')
  })

  it('ignores unrelated keys and does not evaluate executable tags', async () => {
    const home = await fixture('- id: other\n  config: { preference: dark }\n- id: ui-theme\n  config:\n    preference: light\n- id: script\n  config: !!js "throw new Error()"')
    expect(await readStartupThemePreference(home)).toBe('light')
  })

  it('replaces the complete theme config and skips a mismatching plugin name', async () => {
    const home = await fixture('- id: ui-theme\n  config: { preference: light }')
    const override = join(home, 'cordis.patch.yml')
    await writeFile(override, '- id: ui-theme\n  name: other\n  config: { preference: dark }')
    expect(await readStartupThemePreference(home)).toBe('light')
    await writeFile(override, '- id: ui-theme\n  config: { fontSize: 16 }')
    expect(await readStartupThemePreference(home)).toBe('system')
  })

  it('opens with system colors for missing, malformed or unknown preferences', async () => {
    for (const profile of [undefined, '- broken: [', '- id: ui-theme\n  config: { preference: invalid }']) {
      expect(await readStartupThemePreference(await fixture(profile))).toBe('system')
    }
  })
})
