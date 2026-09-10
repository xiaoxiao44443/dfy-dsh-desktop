import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface MockDevToolsWindow extends EventEmitter {
  options: Record<string, unknown>
  webContents: EventEmitter & {
    executeJavaScript: ReturnType<typeof vi.fn>
    destroyed: boolean
    isDestroyed(): boolean
    finishDestroy(): void
  }
  destroyed: boolean
  minimized: boolean
  title: string
  appliedThemes: string[]
  isDestroyed(): boolean
  isMinimized(): boolean
  setMenu: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

const electronMocks = vi.hoisted(() => ({
  packaged: false,
  autoDestroyFrontend: true,
  appPath: 'C:/apps/dfy-desktop-development',
  windows: [] as MockDevToolsWindow[],
}))

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events')
  class MockBrowserWindow extends MockEventEmitter {
    appliedThemes: string[] = []
    webContents = Object.assign(new MockEventEmitter(), {
      destroyed: false,
      isDestroyed: () => this.webContents.destroyed,
      finishDestroy: () => {
        if (this.webContents.destroyed) return
        this.webContents.destroyed = true
        this.webContents.emit('destroyed')
      },
      executeJavaScript: vi.fn(async (script: string) => {
        // Replace only the frontend module loader, then execute the actual theme script.
        const expression = script.replace("import('./core/common/common.js')", 'loadCommon()')
        const loadCommon = async () => ({ Settings: { moduleSetting: (name: string) => {
          expect(name).toBe('ui-theme')
          return { set: (value: string) => { this.appliedThemes.push(value) } }
        } } })
        return await new Function('loadCommon', `return ${expression}`)(loadCommon)
      }),
    })
    destroyed = false
    minimized = false
    title: string
    setMenu = vi.fn()
    setTitle = vi.fn((title: string) => { this.title = title })
    setBackgroundColor = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn(() => { this.minimized = false })
    close = vi.fn(() => {
      let prevented = false
      this.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented && !this.destroyed) this.destroy()
    })
    destroy = vi.fn(() => {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
      if (electronMocks.autoDestroyFrontend) queueMicrotask(() => this.webContents.finishDestroy())
    })
    constructor(readonly options: Record<string, unknown>) {
      super()
      this.title = String(options.title)
      electronMocks.windows.push(this)
    }
    isDestroyed(): boolean { return this.destroyed }
    isMinimized(): boolean { return this.minimized }
  }
  return {
    app: { get isPackaged() { return electronMocks.packaged }, getAppPath: () => electronMocks.appPath },
    BrowserWindow: MockBrowserWindow,
  }
})

import { BrowserDevToolsController } from '../src/main/browser-devtools.js'

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const pageEvents = ['did-navigate', 'did-navigate-in-page', 'devtools-opened', 'devtools-closed', 'destroyed'] as const

function page(url = 'https://example.com/path?q=search#details') {
  const state = { url, destroyed: false }
  const contents = Object.assign(new EventEmitter(), {
    state,
    getURL: vi.fn(() => state.url),
    isDestroyed: vi.fn(() => state.destroyed),
    isDevToolsOpened: vi.fn(() => false),
    devToolsWebContents: null as MockDevToolsWindow['webContents'] | null,
    setDevToolsWebContents: vi.fn(),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
  })
  contents.closeDevTools.mockImplementation(() => { contents.emit('devtools-closed') })
  return contents
}

async function open(controller: BrowserDevToolsController, contents: ReturnType<typeof page>) {
  await controller.open(contents as never)
  const frontend = contents.setDevToolsWebContents.mock.calls.at(-1)?.[0]
  return electronMocks.windows.find((window) => window.webContents === frontend)!
}

function expectReleased(contents: ReturnType<typeof page>) {
  for (const event of pageEvents) expect(contents.listenerCount(event), event).toBe(0)
}

