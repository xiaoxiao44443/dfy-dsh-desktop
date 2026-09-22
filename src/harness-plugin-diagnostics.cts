// A short-lived read-only helper: no boot(), plugin imports, or config writes.
import './harness-node-internals.cjs'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginRecoveryEntry } from './shared/contracts.js'

interface Row { id?: string; name?: string; group?: boolean; config?: Row[] }
interface Layer { packageName: string; packageDir: string; patches: Array<{ insert?: Row[] }> }
interface BootMetadataApi {
  loadProfileDirectory(bin: string, dir: string, anchor: string, options: { userLayer: boolean }): { layers: Layer[] }
  composeEntries(layers: Array<Layer['patches']>): Row[]
  readPluginMeta(name: string, parent: string): { title?: string | Record<string, string> } | undefined
}

function flatten(rows: Row[]): Row[] {
  return rows.flatMap((row) => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
}

async function describe(): Promise<PluginRecoveryEntry[]> {
  const entry = process.argv[2]
  const profilePath = process.argv[3]
  if (entry === undefined || profilePath === undefined) return []
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const entries = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PluginRecoveryEntry[]
  const require = createRequire(realpathSync(entry))
  const api = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as BootMetadataApi
  const layers = api.loadProfileDirectory('dsh', profilePath, entry, { userLayer: false }).layers
  // Match the manager's declaredRows semantics, including groups and multiple
  // patch files. Never infer ownership from a package namespace or dependency.
  const declarations = layers.map((layer) => ({
    ...layer, rows: flatten(api.composeEntries([layer.patches.filter((patch) => patch.insert !== undefined)])),
  }))
  const title = (name: string, anchors: string[]): string | undefined => {
    for (const anchor of anchors) {
      try {
        const text = api.readPluginMeta(name, pathToFileURL(anchor).href)?.title
        const value = typeof text === 'string' ? text : text?.zh ?? text?.['zh-CN'] ?? text?.en
        if (value && value !== name) return value
      } catch { /* Unreadable metadata must not hide the original error. */ }
    }
    return undefined
  }
  return entries.map(({ entryId, pluginName }) => {
    const owners = declarations.filter((layer) => layer.rows.some((row) => row.id === entryId && row.name === pluginName))
    const anchors = [join(profilePath, 'package.json'), ...owners.map((layer) => join(layer.packageDir, 'package.json')), entry]
    const displayName = title(pluginName, anchors)
    const owner = owners.length === 1 ? owners[0] : undefined
    const bundleName = owner !== undefined && owner.packageName !== pluginName ? owner.packageName : undefined
    const bundleTitle = bundleName === undefined || owner === undefined ? undefined : title(bundleName, [join(owner.packageDir, 'package.json')])
    return { entryId, pluginName, ...(displayName ? { displayName } : {}), ...(bundleName ? { bundleName } : {}), ...(bundleTitle ? { bundleTitle } : {}) }
  })
}

void describe().then((result) => { process.stdout.write(JSON.stringify(result)) }).catch((error: unknown) => {
  console.error('[desktop] Plugin metadata unavailable:', error instanceof Error ? error.message : String(error))
  process.stdout.write('[]')
})
