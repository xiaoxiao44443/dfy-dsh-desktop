import { describe, expect, it, vi } from 'vitest'
import { handleNotificationProtocolArguments, notificationProtocolScheme } from '../src/main/notification-protocol.js'

describe('notification protocol routing', () => {
  const scheme = notificationProtocolScheme(false)
  const url = `${scheme}://action/af7a21d0-236c-432f-a1eb-ea3ef557b743`

  it('uses separate installed and development handlers', () => {
    expect(notificationProtocolScheme(true)).toBe('dfy-dsh-notification')
    expect(scheme).toBe('dfy-dsh-notification-dev')
  })

  it('routes the exact URL received by an existing instance once', () => {
    const handle = vi.fn(() => true)
    expect(handleNotificationProtocolArguments(['electron.exe', 'E:/项目文件/desktop', url], scheme, handle)).toBe(true)
    expect(handle).toHaveBeenCalledExactlyOnceWith(url)
  })

  it.each([
    { args: ['electron.exe', 'https://example.com'] },
    { args: ['electron.exe', `https://example.com/${url}`] },
    { args: ['electron.exe', `${scheme}-other://action/anything`] },
  ])('leaves ordinary startup arguments to normal window handling', ({ args }) => {
    const handle = vi.fn()
    expect(handleNotificationProtocolArguments(args, scheme, handle)).toBe(false)
    expect(handle).not.toHaveBeenCalled()
  })

  it('does not dispatch ambiguous or combined approval arguments', () => {
    const handle = vi.fn()
    expect(handleNotificationProtocolArguments([url, url], scheme, handle)).toBe(true)
    expect(handle).not.toHaveBeenCalled()
  })

  it('consumes stale notification launches without opening or substituting another request', () => {
    const handle = vi.fn(() => false)
    expect(handleNotificationProtocolArguments([url], scheme, handle)).toBe(true)
    expect(handle).toHaveBeenCalledExactlyOnceWith(url)
  })
})
