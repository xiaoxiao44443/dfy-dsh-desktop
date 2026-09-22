import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describePluginEntries, type PluginDiagnosticContext } from './plugin-diagnostics.js'
import type { PluginInitializationFailure, PluginRecoveryEntry } from '../shared/contracts.js'

const PLUGIN_FAILURE_PATTERN = /failed to (?:import|apply|dispose|rollback) loader entry\s+([^\s(]+)\s+\(([^)\r\n]+)\):\s*([^\r\n]+)/giu
// DSH 0.1.7 reports inactive entries as one row followed by its stack trace.
const INACTIVE_ENTRY_PATTERN = /^([^\s(]+)\s+\(([^)\r\n]+)\):\s*([^\r\n]+)/gmu
const DESKTOP_BRIDGE_ENTRY_ID = 'desktop-bridge'
const DESKTOP_BRIDGE_PLUGIN_NAME = 'dsh-desktop-bridge'

interface RecoveryPatchEntry {
  id: string
  name: string
  disabled: true
}

export class PluginInitializationError extends Error {
  readonly failures: PluginInitializationFailure[]
  constructor(failures: PluginInitializationFailure[]) {
    super(failures.map((failure) => `Plugin ${failure.pluginName} failed to initialize: ${failure.detail}`).join('\n'))
    this.name = 'PluginInitializationError'
    this.failures = failures
  }
}

export function parsePluginInitializationFailure(output: string): PluginInitializationFailure | undefined {
  return parsePluginInitializationFailures(output).at(-1)
}

