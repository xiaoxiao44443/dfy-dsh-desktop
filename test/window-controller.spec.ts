import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const imageActionMocks = vi.hoisted(() => ({
  findContextMenuImagePath: vi.fn(async (): Promise<string | undefined> => undefined),
  revealContextMenuImage: vi.fn(async () => undefined),
  saveContextMenuImage: vi.fn(async () => undefined),
}))
vi.mock('../src/main/image-actions.js', () => imageActionMocks)

const electronMocks = vi.hoisted(() => ({
  clipboardImage: { isEmpty: () => false },
  clipboardWriteImage: vi.fn(),
  clipboardWriteText: vi.fn(),
  shellOpenExternal: vi.fn(),
  shellOpenPath: vi.fn(async () => ''),
  appQuit: vi.fn(),
  nativeImageCreateFromDataURL: vi.fn(),
  nativeTheme: {
    source: 'system' as 'dark' | 'light' | 'system',
    systemDark: true,
    assignments: [] as Array<'dark' | 'light' | 'system'>,
  },
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  session: { webRequest: { onBeforeSendHeaders: vi.fn() } },
  window: undefined as undefined | {
    messageHooks: Map<number, () => void>
    webContents: EventEmitter & {
      mainFrame: {
        framesInSubtree: unknown[]
        parent: null
        url: string
        isDestroyed: () => boolean
        executeJavaScript: ReturnType<typeof vi.fn>
      }
      send: ReturnType<typeof vi.fn>
      copyImageAt: ReturnType<typeof vi.fn>
      copy: ReturnType<typeof vi.fn>
      openDevTools: ReturnType<typeof vi.fn>
      inspectElement: ReturnType<typeof vi.fn>
    }
  },
}))

// The DevTools host's native window lifecycle is covered by browser-devtools.spec.ts.
vi.mock('../src/main/browser-devtools.js', () => ({
  BrowserDevToolsController: class {
    setTheme(): void {}
    open(contents: { openDevTools(options: { mode: string }): void }): void {
      contents.openDevTools({ mode: 'detach' })
    }
  },
}))

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events')

  class MockWebContents extends MockEventEmitter {
    session = electronMocks.session
    mainFrame = {
      framesInSubtree: [],
      parent: null,
      url: 'file:///desktop-shell/index.html',
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async () => true),
    }
    send = vi.fn()
    copyImageAt = vi.fn()
    undo = vi.fn()
    redo = vi.fn()
    cut = vi.fn()
    copy = vi.fn()
    paste = vi.fn()
    selectAll = vi.fn()
    setWindowOpenHandler = vi.fn()
    closeDevTools = vi.fn()
    openDevTools = vi.fn()
    inspectElement = vi.fn()
    // A Harness subframe can still report loading after the desktop shell is
    // ready. State publication must only be gated on the main frame.
    isLoading(): boolean { return true }
    isLoadingMainFrame(): boolean { return false }
    isDestroyed(): boolean { return false }
  }

  class MockBrowserWindow extends MockEventEmitter {
    webContents = new MockWebContents()
    readonly messageHooks = new Map<number, () => void>()
    hookWindowMessage(message: number, callback: () => void): void { this.messageHooks.set(message, callback) }

    constructor() {
      super()
      electronMocks.window = this
    }

    async loadFile(): Promise<void> {}
    async loadURL(): Promise<void> {}
    show(): void {}
    focus(): void {}
    isDestroyed(): boolean { return false }
    isMinimized(): boolean { return false }
    isMaximized(): boolean { return false }
    getContentSize(): [number, number] { return [1280, 720] }
  }

  return {
    app: {
      isPackaged: false,
      getAppPath: () => process.cwd(),
      getVersion: () => '0.1.0',
      quit: electronMocks.appQuit,
    },
    BrowserWindow: MockBrowserWindow,
    clipboard: {
      writeImage: electronMocks.clipboardWriteImage,
      writeText: electronMocks.clipboardWriteText,
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        electronMocks.ipcHandlers.set(channel, handler)
      }),
    },
    nativeTheme: {
      get themeSource() { return electronMocks.nativeTheme.source },
      set themeSource(value: 'dark' | 'light' | 'system') {
        electronMocks.nativeTheme.source = value
        electronMocks.nativeTheme.assignments.push(value)
      },
      get shouldUseDarkColors() {
        return electronMocks.nativeTheme.source === 'system'
          ? electronMocks.nativeTheme.systemDark : electronMocks.nativeTheme.source === 'dark'
      },
    },
    nativeImage: {
      createFromDataURL: electronMocks.nativeImageCreateFromDataURL.mockReturnValue(electronMocks.clipboardImage),
    },
    shell: { openExternal: electronMocks.shellOpenExternal, openPath: electronMocks.shellOpenPath },
  }
})

import {
  parseHarnessThemePreference,
  resolveHarnessReleaseUrl,
  resolveHarnessThemePreference,
  WindowController,
} from '../src/main/window-controller.js'
import { RUNTIME_PREPARATION_PROGRESS_EVENT } from '../src/main/harness-runtime.js'
import { DESKTOP_CONTEXT_MENU_TRANSPORT_KEY } from '../src/shared/context-menu.js'

beforeEach(() => {
  electronMocks.nativeTheme.source = 'system'
  electronMocks.nativeTheme.systemDark = true
  electronMocks.nativeTheme.assignments.length = 0
})

describe('Harness cookie request filtering lifecycle', () => {
  it('installs once per session and follows renderer initialization and Harness restarts', async () => {
    const install = electronMocks.session.webRequest.onBeforeSendHeaders
    install.mockClear()
    const runtime = Object.assign(new EventEmitter(), { harnessHome: '/unused-cookie-test', updateState: { status: 'idle' } })
    const development = Object.assign(new EventEmitter(), { state: {} })
    const rendererOrigin = 'http://127.0.0.1:5173'
    const controller = new WindowController(runtime as never, development as never, undefined, undefined, undefined, `${rendererOrigin}/index.html`)
    await controller.create()
    const access = controller as unknown as { harnessOrigin: string | undefined; rendererOrigin: string | undefined }
    const listener = install.mock.calls[0]![1] as (details: { url: string; requestHeaders: Record<string, string> }, callback: (response: { requestHeaders: Record<string, string> }) => void) => void
    const first = 'dsh-auth-GdnvWnHsqPBuURQ6GdTsylBQ2BjQ73m51nwsCdhyxQg'
    const second = 'dsh-auth-k9QMkgXfUt6dTouRVZ_kTn_n6v1ror0iRht9B8X_Xuw'
    const headers = { Cookie: `${first}=first; ${second}=second` }
    const send = (url: string) => {
      const callback = vi.fn()
      listener({ url, requestHeaders: headers }, callback)
      expect(callback).toHaveBeenCalledOnce()
      return callback.mock.calls[0]![0].requestHeaders
    }
    expect(access.harnessOrigin).toBeUndefined()
    expect(access.rendererOrigin).toBe(rendererOrigin)
    expect(send(`${rendererOrigin}/index.html`)).toEqual({})

    access.harnessOrigin = 'http://127.0.0.1:43123'
    expect(send(`${access.harnessOrigin}/api/client`)).toEqual({ Cookie: `${first}=first` })
    access.harnessOrigin = 'http://127.0.0.1:43124'
    expect(send(`${access.harnessOrigin}/api/client`)).toEqual({ Cookie: `${second}=second` })
    expect(send('http://127.0.0.1:43123/api/client')).toBe(headers)
    await controller.create()
    ;(electronMocks.window as unknown as EventEmitter).emit('closed')
    await controller.create()
    expect(install).toHaveBeenCalledOnce()
    expect(send(`${access.harnessOrigin}/api/client`)).toEqual({ Cookie: `${second}=second` })
  })
})

