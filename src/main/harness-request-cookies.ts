import { createHash } from 'node:crypto'

const HARNESS_AUTH_COOKIE = /^dsh-auth-[A-Za-z0-9_-]{43}$/u

function loopbackOrigin(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && url.port.length > 0 && url.origin === value ? url : undefined
  } catch { return undefined }
}

/** Keep other Harness authorities' credentials in storage, but off this request. */
export function filterHarnessRequestCookies(
  requestUrl: string,
  headers: Record<string, string>,
  harnessOrigin: string | undefined,
  rendererOrigin?: string,
): Record<string, string> {
  const current = loopbackOrigin(harnessOrigin)
  const renderer = loopbackOrigin(rendererOrigin)
  let requested: URL
  try {
    requested = new URL(requestUrl)
    if (requested.protocol === 'ws:') requested.protocol = 'http:'
    if (requested.username || requested.password) return headers
  } catch { return headers }
  const isHarness = current !== undefined && requested.origin === current.origin
  if (!isHarness && (renderer === undefined || requested.origin !== renderer.origin)) return headers

  // DSH client-connection hashes new URL(`http://${Host}`).host: the
  // canonical authority, including this randomly assigned listening port.
  // The desktop renderer itself does not use any DSH authentication cookie.
  const currentCookie = isHarness ? `dsh-auth-${createHash('sha256').update(current.host).digest('base64url')}` : undefined
  let result = headers
  for (const [header, value] of Object.entries(headers)) {
    if (header.toLowerCase() !== 'cookie') continue
    const segments = value.split(';')
    const retained = segments.filter((segment) => {
      const equals = segment.indexOf('=')
      if (equals === -1) return true
      const name = segment.slice(0, equals).trim()
      return !HARNESS_AUTH_COOKIE.test(name) || name === currentCookie
    })
    if (retained.length === segments.length) continue
    if (result === headers) result = { ...headers }
    const cookie = retained.join(';').trim()
    if (cookie.length === 0) delete result[header]
    else result[header] = cookie
  }
  return result
}