/** Keep individual causes; pending dependants are not themselves failed plugins. */
export function parsePluginInitializationFailures(output: string): PluginInitializationFailure[] {
  const text = output.replaceAll(/\u001b\[[0-9;]*m/gu, '').replaceAll('\r\n', '\n')
  const matches: Array<{ index: number; entryId: string; pluginName: string; detail: string }> = []
  const add = (match: RegExpExecArray, offset = 0): void => {
    const entryId = match[1]?.trim()
    const pluginName = match[2]?.trim()
    const detail = match[3]?.trim()
    if (!isSafeValue(entryId) || !isSafeValue(pluginName) || !detail || detail.startsWith('pending ')) return
    matches.push({ index: (match.index ?? 0) + offset, entryId, pluginName, detail: detail.slice(0, 4_000) })
  }
  for (const match of text.matchAll(PLUGIN_FAILURE_PATTERN)) add(match)
  // Only parse rows inside the startup warning; ordinary page text/tool output
  // using the same punctuation must not become a recovery action.
  for (const warning of text.matchAll(/^dsh: warning: \d+ (?:entry|entries) did not activate\n((?:(?:[^\n]+\([^\n]+\):[^\n]*|[ \t]+[^\n]*)\n?)*)/gmu)) {
    const rows = warning[1] ?? ''
    for (const match of rows.matchAll(INACTIVE_ENTRY_PATTERN)) {
      const continuation = /^(?:\n[ \t]+[^\n]*)*/u.exec(rows.slice(match.index + match[0].length))?.[0] ?? ''
      match[3] += continuation
      add(match, warning.index)
    }
  }
  // DSH 0.1.7 fatal diagnostics group causes separately from missing services.
  for (const group of text.matchAll(/^Failed plugins \(\d+\):\n((?:[ \t]+[^\n]*\n?|\n)*)/gmu)) {
    const rows = group[1] ?? ''
    for (const match of rows.matchAll(/^  ([^\s]+)(?: \(required\))?\n    Package: ([^\n]+)\n((?: {4}[^\n]*(?:\n|$))+)/gmu)) {
      match[3] = match[3]?.replaceAll(/^ {4}/gmu, '') ?? ''
      add(match, group.index)
    }
  }
  const failures = new Map<string, PluginInitializationFailure>()
  for (const { entryId, pluginName, detail } of matches.sort((a, b) => a.index - b.index)) {
    // A phase-only summary must not replace an earlier, more useful cause.
    if (/^failed to (?:import|apply|dispose|rollback)$/u.test(detail) && failures.has(`${entryId}\0${pluginName}`)) continue
    failures.set(`${entryId}\0${pluginName}`, { entryId, pluginName, detail, recoverable: canRecover(entryId, pluginName) })
  }
  return [...failures.values()]
}

function canRecover(entryId: string, pluginName: string): boolean {
  return entryId !== DESKTOP_BRIDGE_ENTRY_ID && pluginName !== DESKTOP_BRIDGE_PLUGIN_NAME && !pluginName.startsWith('@deepseek-ai/')
}

export class PluginRecoveryService {
  private recovered: PluginRecoveryEntry[] = []
  private diagnosticContext: PluginDiagnosticContext | undefined

  constructor(readonly patchPath: string) {}

  async initialize(): Promise<void> {
    try {
      this.recovered = normalizeRecoveryPatch(JSON.parse(await readFile(this.patchPath, 'utf8')))
    } catch {
      this.recovered = []
    }
    await this.writePatch()
  }

  get disabledPlugins(): PluginRecoveryEntry[] {
    return this.recovered.map((entry) => ({ ...entry }))
  }

  async setDiagnosticContext(context: PluginDiagnosticContext): Promise<void> {
    this.diagnosticContext = context
    this.recovered = await this.describe(this.recovered)
  }

  async describe<T extends PluginRecoveryEntry>(entries: T[]): Promise<T[]> {
    if (entries.length === 0 || this.diagnosticContext === undefined) return entries
    const descriptions = await describePluginEntries(this.diagnosticContext, entries)
    return entries.map((entry) => ({ ...entry, ...descriptions.find((description) => description.entryId === entry.entryId && description.pluginName === entry.pluginName) }))
  }

  async disable(failure: PluginInitializationFailure): Promise<void> {
    await this.disableMany([failure])
  }

  async disableMany(failures: PluginInitializationFailure[]): Promise<void> {
    if (failures.length === 0 || failures.some((failure) => !failure.recoverable || !isSafeValue(failure.entryId) || !isSafeValue(failure.pluginName) || !canRecover(failure.entryId, failure.pluginName))) {
      throw new Error('该插件不能通过桌面恢复层禁用。')
    }
    const next = new Map(this.recovered.map((entry) => [entry.entryId, entry]))
    for (const { detail: _detail, recoverable: _recoverable, ...entry } of failures) next.set(entry.entryId, entry)
    const entries = [...next.values()]
    await this.writePatch(entries)
    this.recovered = entries
  }

  async restore(entryId: string): Promise<void> {
    if (!isSafeValue(entryId)) throw new Error('插件恢复项无效。')
    const next = this.recovered.filter((entry) => entry.entryId !== entryId)
    if (next.length === this.recovered.length) throw new Error('没有找到对应的插件恢复项。')
    await this.writePatch(next)
    this.recovered = next
  }

  private async writePatch(entries = this.recovered): Promise<void> {
    const patches: RecoveryPatchEntry[] = entries.map((entry) => ({
      id: entry.entryId,
      name: entry.pluginName,
      disabled: true,
    }))
    await mkdir(dirname(this.patchPath), { recursive: true })
    const temporaryPath = `${this.patchPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(patches, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.patchPath)
  }
}

function normalizeRecoveryPatch(value: unknown): PluginRecoveryEntry[] {
  if (!Array.isArray(value)) return []
  const entries = new Map<string, PluginRecoveryEntry>()
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const patch = candidate as Record<string, unknown>
    if (patch.disabled !== true || !isSafeValue(patch.id) || !isSafeValue(patch.name)) continue
    if (patch.id === DESKTOP_BRIDGE_ENTRY_ID || patch.name === DESKTOP_BRIDGE_PLUGIN_NAME) continue
    entries.set(patch.id, { entryId: patch.id, pluginName: patch.name })
  }
  return [...entries.values()]
}

function isSafeValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 500
    && !/[\r\n\0]/u.test(value)
}