afterEach(async () => {
  electronMocks.autoDestroyFrontend = true
  for (const window of electronMocks.windows) {
    if (!window.destroyed) window.destroy()
    window.webContents.finishDestroy()
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  electronMocks.windows.length = 0
  electronMocks.packaged = false
  if (originalResourcesPath === undefined) Reflect.deleteProperty(process, 'resourcesPath')
  else Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  vi.restoreAllMocks()
})

describe('browser DevTools window', () => {
  it.each([false, true])('uses the application icon and isolated preferences when packaged=%s', async (packaged) => {
    electronMocks.packaged = packaged
    const resourcesPath = 'C:/apps/DFY DSH Desktop/resources'
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
    const contents = page()
    const window = await open(new BrowserDevToolsController(), contents)
    expect(window.options).toMatchObject({
      show: false,
      title: 'DevTools - example.com/path?q=search#details',
      backgroundColor: '#ffffff',
      icon: join(packaged ? resourcesPath : electronMocks.appPath, 'app-icon.png'),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false },
    })
    expect(window.setMenu).toHaveBeenCalledExactlyOnceWith(null)
    expect(contents.setDevToolsWebContents).toHaveBeenCalledExactlyOnceWith(window.webContents)
    expect(contents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
    expect(contents.setDevToolsWebContents.mock.invocationCallOrder[0]!)
      .toBeLessThan(contents.openDevTools.mock.invocationCallOrder[0]!)
    expect(window.show).not.toHaveBeenCalled()
    contents.emit('devtools-opened')
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledOnce())
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('reuses the existing window, restoring it from minimized state without reopening DevTools', async () => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const window = await open(controller, contents)
    contents.emit('devtools-opened')
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledOnce())
    window.minimized = true
    await open(controller, contents)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.minimized).toBe(false)
    await open(controller, contents)
    expect(electronMocks.windows).toHaveLength(1)
    expect(contents.setDevToolsWebContents).toHaveBeenCalledOnce()
    expect(contents.openDevTools).toHaveBeenCalledOnce()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledTimes(3)
    expect(window.focus).toHaveBeenCalledTimes(3)
    for (const event of pageEvents) expect(contents.listenerCount(event), event).toBe(1)
  })

  it('updates the title for document navigation and main-frame hash changes without using page titles', async () => {
    const contents = page()
    const window = await open(new BrowserDevToolsController(), contents)
    contents.state.url = 'http://other.example/search?q=a%23b#result'
    contents.emit('did-navigate', {}, contents.state.url)
    expect(window.title).toBe('DevTools - other.example/search?q=a%23b#result')
    contents.state.url = 'http://other.example/search?q=a%23b#next'
    contents.emit('did-navigate-in-page', {}, contents.state.url, true)
    expect(window.title).toBe('DevTools - other.example/search?q=a%23b#next')
    window.setTitle.mockClear()
    contents.emit('did-navigate-in-page', {}, 'https://child.example/#changed', false)
    expect(window.setTitle).not.toHaveBeenCalled()
    const event = { preventDefault: vi.fn() }
    window.emit('page-title-updated', event, 'Developer Tools - misleading frontend title')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.title).toBe('DevTools - other.example/search?q=a%23b#next')
  })

  it.each([
    ['file:///E:/%E7%BD%91%E9%A1%B5/a%23b.html?x=1#section', 'E:/网页/a%23b.html?x=1#section'],
    ['https://example.com/%E4%B8%AD%E6%96%87?q=%25#x', 'example.com/中文?q=%25#x'],
    ['', 'about:blank'],
  ])('preserves URL semantics in the title for %s', async (url, displayed) => {
    const window = await open(new BrowserDevToolsController(), page(url))
    expect(window.title).toBe(`DevTools - ${displayed}`)
  })

  it('lets a user close the host, detaches the page, and creates a fresh window when reopened', async () => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const first = await open(controller, contents)
    first.close()
    expect(first.destroyed).toBe(true)
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(contents.closeDevTools).toHaveBeenCalled()
    expectReleased(contents)
    const next = await open(controller, contents)
    expect(next).not.toBe(first)
    expect(next.destroyed).toBe(false)
    expect(electronMocks.windows).toHaveLength(2)
    expect(contents.setDevToolsWebContents).toHaveBeenLastCalledWith(next.webContents)
    expect(contents.openDevTools).toHaveBeenCalledTimes(2)
  })

  it('destroys the host and releases listeners when its page is destroyed', async () => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const window = await open(controller, contents)
    contents.state.destroyed = true
    contents.emit('destroyed')
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(contents.closeDevTools).not.toHaveBeenCalled()
    expectReleased(contents)
    contents.emit('devtools-opened')
    contents.emit('did-navigate', {}, 'https://late.example')
    expect(window.show).not.toHaveBeenCalled()
    await open(controller, contents)
    expect(electronMocks.windows).toHaveLength(1)
  })

  it('cleans up on devtools-closed without recursive closes and leaves another page intact', async () => {
    const controller = new BrowserDevToolsController()
    const firstPage = page('https://first.example/')
    const otherPage = page('https://other.example/')
    const first = await open(controller, firstPage)
    const other = await open(controller, otherPage)
    firstPage.emit('devtools-closed')
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(firstPage.closeDevTools).toHaveBeenCalledOnce()
    expectReleased(firstPage)
    expect(other.destroy).not.toHaveBeenCalled()
    expect(otherPage.closeDevTools).not.toHaveBeenCalled()
    otherPage.emit('devtools-opened')
    await vi.waitFor(() => expect(other.show).toHaveBeenCalledOnce())
    expect(await open(controller, firstPage)).not.toBe(first)
    expect(electronMocks.windows).toHaveLength(3)
  })

  it.each(['setDevToolsWebContents', 'openDevTools'] as const)('cleans up a failed %s and permits a later retry', async (method) => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const failure = new Error('DevTools unavailable')
    contents[method].mockImplementationOnce(() => { throw failure })
    await expect(open(controller, contents)).rejects.toThrow(failure)
    const failed = electronMocks.windows[0]!
    expect(failed.destroy).toHaveBeenCalledOnce()
    expect(contents.closeDevTools).toHaveBeenCalledOnce()
    expectReleased(contents)
    const fresh = await open(controller, contents)
    expect(fresh).not.toBe(failed)
    expect(fresh.destroyed).toBe(false)
    contents.emit('devtools-opened')
    expect(failed.show).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(fresh.show).toHaveBeenCalledOnce())
  })

  it('closes an existing native frontend before attaching a custom host', async () => {
    const contents = page()
    contents.isDevToolsOpened.mockReturnValue(true)
    const window = await open(new BrowserDevToolsController(), contents)
    expect(contents.closeDevTools).toHaveBeenCalledOnce()
    expect(contents.closeDevTools.mock.invocationCallOrder[0]!)
      .toBeLessThan(contents.setDevToolsWebContents.mock.invocationCallOrder[0]!)
    expect(contents.setDevToolsWebContents).toHaveBeenCalledExactlyOnceWith(window.webContents)
    expect(window.destroyed).toBe(false)
    expect(window.destroy).not.toHaveBeenCalled()
  })

  it('waits for a closing frontend and its queued destruction observers before reopening', async () => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const first = await open(controller, contents)
    electronMocks.autoDestroyFrontend = false
    first.close()
    expect(first.destroyed).toBe(true)
    expect(first.webContents.destroyed).toBe(false)
    // Chromium can finish clearing the old frontend after its destroyed event.
    first.webContents.once('destroyed', () => queueMicrotask(() => { contents.emit('devtools-closed') }))
    let reopened = false
    const reopening = controller.open(contents as never).then(() => { reopened = true })
    await Promise.resolve()
    expect(electronMocks.windows).toHaveLength(1)
    expect(reopened).toBe(false)
    first.webContents.finishDestroy()
    expect(electronMocks.windows).toHaveLength(1)
    await reopening
    const next = electronMocks.windows[1]!
    expect(next).toBeDefined()
    expect(next.destroyed).toBe(false)
    expect(contents.setDevToolsWebContents).toHaveBeenLastCalledWith(next.webContents)
    contents.emit('devtools-opened')
    await vi.waitFor(() => expect(next.show).toHaveBeenCalledOnce())
    expect(next.destroyed).toBe(false)
  })

  it('does not reopen a page destroyed while the old frontend is still releasing', async () => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const window = await open(controller, contents)
    electronMocks.autoDestroyFrontend = false
    window.close()
    const reopening = controller.open(contents as never)
    contents.state.destroyed = true
    contents.emit('destroyed')
    window.webContents.finishDestroy()
    await reopening
    expect(electronMocks.windows).toHaveLength(1)
    expect(contents.openDevTools).toHaveBeenCalledOnce()
  })

  it('waits for an existing native frontend to release before registering its replacement', async () => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const nativeState = { destroyed: false }
    const nativeFrontend = Object.assign(new EventEmitter(), { isDestroyed: () => nativeState.destroyed })
    contents.devToolsWebContents = nativeFrontend as never
    contents.isDevToolsOpened.mockReturnValue(true)
    contents.closeDevTools.mockImplementationOnce(() => {
      contents.isDevToolsOpened.mockReturnValue(false)
      contents.emit('devtools-closed')
    })
    const opening = controller.open(contents as never)
    expect(contents.closeDevTools).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(electronMocks.windows).toHaveLength(0)
    expect(contents.setDevToolsWebContents).not.toHaveBeenCalled()
    nativeState.destroyed = true
    nativeFrontend.emit('destroyed')
    await opening
    expect(electronMocks.windows).toHaveLength(1)
    expect(contents.setDevToolsWebContents).toHaveBeenCalledExactlyOnceWith(electronMocks.windows[0]!.webContents)
    expect(contents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
  })
})

