import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PluginInitializationFailure, PluginRecoveryEntry } from '../shared/contracts.js'

const PLUGIN_FAILURE_PATTERN = /failed to (?:import|apply|dispose|rollback) loader entry\s+([^\s(]+)\s+\(([^)\r\n]+)\):\s*([^\r\n]+)/giu
// DSH 0.1.7 reports inactive entries as one row followed by its stack trace.
const INACTIVE_ENTRY_PATTERN = /^([^\s(]+)\s+\(([^)\r\n]+)\):\s*((?:[A-Za-z]*Error|AggregateError):[^\r\n]+)/gmu
const DESKTOP_BRIDGE_ENTRY_ID = 'desktop-bridge'
const DESKTOP_BRIDGE_PLUGIN_NAME = 'dsh-desktop-bridge'

interface RecoveryPatchEntry {
  id: string
  name: string
  disabled: true
}

export class PluginInitializationError extends Error {
  constructor(readonly failure: PluginInitializationFailure) {
    super(`Plugin ${failure.pluginName} failed to initialize: ${failure.detail}`)
    this.name = 'PluginInitializationError'
  }
}

export function parsePluginInitializationFailure(output: string): PluginInitializationFailure | undefined {
  let latest: RegExpExecArray | null = null
  for (const match of output.matchAll(PLUGIN_FAILURE_PATTERN)) latest = match
  if (/dsh: warning: \d+ (?:entry|entries) did not activate/u.test(output)) {
    for (const match of output.matchAll(INACTIVE_ENTRY_PATTERN)) {
      if (latest === null || (match.index ?? 0) > (latest.index ?? 0)) latest = match
    }
  }
  if (latest === null) return undefined
  const entryId = latest[1]?.trim()
  const pluginName = latest[2]?.trim()
  const detail = latest[3]?.trim()
  if (!isSafeValue(entryId) || !isSafeValue(pluginName) || detail === undefined || detail.length === 0) return undefined
  return {
    entryId,
    pluginName,
    detail: detail.slice(0, 1_000),
    recoverable: entryId !== DESKTOP_BRIDGE_ENTRY_ID
      && pluginName !== DESKTOP_BRIDGE_PLUGIN_NAME
      && !pluginName.startsWith('@deepseek-ai/'),
  }
}

export class PluginRecoveryService {
  private recovered: PluginRecoveryEntry[] = []

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

  async disable(failure: PluginInitializationFailure): Promise<void> {
    if (!failure.recoverable || !isSafeValue(failure.entryId) || !isSafeValue(failure.pluginName)) {
      throw new Error('该插件不能通过桌面恢复层禁用。')
    }
    const next = this.recovered.filter((entry) => entry.entryId !== failure.entryId)
    next.push({ entryId: failure.entryId, pluginName: failure.pluginName })
    this.recovered = next
    await this.writePatch()
  }

  async restore(entryId: string): Promise<void> {
    if (!isSafeValue(entryId)) throw new Error('插件恢复项无效。')
    const next = this.recovered.filter((entry) => entry.entryId !== entryId)
    if (next.length === this.recovered.length) throw new Error('没有找到对应的插件恢复项。')
    this.recovered = next
    await this.writePatch()
  }

  private async writePatch(): Promise<void> {
    const patches: RecoveryPatchEntry[] = this.recovered.map((entry) => ({
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
