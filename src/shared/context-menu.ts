import { normalizeBrowserPageUrl } from './browser-address.js'

export const CONTEXT_MENU_ICONS = [
  'copy',
  'cut',
  'paste',
  'undo',
  'redo',
  'select-all',
  'external-link',
  'browser',
  'link',
  'plugin',
  'archive',
  'trash',
  'edit',
  'folder',
  'settings',
  'terminal',
  'sparkles',
  'refresh',
  'download',
] as const

export const DESKTOP_CONTEXT_MENU_TRANSPORT_KEY = 'dsh.desktop.context-menu.transport.v1'

export type ContextMenuIcon = (typeof CONTEXT_MENU_ICONS)[number]

export interface ContextMenuActionEntry {
  kind: 'item'
  id: string
  label: string
  enabled: boolean
  icon?: ContextMenuIcon
  checked?: boolean
  danger?: boolean
}

export interface ContextMenuSeparatorEntry {
  kind: 'separator'
  id: string
}

export type ContextMenuEntry = ContextMenuActionEntry | ContextMenuSeparatorEntry

export interface DesktopContextMenuRequest {
  requestId: string
  x: number
  y: number
  items: ContextMenuEntry[]
}

export interface DesktopContextMenuActionRequest {
  requestId: string
  itemId: string
}

export interface DesktopPointerInput {
  x: number
  y: number
  button: 'left' | 'middle' | 'right'
}

export interface PluginContextMenuCollection {
  token: string
  items: ContextMenuEntry[]
  linkURL?: string
}

const iconNames = new Set<string>(CONTEXT_MENU_ICONS)
const itemIdPattern = /^[a-z0-9][a-z0-9._:-]{0,95}$/iu
const MAX_MENU_ITEMS = 80

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= maxLength && !/[\r\n\0]/u.test(text) ? text : undefined
}

function safeBrowserURL(value: unknown): string | undefined {
  const text = boundedText(value, 2_048)
  if (text === undefined) return undefined
  return normalizeBrowserPageUrl(text)
}

function parseEntry(value: unknown): ContextMenuEntry | undefined {
  const candidate = objectValue(value)
  if (candidate === undefined) return undefined
  const id = boundedText(candidate.id, 96)
  if (id === undefined || !itemIdPattern.test(id)) return undefined
  if (candidate.kind === 'separator') return { kind: 'separator', id }
  if (candidate.kind !== 'item') return undefined
  const label = boundedText(candidate.label, 120)
  if (label === undefined) return undefined
  if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') return undefined
  if (candidate.checked !== undefined && typeof candidate.checked !== 'boolean') return undefined
  if (candidate.danger !== undefined && typeof candidate.danger !== 'boolean') return undefined

  const icon = typeof candidate.icon === 'string' && iconNames.has(candidate.icon)
    ? candidate.icon as ContextMenuIcon
    : undefined
  return {
    kind: 'item',
    id,
    label,
    enabled: candidate.enabled !== false,
    ...(icon !== undefined ? { icon } : {}),
    ...(typeof candidate.checked === 'boolean' ? { checked: candidate.checked } : {}),
    ...(typeof candidate.danger === 'boolean' ? { danger: candidate.danger } : {}),
  }
}

export function sanitizeContextMenuEntries(value: unknown): ContextMenuEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ContextMenuEntry[] = []
  const ids = new Set<string>()
  for (const item of value.slice(0, MAX_MENU_ITEMS)) {
    const entry = parseEntry(item)
    if (entry === undefined || ids.has(entry.id)) continue
    if (entry.kind === 'separator' && (entries.length === 0 || entries.at(-1)?.kind === 'separator')) continue
    ids.add(entry.id)
    entries.push(entry)
  }
  if (entries.at(-1)?.kind === 'separator') entries.pop()
  return entries
}

export function parsePluginContextMenuCollection(value: unknown): PluginContextMenuCollection | undefined {
  const candidate = objectValue(value)
  const token = boundedText(candidate?.token, 128)
  if (token === undefined) return undefined
  const items = sanitizeContextMenuEntries(candidate?.items)
    .filter((entry) => entry.kind === 'separator' || entry.id.startsWith('plugin.'))
  const linkURL = safeBrowserURL(candidate?.linkURL)
  if (!items.some((entry) => entry.kind === 'item') && linkURL === undefined) return undefined
  return { token, items, ...(linkURL === undefined ? {} : { linkURL }) }
}

export function clampContextMenuPosition(
  anchorX: number,
  anchorY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { x: number; y: number } {
  const safeMargin = Math.max(0, Number.isFinite(margin) ? margin : 0)
  const safeWidth = Math.max(0, Number.isFinite(menuWidth) ? menuWidth : 0)
  const safeHeight = Math.max(0, Number.isFinite(menuHeight) ? menuHeight : 0)
  const maxX = Math.max(safeMargin, viewportWidth - safeWidth - safeMargin)
  const maxY = Math.max(safeMargin, viewportHeight - safeHeight - safeMargin)
  return {
    x: Math.min(Math.max(Number.isFinite(anchorX) ? anchorX : safeMargin, safeMargin), maxX),
    y: Math.min(Math.max(Number.isFinite(anchorY) ? anchorY : safeMargin, safeMargin), maxY),
  }
}
