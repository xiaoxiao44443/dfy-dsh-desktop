/** Local HTML documents that the desktop can open as web pages. */
export function normalizeLocalHtmlUrl(value: string): string | undefined {
  if (/[\r\n\0]/u.test(value) || !/^file:/iu.test(value)) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:' || url.hostname !== '' || url.username !== '' || url.password !== '') return undefined
    // A slash is always a separator; a backslash is a filename character on POSIX.
    if (/%2f/iu.test(url.pathname)) return undefined
    const path = decodeURIComponent(url.pathname)
    if (path.startsWith('//') || (/^\/[a-z]:/iu.test(path) && /%5c/iu.test(url.pathname))) return undefined
    if (/[\r\n\0]/u.test(path) || !/\.(?:html?|xhtml)$/iu.test(path)) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Shared by browser navigation and its two context-menu destinations. */
export function normalizeBrowserPageUrl(value: string): string | undefined {
  if (/[\r\n\0]/u.test(value)) return undefined
  if (/^file:/iu.test(value)) return normalizeLocalHtmlUrl(value)
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function isSupportedBrowserUrl(value: string): boolean {
  return normalizeBrowserPageUrl(value) !== undefined
}