describe('notification approval dispatch', () => {
  async function fixture() {
    const runtime = Object.assign(new EventEmitter(), { harnessHome: '/unused', updateState: { status: 'idle' } })
    const development = Object.assign(new EventEmitter(), { state: {} })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()
    const origin = 'http://127.0.0.1:43123'
    ;(controller as unknown as { harnessOrigin: string }).harnessOrigin = origin
    const answer = vi.fn(async () => 'answered')
    const globals = {
      location: { origin },
      window: { [Symbol.for('dsh.desktop.notification-approval.transport.v1')]: { answer } },
    }
    const frame = {
      parent: {}, name: 'harness-frame', url: origin, isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => await runInNewContext(script, globals)),
    }
    electronMocks.window!.webContents.mainFrame.framesInSubtree = [frame]
    const request = { sessionId: 'session-test', token: '6bc18d64-6f28-4fc9-9d29-1d19c2d9aef1', interactionKey: 'approval:1' }
    return { controller, answer, globals, frame, request }
  }

  it.each(['allowed-once', 'rejected'] as const)('dispatches %s through the exact Harness transport without opening a session', async (decision) => {
    const { controller, request, answer, frame } = await fixture()
    const focus = vi.spyOn(controller, 'focus')
    await expect(controller.answerNotificationApproval(request, decision)).resolves.toBe('answered')
    expect(answer).toHaveBeenCalledWith({ ...request, decision })
    expect(focus).not.toHaveBeenCalled()
    expect(frame.executeJavaScript).not.toHaveBeenCalledWith(expect.stringContaining('postMessage'))
  })

  it('rejects a named frame on another origin and a document that navigates before dispatch', async () => {
    const { controller, request, frame, globals, answer } = await fixture()
    frame.url = 'https://unrelated.example'
    await expect(controller.answerNotificationApproval(request, 'allowed-once')).resolves.toBe('expired')
    expect(frame.executeJavaScript).not.toHaveBeenCalled()
    frame.url = 'http://127.0.0.1:43123'
    globals.location.origin = 'https://unrelated.example'
    await expect(controller.answerNotificationApproval(request, 'allowed-once')).resolves.toBe('expired')
    expect(answer).not.toHaveBeenCalled()
  })

  it('handles absent, expired, and failing transports without treating them as an approval', async () => {
    const { controller, request, globals, answer } = await fixture()
    answer.mockResolvedValueOnce('expired')
    await expect(controller.answerNotificationApproval(request, 'rejected')).resolves.toBe('expired')
    answer.mockRejectedValueOnce(new Error('Approval connection lost'))
    await expect(controller.answerNotificationApproval(request, 'rejected')).rejects.toThrow('Approval connection lost')
    Reflect.deleteProperty(globals.window, Symbol.for('dsh.desktop.notification-approval.transport.v1'))
    await expect(controller.answerNotificationApproval(request, 'allowed-once')).resolves.toBe('expired')
    electronMocks.window!.webContents.mainFrame.framesInSubtree = []
    await expect(controller.answerNotificationApproval(request, 'allowed-once')).resolves.toBe('expired')
  })

  it('serializes request identifiers as data and rejects other permission decisions', async () => {
    const { controller, request, answer } = await fixture()
    const payload = { ...request, interactionKey: 'approval:\"); throw Error("injected"); //' }
    await expect(controller.answerNotificationApproval(payload, 'rejected')).resolves.toBe('answered')
    expect(answer).toHaveBeenCalledWith({ ...payload, decision: 'rejected' })
    answer.mockClear()
    await expect(controller.answerNotificationApproval(request, 'allowed-always' as never)).resolves.toBe('expired')
    expect(answer).not.toHaveBeenCalled()
  })
})

