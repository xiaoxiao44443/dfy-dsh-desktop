import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  clipboardImage: { isEmpty: () => false },
  clipboardWriteImage: vi.fn(),
  clipboardWriteText: vi.fn(),
  shellOpenExternal: vi.fn(),
  nativeImageCreateFromDataURL: vi.fn(),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  window: undefined as undefined | {
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
    }
  },
}))

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events')

  class MockWebContents extends MockEventEmitter {
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
    // A Harness subframe can still report loading after the desktop shell is
    // ready. State publication must only be gated on the main frame.
    isLoading(): boolean { return true }
    isLoadingMainFrame(): boolean { return false }
    isDestroyed(): boolean { return false }
  }

  class MockBrowserWindow extends MockEventEmitter {
    webContents = new MockWebContents()

    constructor() {
      super()
      electronMocks.window = this
    }

    async loadFile(): Promise<void> {}
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
    nativeTheme: { shouldUseDarkColors: true },
    nativeImage: {
      createFromDataURL: electronMocks.nativeImageCreateFromDataURL.mockReturnValue(electronMocks.clipboardImage),
    },
    shell: { openExternal: electronMocks.shellOpenExternal },
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
      items: [expect.objectContaining({ id: 'desktop.copy-image', label: '复制', enabled: true })],
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
