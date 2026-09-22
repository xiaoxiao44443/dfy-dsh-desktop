import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const VISION = '@dfy-plugins/dsh-vision'
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string') : []
const pending = new Map<string, Promise<void>>()

/** Move legacy desktop switches to the official bundle selection and retire vision. */
export async function upgradeDfyProfile(profilePath: string): Promise<void> {
  await migrate(profilePath, true)
}

/** Only discard the retired desktop bookkeeping; ordinary reads never disable new choices. */
export async function migrateLegacyPluginState(profilePath: string): Promise<void> {
  await migrate(profilePath, false)
}

async function migrate(profilePath: string, retireVision: boolean): Promise<void> {
  const previous = pending.get(profilePath) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(() => rewrite(profilePath, retireVision))
  pending.set(profilePath, task)
  try { await task } finally { if (pending.get(profilePath) === task) pending.delete(profilePath) }
}

async function rewrite(profilePath: string, retireVision: boolean): Promise<void> {
  const path = join(profilePath, 'package.json')
  let source: string
  try { source = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const manifest = JSON.parse(source)
  const bundles = strings(manifest.dsh?.profile?.bundles)
  const desktop = manifest.dsh?.desktop ?? {}
  const legacy = Object.hasOwn(desktop, 'disabledBundles') || Object.hasOwn(desktop, 'bundleOrder')
  if (!legacy && !(retireVision && bundles.includes(VISION))) return
  const disabled = new Set([...strings(desktop.disabledBundles), ...(retireVision ? [VISION] : [])])
  const { disabledBundles: _disabled, bundleOrder: _order, ...remainingDesktop } = desktop
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: bundles.filter(name => !disabled.has(name)) },
  }
  if (Object.keys(remainingDesktop).length > 0) manifest.dsh.desktop = remainingDesktop
  else delete manifest.dsh.desktop
  const temporary = `${path}.${process.pid}.upgrade.tmp`
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}