describe('image menu discovery and dispatch', () => {
  async function imageMenuFixture() {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/existing-harness', updateState: { status: 'idle' }, checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
    })
    const browser = Object.assign(new EventEmitter(), {
      state: { settings: { enabled: true } }, setTheme: vi.fn(), attachWindow: vi.fn(),
      closeMenu: vi.fn(), openContextMenu: vi.fn(async () => true), updateContextMenu: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never, undefined, browser as never)
    await controller.create()
    const url = 'http://127.0.0.1:43219'
    const frame = { parent: {}, name: 'harness-frame', url, isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => script === 'document.readyState' ? 'complete' : null),
    }
    const window = electronMocks.window!
    window.webContents.mainFrame.framesInSubtree = [frame]
    await controller.showHarness(url, '0.1.5-alpha.2')
    const params = {
      frame, frameURL: url, x: 20, y: 40, linkURL: '', srcURL: `blob:${url}/image`,
      selectionText: '', mediaType: 'image', hasImageContents: true, isEditable: false,
      editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false,
        canPaste: false, canDelete: false, canSelectAll: true, canEditRichly: false },
    }
    const open = () => window.webContents.emit('context-menu', { preventDefault: vi.fn() }, params)
    const menus = () => window.webContents.send.mock.calls.filter(([channel]) => channel === 'desktop:context-menu')
    return { controller, browser, frame, window, params, open, menus }
  }

  it('shows one stable fallback menu when original-file lookup is slow', async () => {
    const fixture = await imageMenuFixture()
    let resolvePath!: (path: string) => void
    imageActionMocks.findContextMenuImagePath.mockImplementationOnce(() => new Promise((resolve) => { resolvePath = resolve }))
    fixture.open()
    expect(fixture.menus()).toHaveLength(0)
    await vi.waitFor(() => expect(fixture.menus()).toHaveLength(1), { timeout: 1500 })
    expect(fixture.menus()[0]![1].items.map((item: { id: string }) => item.id))
      .toEqual(['desktop.copy-image', 'desktop.save-image'])
    resolvePath('/existing/late-original.png')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.menus()).toHaveLength(1)
  })

  it.each(['pointer', 'escape', 'navigation', 'native-titlebar'] as const)('does not open a delayed image menu after %s', async (action) => {
    const fixture = await imageMenuFixture()
    let resolvePath!: (path: string) => void
    imageActionMocks.findContextMenuImagePath.mockImplementationOnce(() => new Promise((resolve) => { resolvePath = resolve }))
    fixture.open()
    if (action === 'pointer') fixture.window.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 50, y: 60 })
    else if (action === 'escape') fixture.window.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'Escape' })
    else if (action === 'native-titlebar') {
      if (process.platform === 'win32') fixture.window.messageHooks.get(0x00a1)!()
      else (fixture.window as unknown as EventEmitter).emit('will-move', { preventDefault: vi.fn() })
    }
    else fixture.window.webContents.emit('did-start-navigation', {})
    resolvePath('/existing/original.png')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.menus()).toHaveLength(0)
    expect(fixture.window.webContents.listenerCount('did-start-navigation')).toBe(0)
  })

  it('closes both menu presentations and expires the pending action on a native title-bar interaction', async () => {
    const fixture = await imageMenuFixture()
    fixture.open()
    await vi.waitFor(() => expect(fixture.menus()).toHaveLength(1))
    const request = fixture.menus()[0]![1]
    fixture.browser.closeMenu.mockClear()
    fixture.browser.closeMenu.mockReturnValueOnce(request.requestId)
    if (process.platform === 'win32') fixture.window.messageHooks.get(0x00a1)!()
    else (fixture.window as unknown as EventEmitter).emit('will-move', { preventDefault: vi.fn() })
    expect(fixture.browser.closeMenu).toHaveBeenCalledOnce()
    expect(fixture.window.webContents.send).toHaveBeenCalledWith('desktop:pointer-input', { x: -1, y: -1, button: 'left' })
    imageActionMocks.saveContextMenuImage.mockClear()
    await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(
      { sender: fixture.window.webContents }, { requestId: request.requestId, itemId: 'desktop.save-image' },
    )
    expect(imageActionMocks.saveContextMenuImage).not.toHaveBeenCalled()
  })

  it('does not restore page focus when a floating menu is dismissed by a native window interaction', async () => {
    const fixture = await imageMenuFixture()
    fixture.open()
    await vi.waitFor(() => expect(fixture.menus()).toHaveLength(1))
    const request = fixture.menus()[0]![1]
    fixture.frame.executeJavaScript.mockClear()
    fixture.browser.emit('context-menu-dismiss', request.requestId, false)
    await Promise.resolve()
    expect(fixture.frame.executeJavaScript).not.toHaveBeenCalled()
    imageActionMocks.saveContextMenuImage.mockClear()
    await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(
      { sender: fixture.window.webContents }, { requestId: request.requestId, itemId: 'desktop.save-image' },
    )
    expect(imageActionMocks.saveContextMenuImage).not.toHaveBeenCalled()
  })

  it('keeps a newer right-click menu when an earlier image lookup finishes', async () => {
    const fixture = await imageMenuFixture()
    let resolvePath!: (path: string) => void
    imageActionMocks.findContextMenuImagePath.mockImplementationOnce(() => new Promise((resolve) => { resolvePath = resolve }))
    fixture.open()
    imageActionMocks.findContextMenuImagePath.mockResolvedValueOnce('/existing/newer.png')
    fixture.open()
    await vi.waitFor(() => expect(fixture.menus()).toHaveLength(1))
    resolvePath('/existing/older.png')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.menus()).toHaveLength(1)
    const select = electronMocks.ipcHandlers.get('desktop:context-menu-select')!
    await select({ sender: fixture.window.webContents }, { requestId: fixture.menus()[0]![1].requestId, itemId: 'desktop.reveal-image' })
    expect(imageActionMocks.revealContextMenuImage).toHaveBeenLastCalledWith('/existing/newer.png')
  })

  it('opens an embedded-browser image menu with its final rows on the first request', async () => {
    const fixture = await imageMenuFixture()
    let resolvePath!: (path: string) => void
    imageActionMocks.findContextMenuImagePath.mockImplementationOnce(() => new Promise((resolve) => { resolvePath = resolve }))
    fixture.browser.emit('context-menu', { ...fixture.params, srcURL: 'file:///existing/original.png' }, fixture.window.webContents, 'page')
    expect(fixture.browser.openContextMenu).not.toHaveBeenCalled()
    resolvePath('/existing/original.png')
    await vi.waitFor(() => expect(fixture.browser.openContextMenu).toHaveBeenCalledTimes(1))
    expect(fixture.browser.openContextMenu).toHaveBeenCalledWith(expect.objectContaining({
      items: [
        expect.objectContaining({ id: 'desktop.copy-image' }),
        expect.objectContaining({ id: 'desktop.reveal-image' }),
        expect.objectContaining({ id: 'desktop.save-image' }),
        { kind: 'separator', id: 'desktop.separator.inspect' },
        expect.objectContaining({ id: 'desktop.inspect-element' }),
      ],
    }), 'page')
    expect(fixture.browser.updateContextMenu).not.toHaveBeenCalled()
  })

  it('expires the iframe menu and late plugin contributions on a browser-page click', async () => {
    const fixture = await imageMenuFixture()
    let finishPlugins!: (value: unknown) => void
    fixture.frame.executeJavaScript.mockImplementation(async (script: string) => script.includes('?.collect?.()')
      ? await new Promise((resolve) => { finishPlugins = resolve }) : null)
    fixture.window.webContents.emit('context-menu', { preventDefault: vi.fn() }, {
      ...fixture.params, srcURL: '', mediaType: 'none', hasImageContents: false,
    })
    const old = fixture.menus().at(-1)![1]
    fixture.window.webContents.send.mockClear()
    fixture.browser.emit('menu-interaction')
    expect(fixture.window.webContents.send).toHaveBeenCalledWith('desktop:pointer-input', { x: -1, y: -1, button: 'left' })
    finishPlugins({ token: 'late-iframe-plugin', items: [{ kind: 'item', id: 'plugin.inspect', label: '检查', enabled: true }] })
    await vi.waitFor(() => expect(fixture.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('?.dismiss?.("late-iframe-plugin", false)')))
    expect(fixture.menus()).toHaveLength(0)
    fixture.browser.closeMenu.mockClear()
    await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(
      { sender: fixture.window.webContents }, { requestId: old.requestId, itemId: 'desktop.select-all' },
    )
    expect(fixture.browser.closeMenu).not.toHaveBeenCalled()
  })

  it('replaces the iframe menu with a browser menu and ignores stale dismiss/select without disabling its items', async () => {
    const fixture = await imageMenuFixture()
    const params = { ...fixture.params, srcURL: '', mediaType: 'none', hasImageContents: false }
    fixture.window.webContents.emit('context-menu', { preventDefault: vi.fn() }, params)
    const old = fixture.menus().at(-1)![1]
    fixture.window.webContents.send.mockClear()
    fixture.browser.emit('context-menu', params, fixture.window.webContents, 'page')
    await vi.waitFor(() => expect(fixture.browser.openContextMenu).toHaveBeenCalledOnce())
    const current = fixture.browser.openContextMenu.mock.calls[0]![0] as { requestId: string }
    expect(current.requestId).not.toBe(old.requestId)
    expect(fixture.window.webContents.send).toHaveBeenCalledWith('desktop:pointer-input', { x: -1, y: -1, button: 'left' })
    fixture.browser.closeMenu.mockClear()
    const sender = { sender: fixture.window.webContents }
    await electronMocks.ipcHandlers.get('desktop:context-menu-dismiss')!(sender, old.requestId, false)
    await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(sender, { requestId: old.requestId, itemId: 'desktop.select-all' })
    expect(fixture.browser.closeMenu).not.toHaveBeenCalled()
    fixture.frame.executeJavaScript.mockClear()
    await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(sender, { requestId: current.requestId, itemId: 'desktop.select-all' })
    expect(fixture.browser.closeMenu).toHaveBeenCalledOnce()
    expect(fixture.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('document.execCommand("selectAll")'))
  })

  it('replaces a browser menu with an iframe menu and keeps the new menu after an old overlay dismiss', async () => {
    const fixture = await imageMenuFixture()
    const params = { ...fixture.params, srcURL: '', mediaType: 'none', hasImageContents: false }
    fixture.browser.emit('context-menu', params, fixture.window.webContents, 'page')
    await vi.waitFor(() => expect(fixture.browser.openContextMenu).toHaveBeenCalledOnce())
    const old = fixture.browser.openContextMenu.mock.calls[0]![0] as { requestId: string }
    fixture.browser.closeMenu.mockClear()
    fixture.window.webContents.emit('context-menu', { preventDefault: vi.fn() }, params)
    const current = fixture.menus().at(-1)![1]
    expect(fixture.browser.closeMenu).toHaveBeenCalledOnce()
    await electronMocks.ipcHandlers.get('desktop:context-menu-dismiss')!({ sender: fixture.window.webContents }, old.requestId, false)
    expect(fixture.browser.closeMenu).toHaveBeenCalledOnce()
    fixture.frame.executeJavaScript.mockClear()
    await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(
      { sender: fixture.window.webContents }, { requestId: current.requestId, itemId: 'desktop.select-all' },
    )
    expect(fixture.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('document.execCommand("selectAll")'))
  })

  it('claims a shell page menu only for the shell and cancels an image menu that has not finished opening', async () => {
    const fixture = await imageMenuFixture()
    let finishPath!: (value: string) => void
    imageActionMocks.findContextMenuImagePath.mockImplementationOnce(() => new Promise((resolve) => { finishPath = resolve }))
    fixture.open()
    const claim = electronMocks.ipcHandlers.get('desktop:claim-shell-menu')!
    fixture.browser.closeMenu.mockClear()
    await claim({ sender: {} })
    expect(fixture.browser.closeMenu).not.toHaveBeenCalled()
    fixture.window.webContents.send.mockClear()
    await claim({ sender: fixture.window.webContents })
    expect(fixture.browser.closeMenu).toHaveBeenCalledOnce()
    expect(fixture.window.webContents.send).not.toHaveBeenCalled()
    finishPath('/existing/cancelled.png')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.menus()).toHaveLength(0)
  })

  it.each(['image-first', 'plugin-first'] as const)('keeps original-file and plugin actions when %s finishes', async (order) => {
    let resolvePath!: (path: string | undefined) => void
    let resolvePlugin!: (collection: unknown) => void
    imageActionMocks.findContextMenuImagePath.mockImplementationOnce(() => new Promise((resolve) => { resolvePath = resolve }))
    const collection = new Promise((resolve) => { resolvePlugin = resolve })
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/existing-harness', updateState: { status: 'idle' }, checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()
    const url = 'http://127.0.0.1:43219'
    const frame = { parent: {}, name: 'harness-frame', url, isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => {
        if (script === 'document.readyState') return 'complete'
        if (script.includes('?.collect?.()')) return collection
        return null
      }),
    }
    const window = electronMocks.window!
    window.webContents.mainFrame.framesInSubtree = [frame]
    await controller.showHarness(url, '0.1.5-alpha.1')
    const params = {
      frame, frameURL: url, x: 20, y: 40, linkURL: '', srcURL: `blob:${url}/image`,
      selectionText: '', mediaType: 'image', hasImageContents: true, isEditable: false,
      editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false,
        canPaste: false, canDelete: false, canSelectAll: true, canEditRichly: false },
    }
    window.webContents.emit('context-menu', { preventDefault: vi.fn() }, params)
    const menus = () => window.webContents.send.mock.calls.filter(([channel]) => channel === 'desktop:context-menu')
    const plugin = { token: 'image-plugin-token', items: [{ kind: 'item', id: 'plugin.inspect', label: '检查', enabled: true }] }
    expect(menus()).toHaveLength(0)
    if (order === 'image-first') {
      resolvePath('/existing/original.png')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(menus()).toHaveLength(0)
      resolvePlugin(plugin)
    } else {
      resolvePlugin(plugin)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(menus()).toHaveLength(0)
      resolvePath('/existing/original.png')
    }
    await vi.waitFor(() => {
      expect(menus()).toHaveLength(1)
      const ids = menus().at(-1)![1].items.map((item: { id: string }) => item.id)
      expect(ids).toContain('plugin.inspect')
      expect(ids.filter((id: string) => id === 'desktop.reveal-image')).toHaveLength(1)
    })
    const first = menus()[0]![1]
    const select = electronMocks.ipcHandlers.get('desktop:context-menu-select')!
    await select({ sender: window.webContents }, { requestId: first.requestId, itemId: 'desktop.reveal-image' })
    expect(imageActionMocks.revealContextMenuImage).toHaveBeenCalledWith('/existing/original.png')

    // Memory-only images still dispatch an explicit save through the source frame.
    window.webContents.emit('context-menu', { preventDefault: vi.fn() }, params)
    await vi.waitFor(() => expect(menus()).toHaveLength(2))
    const memory = menus().at(-1)![1]
    await select({ sender: window.webContents }, { requestId: memory.requestId, itemId: 'desktop.save-image' })
    expect(imageActionMocks.saveContextMenuImage).toHaveBeenCalledWith(expect.objectContaining({ frame, srcURL: params.srcURL }), window)
  })
})

