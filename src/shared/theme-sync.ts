import type { ColorTheme } from './contracts.js'

export type ColorThemePreference = ColorTheme | 'system'
export const THEME_SYNC_TRANSPORT_KEY = 'dsh.desktop.theme-sync.v1'

export function parseHarnessThemePreference(value: unknown): ColorThemePreference | undefined {
  return value === 'dark' || value === 'light' || value === 'system' ? value : undefined
}

export function readHarnessThemeMessage(
  event: { source: unknown; origin: string; data: unknown },
  frameWindow: unknown,
  harnessUrl: string,
): ColorThemePreference | undefined {
  if (frameWindow == null || event.source !== frameWindow) return undefined
  try {
    if (event.origin !== new URL(harnessUrl).origin) return undefined
  } catch { return undefined }
  const data = event.data
  if (data === null || typeof data !== 'object' || !('type' in data)
    || data.type !== THEME_SYNC_TRANSPORT_KEY || !('preference' in data)) return undefined
  return parseHarnessThemePreference(data.preference)
}
