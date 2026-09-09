import { normalizeBrowserPageUrl } from './browser-address.js'

interface AddressPart { source: string; display: string }

function addressParts(url: string): AddressPart[] {
  const parts: AddressPart[] = []
  let sourceOffset = 0
  for (const match of url.matchAll(/(?:%[\da-f]{2})+/giu)) {
    const escaped = match[0]
    if (match.index > sourceOffset) parts.push({ source: url.slice(sourceOffset, match.index), display: url.slice(sourceOffset, match.index) })
    for (let offset = 0; offset < escaped.length;) {
      const byte = Number.parseInt(escaped.slice(offset + 1, offset + 3), 16)
      const byteCount = byte >= 0xc2 && byte <= 0xdf ? 2
        : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1
      const encoded = escaped.slice(offset, offset + byteCount * 3)
      let display = encoded
      try {
        const character = decodeURIComponent(encoded)
        display = character === ' ' || (byte >= 0x80 && !/[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(character))
          ? character : encoded
      } catch {
        // Invalid/incomplete UTF-8 remains visible as its original escape sequence.
      }
      parts.push({ source: encoded, display })
      offset += encoded.length
    }
    sourceOffset = match.index + escaped.length
  }
  if (sourceOffset < url.length) parts.push({ source: url.slice(sourceOffset), display: url.slice(sourceOffset) })
  // Navigation trims user input; keep escaped terminal spaces meaningful in a query/hash.
  for (const part of [...parts].reverse()) {
    if (part.display !== ' ') break
    part.display = part.source
  }
  return parts
}

/** Decode readable UTF-8 for the address bar without changing URL delimiters. */
export function formatBrowserAddress(url: string, options: { hideScheme?: boolean } = {}): string {
  const readable = addressParts(url).map((part) => part.display).join('')
  if (options.hideScheme !== true) return readable
  if (/^https?:\/\//iu.test(readable)) return readable.replace(/^https?:\/\//iu, '')
  // Windows drive paths have no leading slash; POSIX paths keep their root slash.
  if (/^file:\/\/\/[a-z]:\//iu.test(readable)) return readable.slice('file:///'.length)
  return readable.replace(/^file:\/\/(?=\/)/iu, '')
}

function isCurrentBrowserAddress(input: string, currentUrl: string): boolean {
  return input === formatBrowserAddress(currentUrl)
    || input === formatBrowserAddress(currentUrl, { hideScheme: true })
}

/** Preserve the exact navigation URL when the user submits the unedited display. */
export function browserAddressForNavigation(input: string, currentUrl: string): string {
  return isCurrentBrowserAddress(input, currentUrl) ? currentUrl : input
}

/** Whole-address copy uses the URL; partial selections keep the visible text. */
export function browserAddressForCopy(input: string, currentUrl: string, start: number, end: number): string {
  if (start !== 0 || end !== input.length) return input.slice(start, end)
  const url = isCurrentBrowserAddress(input, currentUrl) ? currentUrl : normalizeBrowserPageUrl(input)
  return url ?? input
}