describe('browser page element inspection', () => {
  async function fixture() {
    const runtime = Object.assign(new EventEmitter(), { harnessHome: '/unused', updateState: { status: 'idle' } })
    const development = Object.assign(new EventEmitter(), { state: {} })
    const browser = Object.assign(new EventEmitter(), {
      state: { settings: { enabled: true }, activeTabId: 'original-page' },
      setTheme: vi.fn(), attachWindow: vi.fn(), closeMenu: vi.fn(),
      openContextMenu: vi.fn(async (_request: unknown, _source: unknown) => true),
      ownsMenuWebContents: vi.fn(() => false),
    })
    const controller = new WindowController(runtime as never, development as never, undefined, browser as never)
    await controller.create()
    const window = electronMocks.window!
    const frame = {
      parent: null as unknown, url: 'https://page.example/',
      isDestroyed: vi.fn(() => false), executeJavaScript: vi.fn(async () => null),
    }
    const contents = Object.assign(new EventEmitter(), {
      mainFrame: frame, isDestroyed: vi.fn(() => false),
      openDevTools: vi.fn(), inspectElement: vi.fn(),
    })
    const params = {
      frame, frameURL: frame.url, x: 47, y: 83, linkURL: '', srcURL: '',
      selectionText: '', mediaType: 'none', hasImageContents: false, isEditable: false,
      editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false,
        canPaste: false, canDelete: false, canSelectAll: true, canEditRichly: false },
    }
    const open = async (source: 'page' | 'floating' = 'page') => {
      const before = browser.openContextMenu.mock.calls.length
      browser.emit('context-menu', params, contents, source)
      await vi.waitFor(() => expect(browser.openContextMenu).toHaveBeenCalledTimes(before + 1))
      return browser.openContextMenu.mock.calls.at(-1)![0] as { requestId: string; items: Array<{ id: string }> }
    }
    const select = async (requestId: string) => await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(
      { sender: window.webContents }, { requestId, itemId: 'desktop.inspect-element' },
    )
    return { browser, controller, window, frame, contents, params, open, select }
  }

  it.each([[47, 83], [0, 0]])('inspects the original page at %s,%s after another tab becomes active', async (x, y) => {
    const target = await fixture()
    target.params.x = x
    target.params.y = y
    const menu = await target.open()
    expect(menu.items.at(-1)).toMatchObject({ id: 'desktop.inspect-element', label: '检查', icon: 'inspect', enabled: true })
    target.browser.state.activeTabId = 'different-page'
    target.params.x = 900
    target.params.y = 700
    await target.select(menu.requestId)
    expect(target.contents.openDevTools).toHaveBeenCalledExactlyOnceWith({ mode: 'detach' })
    expect(target.contents.inspectElement).toHaveBeenCalledExactlyOnceWith(x, y)
    expect(target.contents.openDevTools.mock.invocationCallOrder[0]!)
      .toBeLessThan(target.contents.inspectElement.mock.invocationCallOrder[0]!)
    expect(target.window.webContents.openDevTools).not.toHaveBeenCalled()
    expect(target.window.webContents.inspectElement).not.toHaveBeenCalled()
    expect(target.frame.executeJavaScript).not.toHaveBeenCalled()
    await target.select(menu.requestId)
    expect(target.contents.inspectElement).toHaveBeenCalledOnce()
  })

  it('keeps subframe inspection coordinates on the owning browser WebContents', async () => {
    const target = await fixture()
    target.frame.parent = { url: 'https://parent.example/' }
    const menu = await target.open()
    await target.select(menu.requestId)
    expect(target.contents.inspectElement).toHaveBeenCalledExactlyOnceWith(47, 83)
    expect(target.frame.executeJavaScript).not.toHaveBeenCalled()
  })

  it('does not offer or execute inspection in a floating address bar', async () => {
    const target = await fixture()
    target.params.isEditable = true
    const menu = await target.open('floating')
    expect(menu.items.some((item) => item.id === 'desktop.inspect-element')).toBe(false)
    await target.select(menu.requestId)
    expect(target.contents.openDevTools).not.toHaveBeenCalled()
    expect(target.contents.inspectElement).not.toHaveBeenCalled()
  })

  it.each(['shell', 'harness'] as const)('does not offer or execute inspection for the %s context-menu path', async (source) => {
    const target = await fixture()
    const frame = source === 'shell' ? target.window.webContents.mainFrame : target.frame
    if (source === 'harness') {
      target.frame.parent = {}
      ;(target.controller as unknown as { harnessOrigin: string }).harnessOrigin = new URL(target.frame.url).origin
    }
    target.window.webContents.emit('context-menu', { preventDefault: vi.fn() }, {
      ...target.params, frame, isEditable: source === 'shell',
    })
    const sent = target.window.webContents.send.mock.calls.find(([channel]) => channel === 'desktop:context-menu')!
    expect(sent).toBeDefined()
    const menu = sent[1] as { requestId: string; items: Array<{ id: string }> }
    expect(menu.items.some((item) => item.id === 'desktop.inspect-element')).toBe(false)
    await target.select(menu.requestId)
    expect(target.window.webContents.openDevTools).not.toHaveBeenCalled()
    expect(target.contents.openDevTools).not.toHaveBeenCalled()
  })

  it.each([[NaN, 5], [5, Infinity], [-1, 5], [5, 1.5], [2_147_483_648, 5]])('ignores invalid inspection coordinates %s,%s', async (x, y) => {
    const target = await fixture()
    target.params.x = x
    target.params.y = y
    const menu = await target.open()
    await target.select(menu.requestId)
    expect(target.contents.openDevTools).not.toHaveBeenCalled()
    expect(target.contents.inspectElement).not.toHaveBeenCalled()
  })

  it.each(['contents', 'frame'] as const)('ignores a destroyed %s after the menu opens', async (part) => {
    const target = await fixture()
    const menu = await target.open()
    target[part].isDestroyed.mockReturnValue(true)
    await target.select(menu.requestId)
    expect(target.contents.openDevTools).not.toHaveBeenCalled()
    expect(target.contents.inspectElement).not.toHaveBeenCalled()
  })

  it('does not inspect a page destroyed while DevTools opens', async () => {
    const target = await fixture()
    const menu = await target.open()
    target.contents.openDevTools.mockImplementation(() => target.contents.isDestroyed.mockReturnValue(true))
    await target.select(menu.requestId)
    expect(target.contents.openDevTools).toHaveBeenCalledOnce()
    expect(target.contents.inspectElement).not.toHaveBeenCalled()
  })

  it('ignores an old menu after a new right-click replaces its target', async () => {
    const target = await fixture()
    const first = await target.open()
    target.params.x = 120
    target.params.y = 180
    const latest = await target.open()
    await target.select(first.requestId)
    expect(target.contents.openDevTools).not.toHaveBeenCalled()
    await target.select(latest.requestId)
    expect(target.contents.inspectElement).toHaveBeenCalledExactlyOnceWith(120, 180)
  })
})

