import { EventEmitter } from 'node:events'
import type { BrowserWindow as ElectronWindow, HandlerDetails, WindowOpenHandlerResponse } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  windows: [] as Array<ElectronWindow & { options: Record<string, unknown> }>,
  openExternal: vi.fn(async (_url: string) => {}),
  showMessageBox: vi.fn(async () => ({})),
}))
vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() })
    constructor(readonly options: Record<string, unknown>) {
      super()
      mocks.windows.push(this as unknown as typeof mocks.windows[number])
    }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  },
}))

import { installExternalWindowHandling } from '../src/main/external-windows.js'

const origin = 'http://127.0.0.1:43123'
function fixture() {
  const contents = { setWindowOpenHandler: vi.fn() }
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: vi.fn(() => false) })
  installExternalWindowHandling(window as unknown as ElectronWindow, (url) => url.startsWith(`${origin}/`))
  const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as (details: HandlerDetails) => WindowOpenHandlerResponse
  const open = (url: string, referrer = `${origin}/`) => handler({ url, referrer: { url: referrer } } as HandlerDetails)
  const preopen = () => {
    const result = open('about:blank')
    expect(result.action).toBe('allow')
    const contents = result.createWindow!({ ...result.overrideBrowserWindowOptions, webPreferences: { preload: 'shell-preload.cjs' } })
    return { popup: mocks.windows.at(-1)!, contents }
  }
  return { window, open, preopen }
}

beforeEach(() => { vi.clearAllMocks(); mocks.windows.length = 0; vi.useFakeTimers() })
afterEach(() => { for (const popup of mocks.windows) if (!popup.isDestroyed()) popup.destroy(); vi.useRealTimers() })

describe('external login windows', () => {
  it('keeps a hidden placeholder and forwards the delayed authorization URL exactly once', async () => {
    const { preopen } = fixture()
    const { popup, contents } = preopen()
    expect(popup.options).toMatchObject({ show: false, skipTaskbar: true, focusable: false })
    expect(popup.options.webPreferences).not.toHaveProperty('preload')
    expect(mocks.openExternal).not.toHaveBeenCalled()
    const destination = 'https://accounts.example.test/authorize?state=a%2Bb&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fcallback&theme=dark'
    const event = { preventDefault: vi.fn() }
    contents.emit('will-navigate', event, 'about:blank')
    contents.emit('will-navigate', event, destination)
    contents.emit('will-redirect', event, destination)
    expect(event.preventDefault).toHaveBeenCalledTimes(3)
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(destination)
    await vi.waitFor(() => expect(popup.isDestroyed()).toBe(true))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still sends ordinary web links directly to the default browser', async () => {
    const { open } = fixture()
    expect(open('https://example.test/help')).toEqual({ action: 'deny' })
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.test/help')
    expect(mocks.windows).toHaveLength(0)
  })

  it.each(['file:///C:/secret.html', 'data:text/html,test', 'javascript:alert(1)', 'custom://login', 'invalid'])('blocks unsupported destinations: %s', (url) => {
    const { open, preopen } = fixture()
    expect(open(url)).toEqual({ action: 'deny' })
    const { contents, popup } = preopen()
    const event = { preventDefault: vi.fn() }
    contents.emit('will-navigate', event, url)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(popup.isDestroyed()).toBe(true)
  })

  it.each(['', 'https://unrelated.example/', 'http://127.0.0.1:43124/'])('does not create blank windows for another document: %s', (referrer) => {
    expect(fixture().open('about:blank', referrer)).toEqual({ action: 'deny' })
    expect(mocks.windows).toHaveLength(0)
  })

  it('blocks subframe navigation and additional popups inside the placeholder', () => {
    const { contents } = fixture().preopen()
    const event = { preventDefault: vi.fn(), isMainFrame: false, url: 'https://example.test/' }
    contents.emit('will-frame-navigate', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    const nestedHandler = vi.mocked(contents.setWindowOpenHandler).mock.calls[0]![0]
    expect(nestedHandler({ url: 'https://example.test/' } as HandlerDetails)).toEqual({ action: 'deny' })
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'parent-close', 'timeout'])('releases unused placeholders on %s', async (reason) => {
    const { window, preopen } = fixture()
    const { popup } = preopen()
    if (reason === 'cancel') popup.destroy()
    else if (reason === 'parent-close') window.emit('closed')
    else await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(popup.isDestroyed()).toBe(true)
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports browser launch failure without exposing the authorization link or retaining a hidden window', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('launch failed with sensitive URL'))
    const { popup, contents } = fixture().preopen()
    contents.emit('will-navigate', { preventDefault() {} }, 'https://accounts.example.test/authorize?state=secret')
    await vi.waitFor(() => expect(popup.isDestroyed()).toBe(true))
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.anything(), {
      type: 'error', title: '无法打开默认浏览器', message: '请复制链接后在系统默认浏览器中手动打开。',
    })
  })
})
