import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { PluginRecoveryEntry } from '../shared/contracts.js'

export interface PluginDiagnosticContext {
  executable: string
  harnessEntry: string
  profilePath: string
}

/** Read metadata with the selected Harness version, even when its server cannot boot. */
export async function describePluginEntries(context: PluginDiagnosticContext, entries: PluginRecoveryEntry[]): Promise<PluginRecoveryEntry[]> {
  if (entries.length === 0) return []
  return await new Promise((resolve) => {
    const child = spawn(context.executable, [
      '--expose-internals', fileURLToPath(new URL('../harness-plugin-diagnostics.cjs', import.meta.url)),
      context.harnessEntry, context.profilePath,
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve([]) }, 5_000)
    const finish = (value: PluginRecoveryEntry[]): void => { clearTimeout(timer); resolve(value) }
    child.on('error', () => finish([]))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 1_000_000) { child.kill(); finish([]) }
    })
    child.on('close', (code) => {
      if (code !== 0) return finish([])
      try {
        const data: unknown = JSON.parse(output)
        finish(Array.isArray(data) ? data.filter((entry): entry is PluginRecoveryEntry =>
          entry !== null && typeof entry === 'object' && typeof entry.entryId === 'string' && typeof entry.pluginName === 'string'
          && ['displayName', 'bundleName', 'bundleTitle'].every((key) => entry[key] === undefined || typeof entry[key] === 'string')) : [])
      } catch { finish([]) }
    })
    child.stdin.end(JSON.stringify(entries.map(({ entryId, pluginName }) => ({ entryId, pluginName }))))
  })
}