describe('Harness theme preference parsing', () => {
  it('recognizes explicit and system preferences without matching unrelated settings', () => {
    expect(parseHarnessThemePreference('ui-theme:\n  preference: system\n')).toBe('system')
    expect(parseHarnessThemePreference('ui-theme:\r\n  preference: "dark" # keep\r\n')).toBe('dark')
    expect(parseHarnessThemePreference('other:\n  preference: light\n')).toBeUndefined()
  })

  it('resolves only the system preference through the operating-system scheme', () => {
    expect(resolveHarnessThemePreference('system', false)).toBe('light')
    expect(resolveHarnessThemePreference('system', true)).toBe('dark')
    expect(resolveHarnessThemePreference('light', true)).toBe('light')
    expect(resolveHarnessThemePreference('dark', false)).toBe('dark')
  })
})

describe('configured native theme synchronization', () => {
  function fixture() {
    const runtime = Object.assign(new EventEmitter(), { harnessHome: '/unused-theme-test', updateState: { status: 'idle' } })
    const development = Object.assign(new EventEmitter(), { state: {} })
    const browser = Object.assign(new EventEmitter(), { setTheme: vi.fn(), state: { settings: { enabled: true } } })
    const controller = new WindowController(runtime as never, development as never, undefined, browser as never)
    const access = controller as unknown as {
      readConfiguredThemePreference(): Promise<'dark' | 'light' | 'system'>
      readConfiguredTheme(): Promise<'dark' | 'light'>
      findHarnessFrame(): unknown
      startThemeSync(): void
      stopThemeSync(): void
    }
    const preference = vi.spyOn(access, 'readConfiguredThemePreference').mockResolvedValue('system')
    return { access, preference, browser }
  }

  it.each(['dark', 'light'] as const)('synchronizes explicit %s preference to native windows without redundant assignments', async (theme) => {
    electronMocks.nativeTheme.systemDark = theme === 'light'
    const { access, preference } = fixture()
    preference.mockResolvedValue(theme)
    await expect(access.readConfiguredTheme()).resolves.toBe(theme)
    expect(electronMocks.nativeTheme.source).toBe(theme)
    expect(electronMocks.nativeTheme.assignments).toEqual([theme])
    await expect(access.readConfiguredTheme()).resolves.toBe(theme)
    expect(electronMocks.nativeTheme.assignments).toEqual([theme])
  })

  it.each([
    ['dark', false, 'light'], ['light', true, 'dark'],
  ] as const)('replaces a %s override with OS colors when switching to system', async (override, systemDark, expected) => {
    electronMocks.nativeTheme.systemDark = systemDark
    const { access, preference } = fixture()
    preference.mockResolvedValue(override)
    await expect(access.readConfiguredTheme()).resolves.toBe(override)
    preference.mockResolvedValue('system')
    await expect(access.readConfiguredTheme()).resolves.toBe(expected)
    expect(electronMocks.nativeTheme.source).toBe('system')
    expect(electronMocks.nativeTheme.assignments).toEqual([override, 'system'])
  })

  it('responds to later operating-system changes while the preference remains system', async () => {
    const { access } = fixture()
    electronMocks.nativeTheme.systemDark = false
    await expect(access.readConfiguredTheme()).resolves.toBe('light')
    electronMocks.nativeTheme.systemDark = true
    await expect(access.readConfiguredTheme()).resolves.toBe('dark')
    electronMocks.nativeTheme.systemDark = false
    await expect(access.readConfiguredTheme()).resolves.toBe('light')
    expect(electronMocks.nativeTheme.source).toBe('system')
    expect(electronMocks.nativeTheme.assignments).toEqual([])
  })

  it('uses the synchronized native theme when the immediate Harness probe switches back to system', async () => {
    electronMocks.nativeTheme.source = 'light'
    electronMocks.nativeTheme.systemDark = true
    const { access, browser } = fixture()
    const readTheme = vi.spyOn(access, 'readConfiguredTheme')
    const frame = vi.spyOn(access, 'findHarnessFrame').mockReturnValue({})
    const schedule = vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as never)
    const unschedule = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    try {
      access.startThemeSync()
      expect(readTheme).toHaveBeenCalledOnce()
      await readTheme.mock.results[0]!.value
      expect(electronMocks.nativeTheme.source).toBe('system')
      expect(browser.setTheme).toHaveBeenCalledExactlyOnceWith('dark')
    } finally {
      access.stopThemeSync()
      frame.mockRestore()
      readTheme.mockRestore()
      schedule.mockRestore()
      unschedule.mockRestore()
    }
  })
})

