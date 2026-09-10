import { describe, expect, it } from 'vitest'
import { filterHarnessRequestCookies } from '../src/main/harness-request-cookies.js'

const ORIGIN = 'http://127.0.0.1:43123'
const OTHER_ORIGIN = 'http://127.0.0.1:43124'
const RENDERER_ORIGIN = 'http://127.0.0.1:5173'
// SHA-256 base64url of the canonical Host authorities used by DSH.
const CURRENT = 'dsh-auth-GdnvWnHsqPBuURQ6GdTsylBQ2BjQ73m51nwsCdhyxQg'
const OTHER = 'dsh-auth-k9QMkgXfUt6dTouRVZ_kTn_n6v1ror0iRht9B8X_Xuw'

describe('Harness request cookie isolation', () => {
  it.each(['Cookie', 'cookie', 'COOKIE'])('filters other authorities from %s while preserving current and non-DSH credentials', (header) => {
    const original = `${CURRENT}=current; ${OTHER}=other; app-session=a=b; dsh-auth-custom=plugin; DSH-auth-${'a'.repeat(43)}=unrelated`
    const headers = { [header]: original, Accept: '*/*', Authorization: 'unchanged' }
    expect(filterHarnessRequestCookies(`${ORIGIN}/api/client?modules=long`, headers, ORIGIN)).toEqual({
      ...headers, [header]: `${CURRENT}=current; app-session=a=b; dsh-auth-custom=plugin; DSH-auth-${'a'.repeat(43)}=unrelated`,
    })
    expect(headers[header]).toBe(original)
  })

  it('preserves the original headers when there is no Cookie or no removable cookie', () => {
    for (const headers of [{ Accept: '*/*' }, { Cookie: `${CURRENT}=current; session=mine` }]) {
      expect(filterHarnessRequestCookies(ORIGIN, headers, ORIGIN)).toBe(headers)
    }
  })

  it.each([
    OTHER_ORIGIN, 'http://127.0.0.1:431230', 'http://localhost:43123',
    'http://127.0.0.2:43123', 'https://127.0.0.1:43123',
    'http://example.com:43123', 'http://127.0.0.1:43123.example.com/',
    'http://user@127.0.0.1:43123/', 'invalid-url',
  ])('does not alter cookies sent to an unrelated or unsupported destination: %s', (url) => {
    const headers = { Cookie: `${CURRENT}=current; ${OTHER}=other` }
    expect(filterHarnessRequestCookies(url, headers, ORIGIN)).toBe(headers)
  })

  it.each([undefined, 'invalid', 'https://127.0.0.1:43123', 'http://localhost:43123', `${ORIGIN}/path`, 'http://127.0.0.1'])('fails open for an unrecognized Harness origin: %s', (origin) => {
    const headers = { Cookie: `${OTHER}=other` }
    expect(filterHarnessRequestCookies(ORIGIN, headers, origin)).toBe(headers)
  })

  it('uses the same Host authority for the current Harness WebSocket handshake', () => {
    expect(filterHarnessRequestCookies('ws://127.0.0.1:43123/api/socket', {
      Cookie: `${OTHER}=other; ${CURRENT}=current`, Upgrade: 'websocket',
    }, ORIGIN)).toEqual({ Cookie: `${CURRENT}=current`, Upgrade: 'websocket' })
  })

  it('changes the retained auth cookie when Harness restarts on another port', () => {
    const headers = { Cookie: `${CURRENT}=first; ${OTHER}=second` }
    expect(filterHarnessRequestCookies(OTHER_ORIGIN, headers, OTHER_ORIGIN)).toEqual({ Cookie: `${OTHER}=second` })
    expect(filterHarnessRequestCookies(ORIGIN, headers, OTHER_ORIGIN)).toBe(headers)
  })

  it('removes all DSH auth cookies only from our exact desktop renderer origin', () => {
    const headers = { Cookie: `${CURRENT}=current; ${OTHER}=other; renderer-setting=keep`, Accept: '*/*' }
    expect(filterHarnessRequestCookies(`${RENDERER_ORIGIN}/index.html`, headers, ORIGIN, RENDERER_ORIGIN))
      .toEqual({ Cookie: 'renderer-setting=keep', Accept: '*/*' })
    expect(filterHarnessRequestCookies(`${RENDERER_ORIGIN}/index.html`, headers, undefined, RENDERER_ORIGIN))
      .toEqual({ Cookie: 'renderer-setting=keep', Accept: '*/*' })
    expect(filterHarnessRequestCookies(OTHER_ORIGIN, headers, ORIGIN, RENDERER_ORIGIN)).toBe(headers)
    expect(headers.Cookie).toContain(`${OTHER}=other`)
  })

  it('removes an empty Cookie header while leaving all other headers intact', () => {
    expect(filterHarnessRequestCookies(ORIGIN, { Cookie: `${OTHER}=other`, Accept: '*/*' }, ORIGIN))
      .toEqual({ Accept: '*/*' })
  })

  it('does not mistake malformed or merely prefixed names for official auth cookies', () => {
    const headers = { Cookie: `dsh-auth-${'a'.repeat(42)}=short; dsh-auth-${'a'.repeat(44)}=long; dsh-auth-${'a'.repeat(42)}+=invalid; ${OTHER}` }
    expect(filterHarnessRequestCookies(ORIGIN, headers, ORIGIN)).toBe(headers)
  })
})
