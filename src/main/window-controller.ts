import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import type { ContextMenuParams, WebContents, WebFrameMain } from 'electron'
import type { BrowserDisplayMode, BrowserMenuKind, ColorTheme, DesktopApplicationMenuAction, DesktopBrowserMenuAnchor, DesktopBrowserNavigationAction, DesktopBrowserViewBounds, DesktopBrowserViewport, DesktopPlatform, DesktopState, DevelopmentPluginRequest, HarnessLifecycle, PluginActivationRequest, PluginInitializationFailure, PluginInstallRequest, PluginRemoveRequest, PluginUpdateRequest, TitleMenuAction, WindowAction } from '../shared/contracts.js'
import type { DesktopContextMenuActionRequest, DesktopContextMenuRequest, DesktopPointerInput, PluginContextMenuCollection } from '../shared/context-menu.js'
import { DESKTOP_CONTEXT_MENU_TRANSPORT_KEY, parsePluginContextMenuCollection } from '../shared/context-menu.js'
import { RUNTIME_PREPARATION_PROGRESS_EVENT, type HarnessRuntimeManager } from './harness-runtime.js'
import type { DevelopmentService } from './development-service.js'
import type { PluginManagementService } from './plugin-management.js'
import { parsePluginInitializationFailure, type PluginRecoveryService } from './plugin-recovery.js'
import { appendPluginContextMenuItems, BUILTIN_CONTEXT_MENU_ACTIONS, buildBuiltinContextMenuItems } from './context-menu.js'
import { DEFAULT_BROWSER_SETTINGS, type DesktopBrowserService } from './desktop-browser.js'
import type { DesktopApplicationMenuState } from '../shared/contracts.js'

const STATE_CHANNEL = 'desktop:state'
const CONTEXT_MENU_CHANNEL = 'desktop:context-menu'
const POINTER_INPUT_CHANNEL = 'desktop:pointer-input'
const APPLICATION_MENU_ACTION_CHANNEL = 'desktop:application-menu-action'
const CONTEXT_MENU_TRANSPORT_EXPRESSION = `globalThis[Symbol.for(${JSON.stringify(DESKTOP_CONTEXT_MENU_TRANSPORT_KEY)})]`
const HARNESS_LOAD_TIMEOUT_MS = 45_000
const HARNESS_LOAD_PROBE_INTERVAL_MS = 100
const HARNESS_LOAD_READY_FALLBACK_MS = 3_000
const HARNESS_RELEASES_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
const HARNESS_PLUGIN_DOCUMENTATION_URL = 'https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli'
const MAX_CLIPBOARD_IMAGE_PIXELS = 100_000_000

type ColorThemePreference = ColorTheme | 'system'