describe('Harness release URL', () => {
  it('targets the official GitHub Release matching the running Harness version', () => {
    expect(resolveHarnessReleaseUrl('0.1.1-rc.1')).toBe(
      'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1',
    )
    expect(resolveHarnessReleaseUrl('dsh-v0.1.1-rc.1')).toBe(
      'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1',
    )
  })

  it('falls back to the releases list when no safe version is available', () => {
    expect(resolveHarnessReleaseUrl()).toBe('https://github.com/deepseek-ai/deepseek-harness/releases')
    expect(resolveHarnessReleaseUrl('../commits/master')).toBe('https://github.com/deepseek-ai/deepseek-harness/releases')
  })
})

describe('WindowController Harness reload', () => {
  it('checks, downloads, and opens a prepared desktop installer only on explicit actions', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle', versions: [] },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const desktopUpdates = Object.assign(new EventEmitter(), {
      state: { status: 'ready', version: '0.1.1' },
      releasesUrl: 'https://github.com/xiaoxiao44443/dfy-dsh-desktop/releases/tag/v0.1.1',
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      installerPath: vi.fn(async () => '/tmp/DFY-DSH-Desktop-0.1.1-macos-x64.dmg'),
    })
    const controller = new WindowController(
      runtime as never,
      development as never,
      undefined,
      undefined,
      undefined,
      undefined,
      desktopUpdates as never,
    )
    await controller.create()

    const sender = electronMocks.window?.webContents
    await electronMocks.ipcHandlers.get('desktop:check-application-update')?.({ sender })
    await electronMocks.ipcHandlers.get('desktop:download-application-update')?.({ sender })
    await electronMocks.ipcHandlers.get('desktop:open-application-release')?.({ sender })
    await electronMocks.ipcHandlers.get('desktop:install-application-update')?.({ sender })

    expect(desktopUpdates.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(desktopUpdates.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith(desktopUpdates.releasesUrl)
    expect(electronMocks.shellOpenPath).toHaveBeenCalledWith('/tmp/DFY-DSH-Desktop-0.1.1-macos-x64.dmg')
    expect(electronMocks.appQuit).toHaveBeenCalledTimes(1)
  })

  it('applies a prepared runtime by restarting only the Harness process', async () => {
    const restartHarness = vi.fn(async () => undefined)
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'ready', version: '0.1.2-alpha.2', versions: [] },
      checkForUpdates: vi.fn(),
      installHarnessVersion: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness,
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    await electronMocks.ipcHandlers.get('desktop:restart-update')?.({})
    await electronMocks.ipcHandlers.get('desktop:title-menu-action')?.({}, 'update')

    expect(restartHarness).toHaveBeenCalledTimes(2)
  })

  it('checks metadata without downloading and installs only the selected Harness version', async () => {
    const checkForUpdates = vi.fn(async () => undefined)
    const installHarnessVersion = vi.fn(async () => undefined)
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle', versions: [] },
      checkForUpdates,
      installHarnessVersion,
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    await electronMocks.ipcHandlers.get('desktop:check-update')?.({})
    await electronMocks.ipcHandlers.get('desktop:install-update-version')?.({}, '0.1.1-rc.1')
    if (electronMocks.window !== undefined) {
      await electronMocks.ipcHandlers.get('desktop:open-harness-release')?.(
        { sender: electronMocks.window.webContents },
        '0.1.1-rc.1',
      )
    }

    expect(checkForUpdates).toHaveBeenCalledWith({ download: false })
    expect(installHarnessVersion).toHaveBeenCalledWith('0.1.1-rc.1')
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith(
      'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1',
    )
  })

  it('publishes bundled runtime extraction progress only during preparation', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    controller.setRuntimePreparing()
    await controller.create()

    runtime.emit(RUNTIME_PREPARATION_PROGRESS_EVENT, 42)
    expect(electronMocks.window?.webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
      harnessLifecycle: 'starting',
      runtimePreparationProgress: 42,
    })

    controller.setHarnessStarting('0.1.0')
    expect(electronMocks.window?.webContents.send.mock.calls.at(-1)?.[1]).not.toHaveProperty(
      'runtimePreparationProgress',
    )
  })

  it('accepts main-process frame navigation and remounts a reused URL', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: {
        pnpmVersion: '11.19.0',
        restarting: false,
        commandRunning: false,
      },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    const window = electronMocks.window
    expect(window).toBeDefined()
    const url = 'http://127.0.0.1:43210/?token=development-secret'

    const firstLoad = controller.showHarness(url, '0.1.0')
    const firstStartingState = window?.webContents.send.mock.calls.at(-1)?.[1]
    expect(firstStartingState).toMatchObject({ harnessLoadId: 1, harnessLifecycle: 'starting' })
    window?.webContents.emit('did-frame-navigate', {}, url, 200, 'OK', false)
    await firstLoad

    const copyHarnessUrl = electronMocks.ipcHandlers.get('desktop:development-copy-harness-url')
    const openHarnessUrl = electronMocks.ipcHandlers.get('desktop:development-open-harness-url')
    expect(copyHarnessUrl).toBeDefined()
    expect(openHarnessUrl).toBeDefined()
    if (window !== undefined) {
      await copyHarnessUrl?.({ sender: window.webContents })
      await openHarnessUrl?.({ sender: window.webContents })
    }
    expect(electronMocks.clipboardWriteText).toHaveBeenCalledWith(url)
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith(url)

    const secondLoad = controller.showHarness(url, '0.1.0')
    const secondStartingState = window?.webContents.send.mock.calls.at(-1)?.[1]
    expect(secondStartingState).toMatchObject({ harnessLoadId: 2, harnessLifecycle: 'starting' })
    window?.webContents.emit('did-frame-navigate', {}, url, 200, 'OK', false)
    await secondLoad

    const readyState = window?.webContents.send.mock.calls.at(-1)?.[1]
    expect(readyState).toMatchObject({ harnessLoadId: 2, harnessLifecycle: 'ready' })
  })

  it('blocks keyboard reload shortcuts at the main window boundary', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    const commandReload = { preventDefault: vi.fn() }
    electronMocks.window?.webContents.emit('before-input-event', commandReload, {
      key: 'r',
      control: false,
      meta: true,
    })
    expect(commandReload.preventDefault).toHaveBeenCalledOnce()

    const f5Reload = { preventDefault: vi.fn() }
    electronMocks.window?.webContents.emit('before-input-event', f5Reload, {
      key: 'F5',
      control: false,
      meta: false,
    })
    expect(f5Reload.preventDefault).toHaveBeenCalledOnce()

    const plainR = { preventDefault: vi.fn() }
    electronMocks.window?.webContents.emit('before-input-event', plainR, {
      key: 'r',
      control: false,
      meta: false,
    })
    expect(plainR.preventDefault).not.toHaveBeenCalled()
  })

  it('opens the core context menu without a Harness client plugin', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    const url = 'http://127.0.0.1:43213'
    const frame = {
      parent: {},
      name: 'harness-frame',
      url,
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => {
        if (script === 'document.readyState') return 'complete'
        if (script.includes("canvas.toDataURL('image/png')")) return 'data:image/png;base64,Y29waWVkLWltYWdl'
        return null
      }),
    }
    const window = electronMocks.window
    expect(window).toBeDefined()
    if (window !== undefined) window.webContents.mainFrame.framesInSubtree = [frame]
    await controller.showHarness(url, '0.1.0')

    const contextEvent = { preventDefault: vi.fn() }
    window?.webContents.emit('context-menu', contextEvent, {
      x: 320,
      y: 240,
      frame,
      frameURL: url,
      linkURL: '',
      selectionText: 'selected text',
      isEditable: false,
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    })

    await vi.waitFor(() => {
      expect(window?.webContents.send.mock.calls.some(([channel]) => channel === 'desktop:context-menu')).toBe(true)
    })
    expect(contextEvent.preventDefault).toHaveBeenCalledOnce()
    const request = window?.webContents.send.mock.calls.find(([channel]) => channel === 'desktop:context-menu')?.[1]
    expect(request).toMatchObject({
      x: 320,
      y: 240,
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'desktop.copy', enabled: true }),
        expect.objectContaining({ id: 'desktop.select-all', enabled: true }),
      ]),
    })
    const select = electronMocks.ipcHandlers.get('desktop:context-menu-select')
    expect(select).toBeDefined()
    if (select !== undefined && window !== undefined && request !== undefined) {
      await select({ sender: window.webContents }, { requestId: request.requestId, itemId: 'desktop.copy' })
    }
    expect(electronMocks.clipboardWriteText).toHaveBeenCalledWith('selected text')

    window?.webContents.emit('context-menu', { preventDefault: vi.fn() }, {
      x: 96,
      y: 128,
      frame,
      frameURL: url,
      linkURL: '',
      srcURL: 'blob:http://127.0.0.1:43213/composer-preview',
      selectionText: '',
      mediaType: 'image',
      hasImageContents: true,
      isEditable: false,
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    })
    await vi.waitFor(() => {
      expect(window?.webContents.send.mock.calls.filter(([channel]) => channel === 'desktop:context-menu')).toHaveLength(2)
    })
    const imageRequest = window?.webContents.send.mock.calls.filter(([channel]) => channel === 'desktop:context-menu').at(-1)?.[1]
    expect(imageRequest).toMatchObject({
      items: [
        expect.objectContaining({ id: 'desktop.copy-image', label: '复制', enabled: true }),
        expect.objectContaining({ id: 'desktop.save-image', label: '下载副本', enabled: true }),
      ],
    })
    if (select !== undefined && window !== undefined && imageRequest !== undefined) {
      await select({ sender: window.webContents }, { requestId: imageRequest.requestId, itemId: 'desktop.copy-image' })
    }
    expect(frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining(
      'blob:http://127.0.0.1:43213/composer-preview',
    ))
    expect(electronMocks.nativeImageCreateFromDataURL).toHaveBeenCalledWith(
      'data:image/png;base64,Y29waWVkLWltYWdl',
    )
    expect(electronMocks.clipboardWriteImage).toHaveBeenCalledWith(electronMocks.clipboardImage)
    expect(window?.webContents.copyImageAt).not.toHaveBeenCalled()
  })

  it('routes Cordis menu contributions through the internal Electron transport', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    const url = 'http://127.0.0.1:43214'
    const transport = `globalThis[Symbol.for(${JSON.stringify(DESKTOP_CONTEXT_MENU_TRANSPORT_KEY)})]`
    const frame = {
      parent: {},
      name: 'harness-frame',
      url,
      isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => {
        if (script === 'document.readyState') return 'complete'
        if (script === `${transport}?.collect?.() ?? null`) {
          return {
            token: 'cordis-menu-token',
            items: [{ kind: 'item', id: 'plugin.archive', label: '归档', enabled: true, icon: 'archive' }],
            linkURL: 'http://127.0.0.1:43214/api/dsh-visualize/artifacts/session/artifact/index.html',
          }
        }
        return true
      }),
    }
    const window = electronMocks.window
    expect(window).toBeDefined()
    if (window === undefined) return
    window.webContents.mainFrame.framesInSubtree = [frame]
    await controller.showHarness(url, '0.1.0')

    window.webContents.emit('context-menu', { preventDefault: vi.fn() }, {
      x: 256,
      y: 192,
      frame,
      frameURL: url,
      linkURL: '',
      selectionText: '',
      isEditable: false,
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: false,
        canEditRichly: false,
      },
    })

    await vi.waitFor(() => {
      const requests = window.webContents.send.mock.calls
        .filter(([channel]) => channel === 'desktop:context-menu')
        .map(([, request]) => request)
      expect(requests.some((request) => request.items.some((item: { id?: string }) => item.id === 'plugin.archive'))).toBe(true)
    })
    const request = window.webContents.send.mock.calls
      .filter(([channel]) => channel === 'desktop:context-menu')
      .map(([, request]) => request)
      .find((request) => request.items.some((item: { id?: string }) => item.id === 'plugin.archive'))
    expect(request).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'desktop.open-link-in-browser', label: '在内置浏览器中打开' }),
        expect.objectContaining({ id: 'plugin.archive', label: '归档' }),
      ]),
    })
    const select = electronMocks.ipcHandlers.get('desktop:context-menu-select')
    expect(select).toBeDefined()
    if (select !== undefined && request !== undefined) {
      await select({ sender: window.webContents }, { requestId: request.requestId, itemId: 'plugin.archive' })
    }
    expect(frame.executeJavaScript).toHaveBeenCalledWith(
      `${transport}?.execute?.("cordis-menu-token", "plugin.archive")`,
    )
  })

  it('opens the core context menu inside desktop shell inputs', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    const window = electronMocks.window
    expect(window).toBeDefined()
    if (window === undefined) return
    const contextEvent = { preventDefault: vi.fn() }
    window.webContents.emit('context-menu', contextEvent, {
      x: 480,
      y: 360,
      frame: window.webContents.mainFrame,
      frameURL: window.webContents.mainFrame.url,
      linkURL: '',
      selectionText: '',
      isEditable: true,
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: true,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    })

    await vi.waitFor(() => {
      expect(window.webContents.send.mock.calls.some(([channel]) => channel === 'desktop:context-menu')).toBe(true)
    })
    expect(contextEvent.preventDefault).toHaveBeenCalledOnce()
    const request = window.webContents.send.mock.calls.find(([channel]) => channel === 'desktop:context-menu')?.[1]
    expect(request).toMatchObject({
      x: 480,
      y: 360,
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'desktop.paste', enabled: true }),
        expect.objectContaining({ id: 'desktop.select-all', enabled: true }),
      ]),
    })
    expect(window.webContents.mainFrame.executeJavaScript).not.toHaveBeenCalledWith(
      `globalThis[Symbol.for(${JSON.stringify(DESKTOP_CONTEXT_MENU_TRANSPORT_KEY)})]?.collect?.() ?? null`,
    )
    const dismiss = electronMocks.ipcHandlers.get('desktop:context-menu-dismiss')
    expect(dismiss).toBeDefined()
    if (dismiss !== undefined && request !== undefined) {
      await dismiss(
        { sender: window.webContents },
        request.requestId,
        false,
      )
    }

    const nativePointerEvent = { preventDefault: vi.fn() }
    window.webContents.emit('before-mouse-event', nativePointerEvent, {
      type: 'mouseDown',
      x: 360.4,
      y: 260.2,
      button: 'left',
    })
    expect(nativePointerEvent.preventDefault).not.toHaveBeenCalled()
    expect(window.webContents.send).toHaveBeenCalledWith('desktop:pointer-input', {
      x: 360,
      y: 260,
      button: 'left',
    })
  })

  it('preserves address-field copy handlers when the script command needs a native fallback', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist', updateState: { status: 'idle' },
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()
    const window = electronMocks.window!
    const readable = 'file:///E:/项目文件/播放器.html'
    window.webContents.mainFrame.executeJavaScript.mockResolvedValue(false)
    window.webContents.emit('context-menu', { preventDefault: vi.fn() }, {
      frame: window.webContents.mainFrame, frameURL: window.webContents.mainFrame.url,
      x: 20, y: 40, linkURL: '', srcURL: '', selectionText: readable, isEditable: true,
      editFlags: { canUndo: false, canRedo: false, canCut: true, canCopy: true,
        canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false },
    })
    const request = window.webContents.send.mock.calls.find(([channel]) => channel === 'desktop:context-menu')![1]
    await electronMocks.ipcHandlers.get('desktop:context-menu-select')!(
      { sender: window.webContents }, { requestId: request.requestId, itemId: 'desktop.copy' },
    )
    expect(window.webContents.copy).toHaveBeenCalledOnce()
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalledWith(readable)
  })

  it('ignores right clicks outside desktop shell inputs', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: { pnpmVersion: '11.19.0', restarting: false, commandRunning: false },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    const window = electronMocks.window
    expect(window).toBeDefined()
    if (window === undefined) return
    const contextEvent = { preventDefault: vi.fn() }
    window.webContents.emit('context-menu', contextEvent, {
      x: 480,
      y: 360,
      frame: window.webContents.mainFrame,
      frameURL: window.webContents.mainFrame.url,
      linkURL: '',
      selectionText: 'desktop shell text',
      isEditable: false,
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: true,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(contextEvent.preventDefault).not.toHaveBeenCalled()
    expect(window.webContents.send.mock.calls.some(([channel]) => channel === 'desktop:context-menu')).toBe(false)
  })

  it('detects a ready Harness frame even when renderer load events are missed', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: {
        pnpmVersion: '11.19.0',
        restarting: false,
        commandRunning: false,
      },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    const url = 'http://127.0.0.1:43211'
    const frame = {
      parent: {},
      name: 'harness-frame',
      url,
      isDestroyed: () => false,
      executeJavaScript: vi.fn().mockResolvedValue('complete'),
    }
    const window = electronMocks.window
    expect(window).toBeDefined()
    if (window !== undefined) window.webContents.mainFrame.framesInSubtree = [frame]

    await controller.showHarness(url, '0.1.0')

    expect(frame.executeJavaScript).toHaveBeenCalledWith('document.readyState')
    expect(window?.webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
      harnessLoadId: 1,
      harnessLifecycle: 'ready',
    })
  })

  it('reveals a healthy Harness after a grace period when Electron reports no frame events', async () => {
    const runtime = Object.assign(new EventEmitter(), {
      harnessHome: '/path/that/does/not/exist',
      updateState: { status: 'idle' },
      checkForUpdates: vi.fn(),
    })
    const development = Object.assign(new EventEmitter(), {
      state: {
        pnpmVersion: '11.19.0',
        restarting: false,
        commandRunning: false,
      },
      choosePatch: vi.fn(),
      clearPatch: vi.fn(),
      restartHarness: vi.fn(),
      runPlugin: vi.fn(),
    })
    const controller = new WindowController(runtime as never, development as never)
    await controller.create()

    vi.useFakeTimers()
    try {
      const load = controller.showHarness('http://127.0.0.1:43212', '0.1.0')
      await vi.advanceTimersByTimeAsync(3_000)
      await load

      expect(electronMocks.window?.webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
        harnessLoadId: 1,
        harnessLifecycle: 'ready',
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