describe('browser DevTools theme', () => {
  it.each([
    ['light', 'default', '#ffffff'], ['dark', 'dark', '#282828'],
  ] as const)('applies the initial %s theme before presenting the frontend', async (theme, setting, background) => {
    const controller = new BrowserDevToolsController()
    controller.setTheme(theme)
    const contents = page()
    const window = await open(controller, contents)
    expect(window.options.backgroundColor).toBe(background)
    window.webContents.emit('did-finish-load')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(window.appliedThemes).toEqual([])
    expect(window.show).not.toHaveBeenCalled()
    contents.emit('devtools-opened')
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledOnce())
    expect(window.appliedThemes).toEqual([setting])
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(background)
    expect(window.webContents.executeJavaScript.mock.invocationCallOrder[0]!)
      .toBeLessThan(window.show.mock.invocationCallOrder[0]!)
  })

  it('updates every open frontend while leaving closed hosts and inspected pages untouched', async () => {
    const controller = new BrowserDevToolsController()
    const contents = [page('https://one.example/'), page('https://two.example/'), page('https://closed.example/')]
    const windows = await Promise.all(contents.map((item) => open(controller, item)))
    for (const item of contents) item.emit('devtools-opened')
    await vi.waitFor(() => { for (const window of windows) expect(window.show).toHaveBeenCalledOnce() })
    windows[2]!.close()
    const closedUpdates = windows[2]!.webContents.executeJavaScript.mock.calls.length
    controller.setTheme('dark')
    await vi.waitFor(() => { for (const window of windows.slice(0, 2)) expect(window.appliedThemes.at(-1)).toBe('dark') })
    for (const window of windows.slice(0, 2)) expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#282828')
    controller.setTheme('light')
    await vi.waitFor(() => { for (const window of windows.slice(0, 2)) expect(window.appliedThemes.at(-1)).toBe('default') })
    for (const window of windows.slice(0, 2)) expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff')
    expect(windows[2]!.webContents.executeJavaScript).toHaveBeenCalledTimes(closedUpdates)
    expect(contents[0]!.openDevTools).toHaveBeenCalledOnce()
    expect(contents[1]!.openDevTools).toHaveBeenCalledOnce()
    expect(contents[0]!.closeDevTools).not.toHaveBeenCalled()
    expect(contents[1]!.closeDevTools).not.toHaveBeenCalled()
  })

  it('reapplies the current theme when the frontend reloads without reopening its host', async () => {
    const controller = new BrowserDevToolsController()
    controller.setTheme('dark')
    const contents = page()
    const window = await open(controller, contents)
    contents.emit('devtools-opened')
    await vi.waitFor(() => expect(window.show).toHaveBeenCalledOnce())
    window.appliedThemes.length = 0
    window.webContents.emit('did-finish-load')
    await vi.waitFor(() => expect(window.appliedThemes).toEqual(['dark']))
    expect(window.show).toHaveBeenCalledOnce()
    expect(contents.openDevTools).toHaveBeenCalledOnce()
  })

  it('does not show a closed host after an in-flight theme application finishes', async () => {
    const controller = new BrowserDevToolsController()
    const contents = page()
    const window = await open(controller, contents)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const execute = window.webContents.executeJavaScript.getMockImplementation()!
    window.webContents.executeJavaScript.mockImplementationOnce(async (script: string) => {
      await pending
      return await execute(script)
    })
    contents.emit('devtools-opened')
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce())
    window.close()
    controller.setTheme('dark')
    finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(window.destroyed).toBe(true)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce()
    expectReleased(contents)
  })

  it('serializes changes so an older in-flight theme cannot overwrite the final selection', async () => {
    const controller = new BrowserDevToolsController()
    controller.setTheme('dark')
    const contents = page()
    const window = await open(controller, contents)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const execute = window.webContents.executeJavaScript.getMockImplementation()!
    window.webContents.executeJavaScript.mockImplementationOnce(async (script: string) => {
      await pending
      return await execute(script)
    })
    contents.emit('devtools-opened')
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce())
    controller.setTheme('light')
    controller.setTheme('dark')
    controller.setTheme('light')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce()
    finish()
    await vi.waitFor(() => expect(window.appliedThemes.at(-1)).toBe('default'))
    expect(window.appliedThemes[0]).toBe('dark')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff')
    expect(window.appliedThemes.slice(1).every((theme) => theme === 'default')).toBe(true)
    expect(contents.openDevTools).toHaveBeenCalledOnce()
  })
})