export function parseHarnessThemePreference(settings: string): ColorThemePreference | undefined {
  const themeBlock = settings.match(/^ui-theme\s*:\s*(?:#.*)?\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m)?.[1]
  const preference = themeBlock?.match(/^\s+preference\s*:\s*['"]?(dark|light|system)['"]?\s*(?:#.*)?$/mi)?.[1]
  return preference === 'dark' || preference === 'light' || preference === 'system' ? preference : undefined
}

export function resolveHarnessThemePreference(
  preference: ColorThemePreference,
  systemDark: boolean,
): ColorTheme {
  return preference === 'system' ? systemDark ? 'dark' : 'light' : preference
}

export function resolveHarnessReleaseUrl(version?: string): string {
  const normalized = version?.trim().replace(/^dsh-v/u, '').replace(/^v/u, '')
  if (normalized === undefined || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(normalized)) return HARNESS_RELEASES_URL
  return `${HARNESS_RELEASES_URL}/tag/${encodeURIComponent(`dsh-v${normalized}`)}`
}

interface PendingHarnessLoad {
  url: string
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  readyFallback: NodeJS.Timeout
}

interface PendingDesktopContextMenu {
  requestId: string
  frame: WebFrameMain
  contents: WebContents
  x: number
  y: number
  linkURL: string
  srcURL: string
  selectionText: string
  allowedItemIds: Set<string>
  pluginToken?: string
}

export class WindowController {
  private window: BrowserWindow | undefined
  private harnessLifecycle: HarnessLifecycle = 'stopped'
  private harnessMessage: string | undefined
  private runtimePreparationProgress: number | undefined
  private pluginFailure: PluginInitializationFailure | undefined
  private harnessVersion: string | undefined
  private harnessUrl: string | undefined
  private harnessLoadId = 0
  private harnessOrigin: string | undefined
  private pendingHarnessLoad: PendingHarnessLoad | undefined
  private harnessLoadProbeTimer: NodeJS.Timeout | undefined
  private harnessLoadProbeInFlight = false
  private ipcRegistered = false
  private theme: ColorTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  private themeProbeTimer: NodeJS.Timeout | undefined
  private themeProbeInFlight = false
  private pluginFailureProbeTimer: NodeJS.Timeout | undefined
  private pluginFailureProbeInFlight = false
  private contextMenuSequence = 0
  private pendingContextMenu: PendingDesktopContextMenu | undefined

  constructor(
    private readonly runtime: HarnessRuntimeManager,
    private readonly development: DevelopmentService,
    private readonly pluginRecovery?: PluginRecoveryService,
    private readonly browser?: DesktopBrowserService,
    private readonly plugins?: PluginManagementService,
  ) {
    this.runtime.on('update-state', () => this.publishState())
    this.runtime.on(RUNTIME_PREPARATION_PROGRESS_EVENT, (progress: unknown) => {
      if (
        this.harnessLifecycle !== 'starting'
        || this.harnessVersion !== undefined
        || typeof progress !== 'number'
        || !Number.isFinite(progress)
      ) return
      this.runtimePreparationProgress = Math.min(100, Math.max(0, Math.round(progress)))
      this.publishState()
    })
    this.development.on('state', () => this.publishState())
    this.browser?.on('state', () => this.publishState())
    this.browser?.on('context-menu', (params: ContextMenuParams, contents: WebContents, source: 'floating' | 'page') => {
      void this.openBrowserContextMenu(params, contents, source)
    })
    this.browser?.on('context-menu-dismiss', (requestId: string) => {
      void this.dismissContextMenu(requestId, true)
    })
    this.browser?.on('application-menu-action', (action: DesktopApplicationMenuAction) => {
      void this.handleApplicationMenuAction(action)
    })
  }

  async create(): Promise<void> {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.focus()
      return
    }

    this.theme = await this.readConfiguredTheme()
    this.browser?.setTheme(this.theme)

    const developerToolsEnabled = !app.isPackaged || process.argv.includes('--enable-devtools')
    const isMac = process.platform === 'darwin'
    const platform = this.desktopPlatform()
    const opaqueBackground = this.theme === 'dark' ? '#101114' : '#f4f5f7'
    const window = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      show: false,
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 14, y: 13 },
          }
        : { frame: false }),
      backgroundColor: process.platform === 'win32' ? '#00FFFFFF' : opaqueBackground,
      ...(process.platform === 'win32' ? { backgroundMaterial: 'acrylic' as const } : {}),
      title: 'DFY DSH Desktop',
      icon: this.resourcePath('app-icon.png'),
      webPreferences: {
        preload: fileURLToPath(new URL('../preload.cjs', import.meta.url)),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: developerToolsEnabled,
      },
    })
    this.window = window

    window.on('maximize', () => this.publishState())
    window.on('unmaximize', () => this.publishState())
    window.on('closed', () => {
      this.stopThemeSync()
      this.stopPluginFailureProbe()
      this.cancelPendingHarnessLoad(new Error('桌面窗口已关闭。'))
      this.pendingContextMenu = undefined
      this.browser?.detachWindow()
      this.window = undefined
    })

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    if (!developerToolsEnabled) {
      window.webContents.on('devtools-opened', () => window.webContents.closeDevTools())
    }
    window.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase()
      if (key === 'f5' || (key === 'r' && (input.control || input.meta))) event.preventDefault()
      if (input.alt || input.meta || key === 'alt' || key === 'meta' || key === 'os' || key === 'super') {
        const contextRequestId = this.browser?.closeMenu()
        if (contextRequestId !== undefined) void this.dismissContextMenu(contextRequestId, false)
      }
    })
    window.webContents.on('before-mouse-event', (_event, input) => {
      if (input.type !== 'mouseDown') return
      if (input.button !== 'left' && input.button !== 'middle' && input.button !== 'right') return
      const contextRequestId = this.browser?.closeMenu()
      if (contextRequestId !== undefined) void this.dismissContextMenu(contextRequestId, true)
      const pointer: DesktopPointerInput = {
        x: Math.round(input.x),
        y: Math.round(input.y),
        button: input.button,
      }
      window.webContents.send(POINTER_INPUT_CHANNEL, pointer)
    })
    window.webContents.on('context-menu', (event, params) => {
      if (!this.isSupportedContextMenu(params)) return
      event.preventDefault()
      void this.openContextMenu(params)
    })
    window.webContents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return
      if (this.safeOrigin(details.url) === this.harnessOrigin) return
      details.preventDefault()
      if (details.url.startsWith('https://') || details.url.startsWith('http://')) {
        void shell.openExternal(details.url)
      }
    })
    window.webContents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame) => {
      if (!isMainFrame && this.safeOrigin(url) === this.harnessOrigin) {
        this.handleHarnessFrameLoaded(url)
        void this.detectHarnessPluginFailure()
      }
    })
    window.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
      if (isMainFrame) return
      const frame = this.findHarnessFrame()
      if (frame !== undefined) {
        this.handleHarnessFrameLoaded(frame.url)
        void this.detectHarnessPluginFailure()
      }
    })
    window.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (isMainFrame || code === -3 || this.safeOrigin(validatedUrl) !== this.harnessOrigin) return
      this.setHarnessError(`页面加载失败：${description} (${code}) ${validatedUrl}`)
    })

    if (!this.ipcRegistered) this.registerIpc()
    const rendererDevUrl = !app.isPackaged
      ? process.env.HARNESS_DESKTOP_RENDERER_URL
      : undefined
    if (rendererDevUrl !== undefined) {
      const url = new URL(rendererDevUrl)
      url.searchParams.set('theme', this.theme)
      url.searchParams.set('platform', platform)
      await window.loadURL(url.toString())
    } else {
      await window.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'), {
        query: { theme: this.theme, platform },
      })
    }
    await this.browser?.attachWindow(window)
    window.show()
    this.publishState()
  }

  setRuntimePreparing(): void {
    this.resetContextMenu()
    this.stopThemeSync()
    this.stopPluginFailureProbe()
    this.cancelPendingHarnessLoad(new Error('Harness 运行时正在准备。'))
    this.harnessVersion = undefined
    this.harnessUrl = undefined
    this.harnessOrigin = undefined
    this.harnessLifecycle = 'starting'
    this.pluginFailure = undefined
    this.runtimePreparationProgress = undefined
    this.harnessMessage = app.isPackaged && process.platform === 'win32'
      ? '首次启动正在解压 Harness 运行时，请稍候…'
      : '正在准备本地 Harness 运行时…'
    this.publishState()
  }

  setHarnessStarting(version: string): void {
    this.resetContextMenu()
    this.stopThemeSync()
    this.stopPluginFailureProbe()
    this.cancelPendingHarnessLoad(new Error('Harness 启动目标已变更。'))
    this.harnessVersion = version
    this.harnessUrl = undefined
    this.harnessOrigin = undefined
    this.harnessLifecycle = 'starting'
    this.pluginFailure = undefined
    this.runtimePreparationProgress = undefined
    this.harnessMessage = '正在启动 Harness…'
    this.publishState()
  }

  async showHarness(url: string, version: string): Promise<void> {
    this.resetContextMenu()
    this.cancelPendingHarnessLoad(new Error('Harness 页面加载目标已变更。'))
    this.harnessVersion = version
    this.harnessUrl = url
    this.harnessLoadId += 1
    this.harnessOrigin = new URL(url).origin
    this.harnessLifecycle = 'starting'
    this.pluginFailure = undefined
    this.runtimePreparationProgress = undefined
    this.harnessMessage = '正在加载 Harness 界面…'

    const loadPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingHarnessLoad?.url !== url) return
        clearTimeout(this.pendingHarnessLoad.readyFallback)
        this.pendingHarnessLoad = undefined
        this.stopHarnessLoadProbe()
        reject(new Error(`Harness 页面在 ${HARNESS_LOAD_TIMEOUT_MS / 1000} 秒内没有完成加载。`))
      }, HARNESS_LOAD_TIMEOUT_MS)
      const readyFallback = setTimeout(() => this.handleHarnessFrameLoaded(url), HARNESS_LOAD_READY_FALLBACK_MS)
      this.pendingHarnessLoad = { url, resolve, reject, timer, readyFallback }
    })

    this.publishState()
    void this.probeHarnessFrameReady(url)
    await loadPromise
  }

  setHarnessError(message: string, pluginFailure?: PluginInitializationFailure): void {
    this.resetContextMenu()
    this.stopThemeSync()
    this.stopPluginFailureProbe()
    this.cancelPendingHarnessLoad(new Error(message))
    this.harnessLifecycle = 'error'
    this.harnessMessage = message
    this.runtimePreparationProgress = undefined
    this.pluginFailure = pluginFailure
    this.harnessUrl = undefined
    this.harnessOrigin = undefined
    this.publishState()
  }

  focus(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  getBrowserWindow(): BrowserWindow | undefined {
    const window = this.window
    return window !== undefined && !window.isDestroyed() ? window : undefined
  }

  focusHarnessSession(sessionId: string): void {
    if (sessionId.length === 0 || sessionId.length > 240 || /[\r\n\0]/u.test(sessionId)) return
    this.focus()
    const frame = this.findHarnessFrame()
    if (frame === undefined) return
    const message = JSON.stringify({
      source: 'dfy-dsh-desktop',
      type: 'notification-click',
      sessionId,
    })
    void frame.executeJavaScript(`window.postMessage(${message}, location.origin)`).catch(() => undefined)
  }

  private registerIpc(): void {
    this.ipcRegistered = true
    ipcMain.handle('desktop:get-state', () => this.getState())
    ipcMain.handle('desktop:window-action', (_event, action: WindowAction) => this.windowAction(action))
    ipcMain.handle('desktop:harness-frame-loaded', (event, url: string) => {
      if (event.sender !== this.window?.webContents) return
      this.handleHarnessFrameLoaded(url)
      void this.detectHarnessPluginFailure()
    })
    ipcMain.handle('desktop:title-menu-action', (_event, action: TitleMenuAction) => this.titleMenuAction(action))
    ipcMain.handle('desktop:check-update', () => this.runtime.checkForUpdates({ download: false }))
    ipcMain.handle('desktop:install-update-version', (_event, version: string) => this.runtime.installHarnessVersion(version))
    ipcMain.handle('desktop:open-harness-release', async (event, version: string) => {
      if (event.sender !== this.window?.webContents) return
      await shell.openExternal(resolveHarnessReleaseUrl(version))
    })
    ipcMain.handle('desktop:restart-update', () => {
      if (this.runtime.updateState.status !== 'ready') return
      app.relaunch()
      app.quit()
    })
    ipcMain.handle('desktop:development-choose-patch', () => this.development.choosePatch())
    ipcMain.handle('desktop:development-clear-patch', () => this.development.clearPatch())
    ipcMain.handle('desktop:development-restart', () => this.development.restartHarness())
    ipcMain.handle('desktop:development-copy-harness-url', (event) => {
      if (event.sender !== this.window?.webContents) return
      if (this.harnessUrl === undefined) throw new Error('Harness 尚未启动。')
      clipboard.writeText(this.harnessUrl)
    })
    ipcMain.handle('desktop:development-open-harness-url', async (event) => {
      if (event.sender !== this.window?.webContents) return
      if (this.harnessUrl === undefined) throw new Error('Harness 尚未启动。')
      await shell.openExternal(this.harnessUrl)
    })
    ipcMain.handle('desktop:development-cli-enabled', (event, enabled: boolean) => {
      if (event.sender !== this.window?.webContents || typeof enabled !== 'boolean') return
      return this.development.setCliEnabled(enabled)
    })
    ipcMain.handle('desktop:plugin-recovery-disable', async () => await this.recoverFailedPlugin())
    ipcMain.handle('desktop:plugin-recovery-restore', async (_event, entryId: string) => await this.restoreRecoveredPlugin(entryId))
    ipcMain.handle('desktop:development-run-plugin', (_event, request: DevelopmentPluginRequest) => this.development.runPlugin(request))
    ipcMain.handle('desktop:plugins-inventory', (event) => {
      if (event.sender !== this.window?.webContents) return
      return this.plugins?.getInventory()
    })
    ipcMain.handle('desktop:plugins-choose-local', (event) => {
      if (event.sender !== this.window?.webContents) return
      return this.plugins?.chooseLocalDirectory()
    })
    ipcMain.handle('desktop:plugins-install', (event, request: PluginInstallRequest) => {
      if (event.sender !== this.window?.webContents) return
      if (this.plugins === undefined) throw new Error('插件管理服务尚未准备完成。')
      return this.plugins.install(request)
    })
    ipcMain.handle('desktop:plugins-update', (event, request: PluginUpdateRequest) => {
      if (event.sender !== this.window?.webContents) return
      if (this.plugins === undefined) throw new Error('插件管理服务尚未准备完成。')
      return this.plugins.update(request)
    })
    ipcMain.handle('desktop:plugins-remove', (event, request: PluginRemoveRequest) => {
      if (event.sender !== this.window?.webContents) return
      if (this.plugins === undefined) throw new Error('插件管理服务尚未准备完成。')
      return this.plugins.remove(request)
    })
    ipcMain.handle('desktop:plugins-set-active', (event, request: PluginActivationRequest) => {
      if (event.sender !== this.window?.webContents) return
      if (this.plugins === undefined) throw new Error('插件管理服务尚未准备完成。')
      return this.plugins.setActive(request)
    })
    ipcMain.handle('desktop:plugins-copy-text', (event, text: string) => {
      if (event.sender !== this.window?.webContents) return
      if (typeof text !== 'string' || text.length === 0 || text.length > 4_096 || /[\r\n\0]/u.test(text)) {
        throw new Error('要复制的插件信息无效。')
      }
      clipboard.writeText(text)
    })
    ipcMain.handle('desktop:plugins-open-documentation', async (event) => {
      if (event.sender !== this.window?.webContents) return
      await shell.openExternal(HARNESS_PLUGIN_DOCUMENTATION_URL)
    })
    ipcMain.handle('desktop:browser-panel-open', async (event, open: boolean) => {
      if (event.sender !== this.window?.webContents || typeof open !== 'boolean') return
      await this.browser?.setPanelOpen(open)
    })
    ipcMain.handle('desktop:browser-display-mode', async (event, mode: BrowserDisplayMode) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.setDisplayMode(mode)
    })
    ipcMain.handle('desktop:browser-open-menu', async (event, kind: BrowserMenuKind, anchor: DesktopBrowserMenuAnchor) => {
      if (event.sender !== this.window?.webContents) return
      const applicationState: DesktopApplicationMenuState | undefined = kind === 'application'
        ? {
            appVersion: app.getVersion(),
            ...(this.harnessVersion === undefined ? {} : { harnessVersion: this.harnessVersion }),
            updateStatus: this.runtime.updateState.status,
            ...(this.runtime.updateState.version === undefined ? {} : { updateVersion: this.runtime.updateState.version }),
            ...(this.runtime.updateState.latestVersion === undefined ? {} : { updateLatestVersion: this.runtime.updateState.latestVersion }),
            ...(this.runtime.updateState.progress === undefined ? {} : { updateProgress: this.runtime.updateState.progress }),
            patchEnabled: Boolean(this.development.state.patchPath),
          }
        : undefined
      await this.browser?.openPageMenu(kind, anchor, applicationState)
    })
    ipcMain.handle('desktop:browser-zoom-factor', async (event, factor: number) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.setZoomFactor(factor)
    })
    ipcMain.handle('desktop:browser-device-viewport', async (event, viewport: DesktopBrowserViewport | null) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.setDeviceViewport(viewport)
    })
    ipcMain.handle('desktop:browser-device-preview', async (event, viewport: DesktopBrowserViewport) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.previewDeviceViewport(viewport)
    })
    ipcMain.handle('desktop:browser-view-bounds', async (event, bounds: DesktopBrowserViewBounds | null) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.setViewBounds(bounds)
    })
    ipcMain.handle('desktop:browser-shell-snapshot', async (event) => {
      if (event.sender !== this.window?.webContents) return
      return await this.browser?.refreshShellSnapshot()
    })
    ipcMain.handle('desktop:browser-shell-overlay', async (event, bounds: DesktopBrowserViewBounds | null) => {
      if (event.sender !== this.window?.webContents) return
      return await this.browser?.setShellOverlay(bounds)
    })
    ipcMain.handle('desktop:browser-shell-overlay-commit', async (event) => {
      if (event.sender !== this.window?.webContents) return
      this.browser?.commitShellOverlay()
    })
    ipcMain.handle('desktop:browser-navigate', async (event, value: string) => {
      if (event.sender !== this.window?.webContents || typeof value !== 'string') return
      await this.browser?.navigate(value)
    })
    ipcMain.handle('desktop:browser-navigation-action', async (event, action: DesktopBrowserNavigationAction) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.navigationAction(action)
    })
    ipcMain.handle('desktop:browser-new-tab', async (event) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.createManualTab()
    })
    ipcMain.handle('desktop:browser-select-tab', async (event, tabId: string) => {
      if (event.sender !== this.window?.webContents || typeof tabId !== 'string') return
      await this.browser?.selectTab(tabId)
    })
    ipcMain.handle('desktop:browser-close-tab', async (event, tabId: string) => {
      if (event.sender !== this.window?.webContents || typeof tabId !== 'string') return
      await this.browser?.closeTab(tabId, true)
    })
    ipcMain.handle('desktop:browser-history', (event) => {
      if (event.sender !== this.window?.webContents) return []
      return this.browser?.getHistory() ?? []
    })
    ipcMain.handle('desktop:browser-clear-history', async (event) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.clearHistory()
    })
    ipcMain.handle('desktop:browser-clear-data', async (event) => {
      if (event.sender !== this.window?.webContents) return
      await this.browser?.clearBrowsingData()
    })
    ipcMain.handle('desktop:context-menu-select', async (event, request: DesktopContextMenuActionRequest) => {
      if (event.sender !== this.window?.webContents && this.browser?.ownsMenuWebContents(event.sender) !== true) return
      this.browser?.closeMenu()
      await this.selectContextMenuItem(request)
    })
    ipcMain.handle('desktop:context-menu-dismiss', async (event, requestId: string, restoreFocus: boolean) => {
      if (event.sender !== this.window?.webContents && this.browser?.ownsMenuWebContents(event.sender) !== true) return
      this.browser?.closeMenu()
      await this.dismissContextMenu(requestId, restoreFocus !== false)
    })
  }

  private isHarnessContextMenu(params: ContextMenuParams): boolean {
    const frame = params.frame
    return frame !== null && this.isHarnessFrame(frame)
  }

  private isHarnessFrame(frame: WebFrameMain): boolean {
    return !frame.isDestroyed()
      && frame.parent !== null
      && this.harnessOrigin !== undefined
      && this.safeOrigin(frame.url) === this.harnessOrigin
  }

  private isShellFrame(frame: WebFrameMain): boolean {
    const window = this.window
    return window !== undefined
      && !window.isDestroyed()
      && !frame.isDestroyed()
      && frame.parent === null
  }

  private isSupportedContextMenu(params: ContextMenuParams): boolean {
    const frame = params.frame
    return frame !== null && ((params.isEditable && this.isShellFrame(frame)) || this.isHarnessContextMenu(params))
  }

  private async openContextMenu(params: ContextMenuParams): Promise<void> {
    const frame = params.frame
    if (frame === null || !this.isSupportedContextMenu(params)) return
    const window = this.window
    if (window === undefined || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return
    const harnessContext = this.isHarnessFrame(frame)
    const sequence = ++this.contextMenuSequence
    const previous = this.pendingContextMenu
    this.pendingContextMenu = undefined
    if (previous !== undefined) void this.releasePluginContextMenu(previous, false)

    const builtins = buildBuiltinContextMenuItems(params, {
      embeddedBrowserEnabled: this.browser?.state.settings.enabled === true,
    })
    const pluginCollectionPromise = harnessContext
      ? this.collectPluginContextMenu(frame)
      : Promise.resolve(undefined)

    if (
      builtins.some((entry) => entry.kind === 'item')
      && sequence === this.contextMenuSequence
      && (this.isShellFrame(frame) || this.isHarnessFrame(frame))
    ) {
      const requestId = `menu-${Date.now().toString(36)}-${sequence.toString(36)}`
      this.pendingContextMenu = {
        requestId,
        frame,
        contents: window.webContents,
        x: params.x,
        y: params.y,
        linkURL: params.linkURL,
        srcURL: params.srcURL,
        selectionText: params.selectionText,
        allowedItemIds: new Set(builtins.flatMap((entry) => entry.kind === 'item' && entry.enabled ? [entry.id] : [])),
      }
      const request: DesktopContextMenuRequest = { requestId, x: params.x, y: params.y, items: builtins }
      window.webContents.send(CONTEXT_MENU_CHANNEL, request)
      void pluginCollectionPromise.then((pluginCollection) => {
        this.updateOpenContextMenuWithPlugins(sequence, requestId, frame, params, builtins, pluginCollection)
      })
      return
    }

    const pluginCollection = await pluginCollectionPromise
    if (sequence !== this.contextMenuSequence || (!this.isShellFrame(frame) && !this.isHarnessFrame(frame))) {
      if (pluginCollection !== undefined) void this.releasePluginContextMenu({
        frame,
        pluginToken: pluginCollection.token,
      }, false)
      return
    }

    const effectiveLinkURL = params.linkURL || pluginCollection?.linkURL || ''
    const effectiveBuiltins = effectiveLinkURL === params.linkURL
      ? builtins
      : buildBuiltinContextMenuItems({ ...params, linkURL: effectiveLinkURL }, {
        embeddedBrowserEnabled: this.browser?.state.settings.enabled === true,
      })
    const items = appendPluginContextMenuItems(effectiveBuiltins, pluginCollection?.items ?? [])
    if (!items.some((entry) => entry.kind === 'item')) return
    const requestId = `menu-${Date.now().toString(36)}-${sequence.toString(36)}`
    this.pendingContextMenu = {
      requestId,
      frame,
      contents: window.webContents,
      x: params.x,
      y: params.y,
      linkURL: effectiveLinkURL,
      srcURL: params.srcURL,
      selectionText: params.selectionText,
      allowedItemIds: new Set(items.flatMap((entry) => entry.kind === 'item' && entry.enabled ? [entry.id] : [])),
      ...(pluginCollection === undefined ? {} : { pluginToken: pluginCollection.token }),
    }
    const request: DesktopContextMenuRequest = {
      requestId,
      x: params.x,
      y: params.y,
      items,
    }
    window.webContents.send(CONTEXT_MENU_CHANNEL, request)
  }

  private updateOpenContextMenuWithPlugins(
    sequence: number,
    requestId: string,
    frame: WebFrameMain,
    params: ContextMenuParams,
    builtins: DesktopContextMenuRequest['items'],
    pluginCollection: PluginContextMenuCollection | undefined,
  ): void {
    if (pluginCollection === undefined) return
    const pending = this.pendingContextMenu
    if (
      pending === undefined
      || pending.requestId !== requestId
      || sequence !== this.contextMenuSequence
      || frame.isDestroyed()
    ) {
      void this.releasePluginContextMenu({ frame, pluginToken: pluginCollection.token }, false)
      return
    }
    const effectiveLinkURL = params.linkURL || pluginCollection.linkURL || ''
    const effectiveBuiltins = effectiveLinkURL === params.linkURL
      ? builtins
      : buildBuiltinContextMenuItems({ ...params, linkURL: effectiveLinkURL }, {
        embeddedBrowserEnabled: this.browser?.state.settings.enabled === true,
      })
    const items = appendPluginContextMenuItems(effectiveBuiltins, pluginCollection.items)
    pending.linkURL = effectiveLinkURL
    pending.allowedItemIds = new Set(items.flatMap((entry) => entry.kind === 'item' && entry.enabled ? [entry.id] : []))
    pending.pluginToken = pluginCollection.token
    this.window?.webContents.send(CONTEXT_MENU_CHANNEL, {
      requestId,
      x: pending.x,
      y: pending.y,
      items,
    } satisfies DesktopContextMenuRequest)
  }

  private async openBrowserContextMenu(
    params: ContextMenuParams,
    contents: WebContents,
    source: 'floating' | 'page',
  ): Promise<void> {
    const frame = params.frame
    if (frame === null || contents.isDestroyed()) return
    const sequence = ++this.contextMenuSequence
    const previous = this.pendingContextMenu
    this.pendingContextMenu = undefined
    if (previous !== undefined) void this.releasePluginContextMenu(previous, false)

    const items = buildBuiltinContextMenuItems(params, { embeddedBrowserEnabled: true })
      .filter((entry) => entry.kind === 'separator' || entry.id !== 'desktop.open-link-in-browser')
    while (items[0]?.kind === 'separator') items.shift()
    while (items.at(-1)?.kind === 'separator') items.pop()
    if (!items.some((entry) => entry.kind === 'item')) return

    const requestId = `menu-${Date.now().toString(36)}-${sequence.toString(36)}`
    this.pendingContextMenu = {
      requestId,
      frame,
      contents,
      x: params.x,
      y: params.y,
      linkURL: params.linkURL,
      srcURL: params.srcURL,
      selectionText: params.selectionText,
      allowedItemIds: new Set(items.flatMap((entry) => entry.kind === 'item' && entry.enabled ? [entry.id] : [])),
    }
    const request: DesktopContextMenuRequest = { requestId, x: params.x, y: params.y, items }
    if (await this.browser?.openContextMenu(request, source) !== true) this.pendingContextMenu = undefined
  }

  private async collectPluginContextMenu(frame: WebFrameMain): Promise<PluginContextMenuCollection | undefined> {
    const collection = frame.executeJavaScript(`${CONTEXT_MENU_TRANSPORT_EXPRESSION}?.collect?.() ?? null`)
      .catch(() => undefined)
    const timeout = new Promise<undefined>((resolve) => {
      setTimeout(resolve, 75)
    })
    return parsePluginContextMenuCollection(await Promise.race([collection, timeout]))
  }

  private async selectContextMenuItem(request: DesktopContextMenuActionRequest): Promise<void> {
    if (request === null || typeof request !== 'object') return
    if (typeof request.requestId !== 'string' || typeof request.itemId !== 'string') return
    const pending = this.pendingContextMenu
    if (pending === undefined || pending.requestId !== request.requestId || !pending.allowedItemIds.has(request.itemId)) return
    this.pendingContextMenu = undefined

    const builtin = BUILTIN_CONTEXT_MENU_ACTIONS[request.itemId]
    if (builtin !== undefined) {
      await this.executeBuiltinContextMenuAction(pending, builtin)
      await this.releasePluginContextMenu(pending, false)
      return
    }
    if (request.itemId.startsWith('plugin.') && pending.pluginToken !== undefined) {
      await this.executePluginContextMenuItem(pending, request.itemId)
    }
  }

  private async dismissContextMenu(requestId: string, restoreFocus: boolean): Promise<void> {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return
    const pending = this.pendingContextMenu
    if (pending === undefined || pending.requestId !== requestId) return
    this.pendingContextMenu = undefined
    if (restoreFocus) await this.focusContextMenuFrame(pending.frame)
    await this.releasePluginContextMenu(pending, restoreFocus)
  }

  private async executeBuiltinContextMenuAction(
    pending: PendingDesktopContextMenu,
    action: (typeof BUILTIN_CONTEXT_MENU_ACTIONS)[string],
  ): Promise<void> {
    if (action === 'open-link-in-browser') {
      if (/^https?:\/\//iu.test(pending.linkURL) && this.browser?.state.settings.enabled === true) {
        await this.browser.setPanelOpen(true)
        await this.browser.navigate(pending.linkURL, false)
      }
      return
    }
    if (action === 'open-link') {
      if (/^https?:\/\//iu.test(pending.linkURL)) await shell.openExternal(pending.linkURL)
      return
    }
    if (action === 'copy-link') {
      if (/^https?:\/\//iu.test(pending.linkURL)) clipboard.writeText(pending.linkURL)
      return
    }
    if (action === 'copy-image') {
      if (await this.copyContextMenuImage(pending)) return
      await new Promise((resolve) => setTimeout(resolve, 16))
      if (!pending.contents.isDestroyed()) pending.contents.copyImageAt(pending.x, pending.y)
      return
    }
    if (pending.frame.isDestroyed()) return

    const command = action === 'select-all' ? 'selectAll' : action
    let executed = false
    try {
      executed = await pending.frame.executeJavaScript(`(() => {
        window.focus()
        const active = document.activeElement
        if (active instanceof HTMLElement) active.focus({ preventScroll: true })
        return document.execCommand(${JSON.stringify(command)})
      })()`) === true
    } catch {
      // The frame may navigate while the menu is open. The webContents fallback
      // below still handles the common case where Chromium kept its edit target.
    }
    if (executed) return

    const contents = pending.contents
    if (contents.isDestroyed()) return
    if (action === 'undo') contents.undo()
    else if (action === 'redo') contents.redo()
    else if (action === 'cut') contents.cut()
    else if (action === 'copy') {
      if (pending.selectionText.length > 0) clipboard.writeText(pending.selectionText)
      else contents.copy()
    } else if (action === 'paste') contents.paste()
    else if (action === 'select-all') contents.selectAll()
  }

  private async copyContextMenuImage(pending: PendingDesktopContextMenu): Promise<boolean> {
    if (pending.srcURL.length === 0 || pending.frame.isDestroyed()) return false
    try {
      const dataURL = await pending.frame.executeJavaScript(`(async () => {
        const response = await fetch(${JSON.stringify(pending.srcURL)})
        if (!response.ok) throw new Error('Unable to read image')
        const blob = await response.blob()
        const objectURL = URL.createObjectURL(blob)
        try {
          const image = document.createElement('img')
          image.src = objectURL
          await image.decode()
          const width = image.naturalWidth
          const height = image.naturalHeight
          if (width < 1 || height < 1 || width * height > ${MAX_CLIPBOARD_IMAGE_PIXELS}) return null
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (context === null) return null
          context.drawImage(image, 0, 0)
          return canvas.toDataURL('image/png')
        } finally {
          URL.revokeObjectURL(objectURL)
        }
      })()`)
      if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/png;base64,')) return false
      const image = nativeImage.createFromDataURL(dataURL)
      if (image.isEmpty()) return false
      clipboard.writeImage(image)
      return true
    } catch {
      // Remote images without CORS access and frames that navigate while the
      // menu is open still get Electron's coordinate-based fallback.
      return false
    }
  }

  private async executePluginContextMenuItem(pending: PendingDesktopContextMenu, itemId: string): Promise<void> {
    const token = pending.pluginToken
    if (token === undefined || pending.frame.isDestroyed()) return
    await pending.frame.executeJavaScript(
      `${CONTEXT_MENU_TRANSPORT_EXPRESSION}?.execute?.(${JSON.stringify(token)}, ${JSON.stringify(itemId)})`,
    ).catch(() => undefined)
  }

  private async focusContextMenuFrame(frame: WebFrameMain): Promise<void> {
    if (frame.isDestroyed()) return
    await frame.executeJavaScript(`(() => {
      window.focus()
      const active = document.activeElement
      if (active instanceof HTMLElement) active.focus({ preventScroll: true })
    })()`).catch(() => undefined)
  }

  private async releasePluginContextMenu(
    pending: Pick<PendingDesktopContextMenu, 'frame' | 'pluginToken'>,
    restoreFocus: boolean,
  ): Promise<void> {
    const token = pending.pluginToken
    if (token === undefined || pending.frame.isDestroyed()) return
    await pending.frame.executeJavaScript(
      `${CONTEXT_MENU_TRANSPORT_EXPRESSION}?.dismiss?.(${JSON.stringify(token)}, ${JSON.stringify(restoreFocus)})`,
    ).catch(() => undefined)
  }

  private resetContextMenu(): void {
    this.contextMenuSequence += 1
    const pending = this.pendingContextMenu
    this.pendingContextMenu = undefined
    if (pending !== undefined) void this.releasePluginContextMenu(pending, false)
  }

  private windowAction(action: WindowAction): void {
    const window = this.mustWindow()
    if (action === 'minimize') window.minimize()
    else if (action === 'toggle-maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
    else if (action === 'close') window.close()
  }

  private handleHarnessFrameLoaded(url: string): void {
    if (this.safeOrigin(url) !== this.harnessOrigin) return
    const pending = this.pendingHarnessLoad
    if (pending === undefined || pending.url !== this.harnessUrl) return
    clearTimeout(pending.timer)
    clearTimeout(pending.readyFallback)
    this.pendingHarnessLoad = undefined
    this.stopHarnessLoadProbe()
    this.harnessLifecycle = 'ready'
    this.harnessMessage = undefined
    this.runtimePreparationProgress = undefined
    this.pluginFailure = undefined
    this.startThemeSync()
    this.startPluginFailureProbe()
    this.publishState()
    pending.resolve()
  }

  private async titleMenuAction(action: TitleMenuAction): Promise<void> {
    const update = this.runtime.updateState
    if (action === 'update') {
      if (update.status === 'checking' || update.status === 'downloading') return
      if (update.status === 'ready') {
        app.relaunch()
        app.quit()
      } else {
        await this.runtime.checkForUpdates({ download: false })
      }
    } else if (action === 'open-changes') {
      await shell.openExternal(resolveHarnessReleaseUrl(this.harnessVersion))
    }
  }

  private async handleApplicationMenuAction(action: DesktopApplicationMenuAction): Promise<void> {
    await this.browser?.setPanelOpen(false)
    const window = this.window
    if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(APPLICATION_MENU_ACTION_CHANNEL, action)
  }

  private getState(): DesktopState {
    const update = this.runtime.updateState
    const updateVersions = update.versions ?? []
    return {
      appVersion: app.getVersion(),
      platform: this.desktopPlatform(),
      theme: this.theme,
      ...(this.harnessVersion !== undefined ? { harnessVersion: this.harnessVersion } : {}),
      ...(this.harnessUrl !== undefined ? { harnessUrl: this.harnessUrl } : {}),
      harnessLoadId: this.harnessLoadId,
      harnessLifecycle: this.harnessLifecycle,
      ...(this.harnessMessage !== undefined ? { harnessMessage: this.harnessMessage } : {}),
      ...(this.runtimePreparationProgress !== undefined
        ? { runtimePreparationProgress: this.runtimePreparationProgress }
        : {}),
      ...(this.pluginFailure !== undefined ? { pluginFailure: { ...this.pluginFailure } } : {}),
      disabledPlugins: this.pluginRecovery?.disabledPlugins ?? [],
      updateStatus: update.status,
      ...(update.version !== undefined ? { updateVersion: update.version } : {}),
      ...(update.latestVersion !== undefined ? { updateLatestVersion: update.latestVersion } : {}),
      ...(updateVersions.length === 0 ? {} : { updateVersions }),
      ...(update.progress !== undefined ? { updateProgress: update.progress } : {}),
      ...(update.message !== undefined ? { updateMessage: update.message } : {}),
      development: this.development.state,
      browser: this.browser?.state ?? {
        settings: { ...DEFAULT_BROWSER_SETTINGS },
        panelOpen: false,
        loading: false,
        url: '',
        title: '浏览器',
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        tabs: [],
      },
      isMaximized: this.window?.isMaximized() ?? false,
    }
  }

  private publishState(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return
    window.webContents.send(STATE_CHANNEL, this.getState())
  }

  private resourcePath(name: string): string {
    return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), name)
  }

  private findHarnessFrame(): WebFrameMain | undefined {
    const window = this.window
    if (window === undefined || window.isDestroyed() || this.harnessOrigin === undefined) return undefined
    return window.webContents.mainFrame.framesInSubtree.find((frame) => {
      if (frame.parent === null || frame.isDestroyed()) return false
      return frame.name === 'harness-frame' || this.safeOrigin(frame.url) === this.harnessOrigin
    })
  }

  private async probeHarnessFrameReady(url: string): Promise<void> {
    if (this.pendingHarnessLoad?.url !== url) return
    if (this.harnessLoadProbeInFlight) {
      this.scheduleHarnessLoadProbe(url)
      return
    }
    this.harnessLoadProbeInFlight = true
    try {
      const frame = this.findHarnessFrame()
      if (frame !== undefined && this.safeOrigin(frame.url) === this.harnessOrigin) {
        const readyState = await Promise.race([
          frame.executeJavaScript('document.readyState'),
          new Promise<undefined>((resolve) => setTimeout(resolve, 1_000)),
        ])
        if (readyState === 'interactive' || readyState === 'complete') {
          this.handleHarnessFrameLoaded(frame.url)
          return
        }
      }
    } catch {
      // The iframe may be replaced while Harness restarts; retry against the
      // newly attached frame until the normal page-load timeout expires.
    } finally {
      this.harnessLoadProbeInFlight = false
    }
    if (this.pendingHarnessLoad?.url !== url) return
    this.scheduleHarnessLoadProbe(url)
  }

  private scheduleHarnessLoadProbe(url: string): void {
    if (this.harnessLoadProbeTimer !== undefined) clearTimeout(this.harnessLoadProbeTimer)
    this.harnessLoadProbeTimer = setTimeout(() => {
      this.harnessLoadProbeTimer = undefined
      void this.probeHarnessFrameReady(url)
    }, HARNESS_LOAD_PROBE_INTERVAL_MS)
  }

  private stopHarnessLoadProbe(): void {
    if (this.harnessLoadProbeTimer !== undefined) clearTimeout(this.harnessLoadProbeTimer)
    this.harnessLoadProbeTimer = undefined
  }

  private async recoverFailedPlugin(): Promise<void> {
    if (this.pluginRecovery === undefined) throw new Error('插件恢复服务不可用。')
    const failure = this.pluginFailure
    if (failure === undefined) throw new Error('当前没有可恢复的插件初始化错误。')
    await this.pluginRecovery.disable(failure)
    await this.development.restartHarness()
  }

  private async restoreRecoveredPlugin(entryId: string): Promise<void> {
    if (this.pluginRecovery === undefined) throw new Error('插件恢复服务不可用。')
    await this.pluginRecovery.restore(entryId)
    await this.development.restartHarness()
  }

  private startPluginFailureProbe(): void {
    this.stopPluginFailureProbe()
    const deadline = Date.now() + 5_000
    const probe = (): void => {
      if (Date.now() >= deadline) {
        this.stopPluginFailureProbe()
        return
      }
      void this.detectHarnessPluginFailure()
    }
    probe()
    this.pluginFailureProbeTimer = setInterval(probe, 200)
  }

  private stopPluginFailureProbe(): void {
    if (this.pluginFailureProbeTimer !== undefined) clearInterval(this.pluginFailureProbeTimer)
    this.pluginFailureProbeTimer = undefined
  }

  private async detectHarnessPluginFailure(): Promise<void> {
    if (this.pluginFailureProbeInFlight || this.harnessOrigin === undefined) return
    const frame = this.findHarnessFrame()
    if (frame === undefined) return
    this.pluginFailureProbeInFlight = true
    try {
      const text = await frame.executeJavaScript(`(document.body?.innerText ?? '').slice(0, 32000)`) as string
      const failure = parsePluginInitializationFailure(text)
      if (failure === undefined) return
      this.setHarnessError(`插件“${failure.pluginName}”初始化失败：${failure.detail}`, failure)
    } catch {
      // The Harness iframe can be replaced while a restart is in progress.
    } finally {
      this.pluginFailureProbeInFlight = false
    }
  }

  private startThemeSync(): void {
    this.stopThemeSync()
    const probe = async (): Promise<void> => {
      if (this.themeProbeInFlight) return
      const frame = this.findHarnessFrame()
      if (frame === undefined) return
      this.themeProbeInFlight = true
      try {
        const preference = await this.readConfiguredThemePreference()
        const theme = resolveHarnessThemePreference(preference, nativeTheme.shouldUseDarkColors)
        if ((theme === 'dark' || theme === 'light') && theme !== this.theme) {
          this.theme = theme
          this.browser?.setTheme(theme)
          this.publishState()
        }
      } catch {
        // Navigation may replace the iframe while a probe is running; the next probe retries.
      } finally {
        this.themeProbeInFlight = false
      }
    }
    void probe()
    this.themeProbeTimer = setInterval(() => { void probe() }, 300)
  }

  private async readConfiguredThemePreference(): Promise<ColorThemePreference> {
    try {
      const settings = await readFile(join(this.runtime.harnessHome, 'settings.yaml'), 'utf8')
      return parseHarnessThemePreference(settings) ?? 'system'
    } catch {
      // Harness creates settings.yaml lazily; its default preference is system.
      return 'system'
    }
  }

  private async readConfiguredTheme(): Promise<ColorTheme> {
    const preference = await this.readConfiguredThemePreference()
    return resolveHarnessThemePreference(preference, nativeTheme.shouldUseDarkColors)
  }

  private stopThemeSync(): void {
    if (this.themeProbeTimer !== undefined) clearInterval(this.themeProbeTimer)
    this.themeProbeTimer = undefined
    this.themeProbeInFlight = false
  }

  private cancelPendingHarnessLoad(error: Error): void {
    this.stopHarnessLoadProbe()
    const pending = this.pendingHarnessLoad
    if (pending === undefined) return
    clearTimeout(pending.timer)
    clearTimeout(pending.readyFallback)
    this.pendingHarnessLoad = undefined
    pending.reject(error)
  }

  private safeOrigin(url: string): string | undefined {
    try {
      return new URL(url).origin
    } catch {
      return undefined
    }
  }

  private desktopPlatform(): DesktopPlatform {
    if (process.platform === 'darwin') return 'macos'
    if (process.platform === 'win32') return 'windows'
    return 'linux'
  }

  private mustWindow(): BrowserWindow {
    if (this.window === undefined || this.window.isDestroyed()) throw new Error('Desktop window is not available')
    return this.window
  }
}
