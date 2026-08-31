import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, ipcMain, nativeImage, session, shell, WebContentsView, type BrowserWindowConstructorOptions, type NativeImage, type Rectangle, type WebContents, type WebFrameMain } from 'electron'
import type {
  BrowserDisplayMode,
  BrowserMenuKind,
  ColorTheme,
  DesktopApplicationMenuState,
  DesktopBrowserHistoryEntry,
  DesktopBrowserMenuAnchor,
  DesktopBrowserSettings,
  DesktopBrowserShellSnapshot,
  DesktopBrowserState,
  DesktopBrowserTabState,
  DesktopBrowserViewBounds,
  DesktopBrowserViewport,
  DesktopBrowserNavigationAction,
} from '../shared/contracts.js'
import type { DesktopContextMenuRequest } from '../shared/context-menu.js'
import type {
  BrowserAsyncEventKind,
  BrowserAsyncEventWaiter,
  BrowserDownloadRuntime,
  BrowserPageAssetInventory,
  BrowserPageAssetKind,
  BrowserLocatorMatch,
  BrowserLocatorResolution,
  BrowserLocatorStep,
  BrowserSnapshot,
  BrowserSnapshotCache,
  BrowserTabRuntime,
  DesktopBrowserAgentRequest,
} from './desktop-browser-types.js'
import { DesktopBrowserMenuController } from './desktop-browser-menu-controller.js'
import {
  evaluatePage,
  parseLocatorPlan,
  prepareReadOnlyEvaluation,
  readNavigationState,
  readConsoleLogs,
  runNavigationWithRetry,
  strictLocator,
  targetFromRequest,
  waitForNavigation,
  waitForNavigationStability,
  waitForPage,
  type BrowserNavigationOutcome,
} from './desktop-browser-automation.js'
import {
  DEFAULT_BROWSER_SETTINGS,
  MAX_HISTORY_ENTRIES,
  finiteCoordinate,
  normalizeBrowserAddress,
  normalizeBrowserHistory,
  normalizeBrowserSettings,
  positiveInteger,
  sameBounds,
} from './desktop-browser-utils.js'
import {
  BrowserScreenshotStore,
  MAX_BROWSER_SCREENSHOT_EDGE,
  MAX_BROWSER_SCREENSHOT_PIXELS,
  cssRectToImageCrop,
  type BrowserScreenshotCacheStats,
  type BrowserScreenshotResource,
  type CssScreenshotRect,
} from './browser-screenshot-store.js'

export { DEFAULT_BROWSER_SETTINGS, normalizeBrowserAddress, normalizeBrowserSettings } from './desktop-browser-utils.js'
export type { DesktopBrowserAgentRequest } from './desktop-browser-types.js'

const BROWSER_PARTITION = 'persist:dsh-desktop-browser'
const BROWSER_PRELOAD = fileURLToPath(new URL('../browser-preload.cjs', import.meta.url))
const BROWSER_WINDOW_PRELOAD = fileURLToPath(new URL('../browser-window-preload.cjs', import.meta.url))
const POINTER_CHANNEL = 'desktop-browser:pointer'
const FLOATING_ACTION_CHANNEL = 'desktop-browser:floating-action'
const FLOATING_STATE_CHANNEL = 'desktop-browser:floating-state'
const PAGE_MENU_ACTION_CHANNEL = 'desktop-browser:page-menu-action'
const FLOATING_TOOLBAR_HEIGHT = 90
const FLOATING_DEVICE_TOOLBAR_HEIGHT = 44
const MAX_SNAPSHOT_TEXT = 14_000
const MAX_SNAPSHOT_ELEMENTS = 220
const BACKGROUND_VIEWPORT = Object.freeze({ width: 1280, height: 800 })
const EMPTY_BROWSER_URL = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{width:100%;height:100%;margin:0}</style></head><body></body></html>')}`
const MANUAL_TAB_ID = 'manual'

export function browserScreenshotCaptureWindowOptions(
  bounds: Pick<Rectangle, 'width' | 'height'>,
): BrowserWindowConstructorOptions {
  return {
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    transparent: true,
    opacity: 0,
    backgroundColor: '#00000000',
    paintWhenInitiallyHidden: true,
    x: -32_000,
    y: -32_000,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
    webPreferences: { backgroundThrottling: false },
  }
}

export function resolveBrowserTabForDisplay(
  tabs: readonly { id: string; destroyed: boolean }[],
): string | undefined {
  const manual = tabs.find((tab) => tab.id === MANUAL_TAB_ID && !tab.destroyed)
  if (manual !== undefined) return manual.id
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index]
    if (tab !== undefined && !tab.destroyed) return tab.id
  }
  return undefined
}

function inputModifierState(value: unknown): { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; mask: number } {
  if (value === undefined) return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, mask: 0 }
  if (!Array.isArray(value) || value.some((key) => !['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'].includes(String(key)))) {
    throw new Error('修饰键必须是 Alt、Control、ControlOrMeta、Meta 或 Shift 数组。')
  }
  const keys = new Set(value.map((key) => key === 'ControlOrMeta' ? process.platform === 'darwin' ? 'Meta' : 'Control' : String(key)))
  const altKey = keys.has('Alt')
  const ctrlKey = keys.has('Control')
  const metaKey = keys.has('Meta')
  const shiftKey = keys.has('Shift')
  return { altKey, ctrlKey, metaKey, shiftKey, mask: (altKey ? 1 : 0) | (ctrlKey ? 2 : 0) | (metaKey ? 4 : 0) | (shiftKey ? 8 : 0) }
}

function mouseButton(value: unknown): { cdp: 'left' | 'middle' | 'right' | 'back' | 'forward'; dom: number } {
  const normalized = value === undefined ? 'left' : value
  if (normalized === 1 || normalized === 'left') return { cdp: 'left', dom: 0 }
  if (normalized === 2 || normalized === 'middle') return { cdp: 'middle', dom: 1 }
  if (normalized === 3 || normalized === 'right') return { cdp: 'right', dom: 2 }
  if (normalized === 4) return { cdp: 'back', dom: 3 }
  if (normalized === 5) return { cdp: 'forward', dom: 4 }
  throw new Error('button 必须是 left/right/middle 或 1–5。')
}

export class DesktopBrowserService extends EventEmitter {
  private readonly settingsPath: string
  private readonly historyPath: string
  private readonly screenshotStore: BrowserScreenshotStore
  private readonly downloadsPath: string
  private readonly exportsPath: string
  private settings: DesktopBrowserSettings = { ...DEFAULT_BROWSER_SETTINGS }
  private history: DesktopBrowserHistoryEntry[] = []
  private window: BrowserWindow | undefined
  private floatingWindow: BrowserWindow | undefined
  private view: WebContentsView | undefined
  private readonly tabs = new Map<string, BrowserTabRuntime>()
  private readonly sessionTabs = new Map<string, Set<string>>()
  private readonly sessionActiveTabs = new Map<string, string>()
  private readonly agentStatuses = new Map<string, boolean>()
  private activeTabId: string | undefined
  private tabSequence = 0
  private readonly menuController: DesktopBrowserMenuController
  private viewHostWindow: BrowserWindow | undefined
  private bounds: Rectangle | undefined
  private panelOpen = false
  private zoomFactor = 1
  private viewport: DesktopBrowserViewport | undefined
  private viewportLayoutTimer: NodeJS.Timeout | undefined
  private viewportApplyRunning = false
  private viewportApplyDirty = false
  private browserSessionConfigured = false
  private closingFloatingWindow = false
  private floatingOverlayOpen = false
  private shellOverlayOpen = false
  private shellOverlaySnapshot: DesktopBrowserShellSnapshot | undefined
  private shellSnapshotCapture: Promise<DesktopBrowserShellSnapshot | undefined> | undefined
  private shellSnapshotGeneration = 0
  private shellOverlaySequence = 0
  private theme: ColorTheme = 'light'
  private browserEventSequence = 0
  private readonly fileChoosers = new Map<string, { tabId: string; backendNodeId: number; multiple: boolean }>()
  private readonly downloads = new Map<string, BrowserDownloadRuntime>()
  private readonly pageAssetInventories = new Map<string, BrowserPageAssetInventory>()
  private readonly sessionNames = new Map<string, string>()

  constructor(private readonly dataRoot: string) {
    super()
    this.menuController = new DesktopBrowserMenuController({
      getTheme: () => this.theme,
      getState: () => this.state,
      getHistory: () => this.getHistory(),
    })
    this.settingsPath = join(dataRoot, 'settings.json')
    this.historyPath = join(dataRoot, 'history.json')
    this.screenshotStore = new BrowserScreenshotStore(join(dataRoot, 'screenshots'))
    this.downloadsPath = join(dataRoot, 'downloads')
    this.exportsPath = join(dataRoot, 'exports')
  }

  async initialize(): Promise<void> {
    this.registerFloatingWindowIpc()
    await Promise.all([
      mkdir(this.dataRoot, { recursive: true }),
      mkdir(this.downloadsPath, { recursive: true }),
      mkdir(this.exportsPath, { recursive: true }),
      this.screenshotStore.initialize(),
    ])
    try {
      this.settings = normalizeBrowserSettings(JSON.parse(await readFile(this.settingsPath, 'utf8')))
    } catch {
      this.settings = { ...DEFAULT_BROWSER_SETTINGS }
      await this.writeJson(this.settingsPath, this.settings)
    }
    try {
      this.history = normalizeBrowserHistory(JSON.parse(await readFile(this.historyPath, 'utf8')))
    } catch {
      this.history = []
    }
  }

  setTheme(theme: ColorTheme): void {
    if (theme !== 'light' && theme !== 'dark') return
    this.theme = theme
    this.applyTheme(this.floatingWindow)
    this.menuController.applyTheme(theme)
  }

  get state(): DesktopBrowserState {
    const active = this.activeTab()
    const contents = active?.view.webContents
    const tabs: DesktopBrowserTabState[] = [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      ...(tab.faviconUrl === undefined ? {} : { faviconUrl: tab.faviconUrl }),
      loading: tab.loading,
      agentActive: tab.agentActive,
      sessionBound: tab.sessionId !== undefined,
      snapshotVersion: tab.snapshotVersion,
    }))
    return {
      settings: { ...this.settings },
      panelOpen: this.panelOpen && this.settings.enabled,
      loading: active?.loading ?? false,
      url: active?.url ?? '',
      title: active?.title ?? '浏览器',
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      zoomFactor: this.zoomFactor,
      tabs,
      ...(this.activeTabId === undefined ? {} : { activeTabId: this.activeTabId }),
      ...(active?.viewport === undefined ? {} : { viewport: { ...active.viewport } }),
    }
  }

  async attachWindow(window: BrowserWindow): Promise<void> {
    if (this.window === window && this.view !== undefined && !this.view.webContents.isDestroyed()) return
    this.detachWindow()
    this.window = window
    await this.menuController.ensure(window)
    if (this.settings.enabled) {
      await this.ensureView()
      if (this.settings.displayMode === 'floating' && this.panelOpen) await this.showFloatingWindow()
    }
  }

  detachWindow(): void {
    if (this.viewportLayoutTimer !== undefined) clearTimeout(this.viewportLayoutTimer)
    this.viewportLayoutTimer = undefined
    this.viewportApplyRunning = false
    this.viewportApplyDirty = false
    this.closeMenu()
    this.menuController.destroy()
    this.view = undefined
    this.viewHostWindow = undefined
    this.activeTabId = undefined
    this.window = undefined
    this.bounds = undefined
    this.shellOverlayOpen = false
    this.shellOverlaySnapshot = undefined
    this.destroyFloatingWindow()
    for (const tab of this.tabs.values()) this.destroyTabRuntime(tab)
    this.tabs.clear()
    this.sessionTabs.clear()
    this.sessionActiveTabs.clear()
    this.pageAssetInventories.clear()
  }

  async updateSettings(value: unknown): Promise<DesktopBrowserSettings> {
    this.closeMenu()
    this.shellOverlayOpen = false
    this.shellOverlaySnapshot = undefined
    const next = normalizeBrowserSettings(value)
    const previousDisplayMode = this.settings.displayMode
    const enabledChanged = next.enabled !== this.settings.enabled
    const displayModeChanged = next.displayMode !== this.settings.displayMode
    this.settings = next
    await this.writeJson(this.settingsPath, next)
    if (enabledChanged) {
      if (next.enabled) await this.ensureView()
      else {
        this.panelOpen = false
        this.destroyView()
      }
    }
    if (next.enabled && displayModeChanged) {
      if (next.displayMode === 'floating') {
        this.bounds = undefined
        if (this.panelOpen) await this.showFloatingWindow()
      } else {
        this.leaveFloatingWindow(previousDisplayMode === 'floating')
      }
    }
    this.changed()
    return { ...this.settings }
  }

  async setDisplayMode(mode: BrowserDisplayMode): Promise<void> {
    if (mode !== 'split' && mode !== 'drawer' && mode !== 'floating') return
    await this.updateSettings({ ...this.settings, displayMode: mode })
  }

  async selectTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    const main = this.window
    if (tab === undefined || tab.view.webContents.isDestroyed() || main === undefined || main.isDestroyed()) return
    this.closeMenu()
    this.invalidateShellSnapshot()
    const previous = this.activeTab()
    if (previous !== undefined && previous !== tab) previous.view.setVisible(false)
    this.activeTabId = tab.id
    tab.lastOpened = new Date().toISOString()
    this.view = tab.view
    if (tab.sessionId !== undefined) {
      this.sessionActiveTabs.set(tab.sessionId, tab.id)
      this.refreshSessionAgentTabs(tab.sessionId)
    }
    this.viewport = tab.viewport === undefined ? undefined : { ...tab.viewport }
    const target = this.panelOpen && this.settings.displayMode === 'floating'
      ? await this.ensureFloatingWindow()
      : main
    this.attachViewToWindow(tab.view, target)
    tab.view.webContents.setZoomFactor(this.zoomFactor)
    if (target === this.floatingWindow) this.layoutFloatingView()
    else if (this.bounds !== undefined) tab.view.setBounds(this.bounds)
    else tab.view.setBounds({ x: 0, y: 0, ...BACKGROUND_VIEWPORT })
    await this.applyViewport()
    this.setNativeVisible(true)
    this.changed()
  }

  async closeTab(tabId: string, hideBrowserWhenLast = false): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    const tabOrder = [...this.tabs.keys()]
    const tabIndex = tabOrder.indexOf(tab.id)
    const adjacentTabId = tabOrder[tabIndex + 1] ?? tabOrder[tabIndex - 1]
    const closesLastVisibleTab = hideBrowserWhenLast && this.tabs.size === 1
    const wasActive = this.activeTabId === tab.id
    this.tabs.delete(tab.id)
    for (const [inventoryId, inventory] of this.pageAssetInventories) {
      if (inventory.tabId === tab.id) this.pageAssetInventories.delete(inventoryId)
    }
    if (tab.sessionId !== undefined) {
      const sessionTabIds = this.sessionTabs.get(tab.sessionId)
      sessionTabIds?.delete(tab.id)
      if (sessionTabIds?.size === 0) this.sessionTabs.delete(tab.sessionId)
      if (this.sessionActiveTabs.get(tab.sessionId) === tab.id) {
        const nextSessionTab = sessionTabIds === undefined ? undefined : [...sessionTabIds].at(-1)
        if (nextSessionTab === undefined) this.sessionActiveTabs.delete(tab.sessionId)
        else this.sessionActiveTabs.set(tab.sessionId, nextSessionTab)
      }
      this.refreshSessionAgentTabs(tab.sessionId)
    }
    this.destroyTabRuntime(tab)
    if (closesLastVisibleTab) {
      this.view = undefined
      this.viewHostWindow = undefined
      this.activeTabId = undefined
      this.viewport = undefined
      await this.setPanelOpen(false)
      return
    }
    if (!wasActive) {
      this.changed()
      return
    }
    this.view = undefined
    this.viewHostWindow = undefined
    this.activeTabId = undefined
    const next = adjacentTabId === undefined ? undefined : this.tabs.get(adjacentTabId)
    if (next !== undefined) await this.selectTab(next.id)
    else if (this.settings.enabled && this.window !== undefined && !this.window.isDestroyed()) {
      const manual = await this.createTab(MANUAL_TAB_ID)
      await this.selectTab(manual.id)
    } else this.changed()
  }

  async createManualTab(): Promise<void> {
    if (!this.settings.enabled) return
    const tab = await this.createTab(`manual-${(++this.tabSequence).toString(36)}`)
    await this.selectTab(tab.id)
    if (!this.panelOpen) await this.setPanelOpen(true)
  }

  updateAgentStatus(value: unknown): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const source = value as Record<string, unknown>
    if (typeof source.sessionId !== 'string' || source.sessionId.length === 0 || source.sessionId.length > 240 || /[\r\n]/u.test(source.sessionId)) return
    if (source.status !== 'running' && source.status !== 'idle') return
    const active = source.status === 'running'
    this.agentStatuses.set(source.sessionId, active)
    if (this.refreshSessionAgentTabs(source.sessionId)) this.changed()
  }

  async openPageMenu(kind: BrowserMenuKind, anchor: DesktopBrowserMenuAnchor, applicationState?: DesktopApplicationMenuState): Promise<void> {
    if (kind !== 'application' && kind !== 'display' && kind !== 'settings') return
    if (kind === 'application' && applicationState === undefined) return
    if (![anchor.x, anchor.y, anchor.width, anchor.height].every(Number.isFinite)) return
    const host = kind === 'application'
      ? this.window
      : this.settings.displayMode === 'floating'
        ? this.floatingWindow
        : this.window
    if (host === undefined || host.isDestroyed()) return
    await this.menuController.openPage(kind, host, anchor, applicationState)
  }

  async openContextMenu(request: DesktopContextMenuRequest, source: 'main' | 'floating' | 'page' = 'main'): Promise<boolean> {
    const host = source === 'floating'
      ? this.floatingWindow
      : source === 'page'
        ? this.viewHostWindow
        : this.window
    const viewBounds = this.view?.getBounds()
    const sourceMatchesHost = source === 'page'
      ? this.viewHostWindow === host
      : source === 'floating'
        ? this.floatingWindow === host
        : this.window === host
    if (
      host === undefined
      || host.isDestroyed()
      || !this.settings.enabled
      || !this.panelOpen
      || this.view === undefined
      || this.view.webContents.isDestroyed()
      || !sourceMatchesHost
      || viewBounds === undefined
      || !Number.isFinite(request.x)
      || !Number.isFinite(request.y)
    ) return false

    const hostRequest = source === 'page'
      ? { ...request, x: request.x + viewBounds.x, y: request.y + viewBounds.y }
      : request
    return await this.menuController.openContext(host, hostRequest)
  }

  ownsMenuWebContents(contents: WebContents): boolean {
    return this.menuController.owns(contents)
  }

  updateContextMenu(request: DesktopContextMenuRequest): boolean {
    return this.menuController.updateContext(request)
  }

  closeMenu(): string | undefined {
    return this.menuController.close()
  }

  async setZoomFactor(value: number): Promise<void> {
    if (!Number.isFinite(value)) return
    this.zoomFactor = Math.max(0.5, Math.min(2, Math.round(value * 10) / 10))
    this.invalidateShellSnapshot()
    const contents = (await this.ensureView()).webContents
    contents.setZoomFactor(this.zoomFactor)
    this.changed()
  }

  async setDeviceViewport(value: DesktopBrowserViewport | null): Promise<void> {
    this.invalidateShellSnapshot()
    const tab = this.activeTab()
    if (value === null) {
      this.viewport = undefined
      if (tab !== undefined) delete tab.viewport
      const contents = this.view?.webContents
      if (contents !== undefined && !contents.isDestroyed() && contents.debugger.isAttached()) {
        await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
      }
      this.layoutFloatingView()
      this.changed()
      return
    }
    this.viewport = {
      width: positiveInteger(value.width, 'width', 240, 3840),
      height: positiveInteger(value.height, 'height', 240, 2160),
    }
    if (tab !== undefined) tab.viewport = { ...this.viewport }
    this.layoutFloatingView()
    await this.applyViewport()
    this.changed()
  }

  async previewDeviceViewport(value: DesktopBrowserViewport): Promise<void> {
    this.invalidateShellSnapshot()
    this.viewport = {
      width: positiveInteger(value.width, 'width', 240, 3840),
      height: positiveInteger(value.height, 'height', 240, 2160),
    }
    const tab = this.activeTab()
    if (tab !== undefined) tab.viewport = { ...this.viewport }
    if (this.settings.displayMode === 'floating') this.layoutFloatingView()
    else this.scheduleViewportApply()
  }

  async setPanelOpen(open: boolean): Promise<void> {
    this.closeMenu()
    if (!this.settings.enabled) {
      this.panelOpen = false
      this.shellOverlayOpen = false
      this.shellOverlaySnapshot = undefined
      this.changed()
      return
    }
    if (open) await this.ensureView()
    this.panelOpen = open
    if (open && this.settings.displayMode === 'floating') {
      await this.showFloatingWindow()
    } else if (!open) {
      this.floatingOverlayOpen = false
      this.shellOverlayOpen = false
      this.shellOverlaySnapshot = undefined
      this.setNativeVisible(false)
      this.floatingWindow?.hide()
      this.bounds = undefined
      this.view?.setBounds({ x: 0, y: 0, ...BACKGROUND_VIEWPORT })
      await this.applyViewport()
    }
    this.changed()
  }

  async setViewBounds(value: DesktopBrowserViewBounds | null): Promise<void> {
    if (this.settings.displayMode === 'floating') {
      if (this.panelOpen && this.settings.enabled) await this.showFloatingWindow()
      return
    }
    if (value === null || !this.settings.enabled || !this.panelOpen) {
      this.bounds = undefined
      this.setNativeVisible(false)
      return
    }
    const bounds: Rectangle = {
      x: Math.max(0, Math.round(value.x)),
      y: Math.max(0, Math.round(value.y)),
      width: Math.max(1, Math.round(value.width)),
      height: Math.max(1, Math.round(value.height)),
    }
    const view = await this.ensureView()
    if (this.bounds === undefined || !sameBounds(this.bounds, bounds)) this.invalidateShellSnapshot()
    this.bounds = bounds
    view.setBounds(bounds)
    this.scheduleViewportApply()
    this.setNativeVisible(true)
  }

  async refreshShellSnapshot(): Promise<DesktopBrowserShellSnapshot | undefined> {
    if (this.shellOverlayOpen) return this.shellOverlaySnapshot
    if (this.shellSnapshotCapture !== undefined) return await this.shellSnapshotCapture
    const view = this.view
    const viewUrl = view?.webContents.getURL()
    const generation = this.shellSnapshotGeneration
    if (
      view === undefined
      || view.webContents.isDestroyed()
      || this.bounds === undefined
      || !this.settings.enabled
      || !this.panelOpen
      || this.settings.displayMode === 'floating'
    ) return undefined

    const capture = (async (): Promise<DesktopBrowserShellSnapshot | undefined> => {
      if (this.viewport !== undefined) {
        if (this.viewportLayoutTimer !== undefined) clearTimeout(this.viewportLayoutTimer)
        this.viewportLayoutTimer = undefined
        await this.applyViewport()
      }
      const viewBounds = this.bounds
      if (viewBounds === undefined || generation !== this.shellSnapshotGeneration) return undefined
      const capturedImage = await view.webContents.capturePage().catch(() => undefined)
      if (
        capturedImage === undefined
        || capturedImage.isEmpty()
        || generation !== this.shellSnapshotGeneration
        || this.view !== view
        || this.viewHostWindow !== this.window
        || this.bounds === undefined
        || !sameBounds(this.bounds, viewBounds)
        || view.webContents.getURL() !== viewUrl
        || !this.panelOpen
      ) return undefined
      // Device emulation keeps a logical viewport (for example 583x860) and
      // applies a compositor scale so it fits the smaller WebContentsView.
      // capturePage() returns that logical surface at the display's pixel
      // density, including the unused area outside the physical view. Crop in
      // captured-image pixels so the shell neither reapplies the device scale
      // nor loses the display scale factor.
      const imageSize = capturedImage.getSize()
      const captureScaleX = this.viewport === undefined ? 1 : imageSize.width / this.viewport.width
      const captureScaleY = this.viewport === undefined ? 1 : imageSize.height / this.viewport.height
      const cropWidth = Math.min(imageSize.width, Math.max(1, Math.round(viewBounds.width * captureScaleX)))
      const cropHeight = Math.min(imageSize.height, Math.max(1, Math.round(viewBounds.height * captureScaleY)))
      const image = this.viewport !== undefined
        && cropWidth > 0
        && cropHeight > 0
        && (cropWidth < imageSize.width || cropHeight < imageSize.height)
        ? capturedImage.crop({ x: 0, y: 0, width: cropWidth, height: cropHeight })
        : capturedImage
      const jpeg = image.toJPEG(80)
      if (jpeg.length === 0) return undefined
      const snapshot = {
        dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        bounds: { ...viewBounds },
      }
      this.shellOverlaySnapshot = snapshot
      return snapshot
    })()
    this.shellSnapshotCapture = capture
    try {
      return await capture
    } finally {
      if (this.shellSnapshotCapture === capture) this.shellSnapshotCapture = undefined
    }
  }

  private invalidateShellSnapshot(): void {
    this.shellSnapshotGeneration += 1
    this.shellOverlaySnapshot = undefined
    this.shellSnapshotCapture = undefined
  }

  async setShellOverlay(value: DesktopBrowserViewBounds | null): Promise<DesktopBrowserShellSnapshot | undefined> {
    const sequence = ++this.shellOverlaySequence
    if (value === null) {
      this.shellOverlayOpen = false
      this.setNativeVisible(true)
      return undefined
    }
    const overlay: Rectangle = {
      x: Math.round(value.x),
      y: Math.round(value.y),
      width: Math.max(0, Math.round(value.width)),
      height: Math.max(0, Math.round(value.height)),
    }
    const view = this.view
    const viewBounds = this.bounds
    const overlaps = viewBounds !== undefined
      && overlay.width > 0
      && overlay.height > 0
      && overlay.x < viewBounds.x + viewBounds.width
      && overlay.x + overlay.width > viewBounds.x
      && overlay.y < viewBounds.y + viewBounds.height
      && overlay.y + overlay.height > viewBounds.y
    if (
      !overlaps
      || view === undefined
      || view.webContents.isDestroyed()
      || !this.settings.enabled
      || !this.panelOpen
      || this.settings.displayMode === 'floating'
    ) {
      this.shellOverlayOpen = false
      this.setNativeVisible(true)
      return undefined
    }
    const currentBounds = view.getBounds()
    if (this.shellOverlaySnapshot !== undefined && sameBounds(this.shellOverlaySnapshot.bounds, currentBounds)) {
      return this.shellOverlaySnapshot
    }
    const snapshot = await this.refreshShellSnapshot()
    return sequence === this.shellOverlaySequence ? snapshot : undefined
  }

  commitShellOverlay(): void {
    const viewBounds = this.view?.getBounds()
    if (
      this.shellOverlaySnapshot === undefined
      || viewBounds === undefined
      || !sameBounds(this.shellOverlaySnapshot.bounds, viewBounds)
    ) return
    this.shellOverlayOpen = true
    this.setNativeVisible(false)
  }

  async navigate(value: string, allowSearch = true): Promise<void> {
    if (!this.settings.enabled) throw new Error('内置浏览器已在设置中关闭。')
    const tab = this.activeTab() ?? this.tabForView(await this.ensureView())
    if (tab === undefined) throw new Error('浏览器标签页未准备完成。')
    await this.navigateTab(tab, value, allowSearch)
  }

  async navigationAction(action: DesktopBrowserNavigationAction): Promise<void> {
    const tab = this.activeTab() ?? this.tabForView(await this.ensureView())
    if (tab === undefined) return
    await this.navigationActionFor(tab, action)
  }

  private async navigateTab(tab: BrowserTabRuntime, value: string, allowSearch = true): Promise<BrowserNavigationOutcome> {
    const url = normalizeBrowserAddress(value, allowSearch)
    const before = await readNavigationState(tab, this.debuggerCommandFor.bind(this))
    const replaceSyntheticBlank = tab.syntheticBlankHistory
    await tab.view.webContents.loadURL(url)
    if (replaceSyntheticBlank && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.navigationHistory.clear()
      tab.syntheticBlankHistory = false
    }
    return await waitForNavigationStability(tab, before, {
      timeoutMs: 10_000,
      waitUntil: 'load',
      expectedUrl: url,
      requireNavigation: true,
    }, this.debuggerCommandFor.bind(this))
  }

  private async historyNavigationFor(
    tab: BrowserTabRuntime,
    action: 'back' | 'forward',
  ): Promise<Record<string, unknown>> {
    const before = await readNavigationState(tab, this.debuggerCommandFor.bind(this))
    const history = await this.debuggerCommandFor(tab, 'Page.getNavigationHistory') as {
      currentIndex?: unknown
      entries?: Array<{ id?: unknown; url?: unknown; title?: unknown }>
    }
    const currentIndex = typeof history.currentIndex === 'number' && Number.isSafeInteger(history.currentIndex)
      ? history.currentIndex
      : -1
    const entries = Array.isArray(history.entries) ? history.entries : []
    const targetIndex = currentIndex + (action === 'back' ? -1 : 1)
    const target = entries[targetIndex]
    if (target === undefined || typeof target.id !== 'number' || typeof target.url !== 'string') {
      return {
        ok: true,
        status: 'no-op',
        reason: 'no-history-entry',
        tabId: tab.id,
        action,
        attempts: 0,
        url: before.url,
      }
    }
    const targetId = target.id
    const targetUrl = target.url

    const retry = await runNavigationWithRetry(
      async () => {
        await this.debuggerCommandFor(tab, 'Page.navigateToHistoryEntry', { entryId: targetId })
      },
      async () => await waitForNavigationStability(tab, before, {
        timeoutMs: 8_000,
        waitUntil: 'load',
        expectedUrl: targetUrl,
        requireNavigation: true,
      }, this.debuggerCommandFor.bind(this)),
    )
    if (retry.outcome?.status === 'success') {
      return {
        ok: true,
        status: 'success',
        tabId: tab.id,
        action,
        attempts: retry.attempts,
        url: retry.outcome.state.url,
        elapsedMs: retry.outcome.elapsedMs,
        canGoBack: targetIndex > 0,
        canGoForward: targetIndex < entries.length - 1,
      }
    }
    const latest = retry.outcome?.state ?? await readNavigationState(tab, this.debuggerCommandFor.bind(this))
    return {
      ok: false,
      status: 'timeout',
      reason: retry.error instanceof Error ? retry.error.message : retry.outcome?.reason ?? 'history-navigation-failed',
      tabId: tab.id,
      action,
      attempts: retry.attempts,
      expectedUrl: targetUrl,
      url: latest.url,
      observedTitle: latest.title,
    }
  }

  private async navigationActionFor(tab: BrowserTabRuntime, action: DesktopBrowserNavigationAction): Promise<Record<string, unknown>> {
    if (action === 'back' || action === 'forward') return await this.historyNavigationFor(tab, action)
    const contents = tab.view.webContents
    if (action === 'stop') {
      const started = tab.loading
      if (started) contents.stop()
      return { ok: true, status: started ? 'success' : 'no-op', tabId: tab.id, action, started }
    }
    if (action !== 'reload') return { ok: true, status: 'no-op', tabId: tab.id, action }
    const before = await readNavigationState(tab, this.debuggerCommandFor.bind(this))
    contents.reload()
    const outcome = await waitForNavigationStability(tab, before, {
      timeoutMs: 10_000,
      waitUntil: 'load',
      requireNavigation: true,
    }, this.debuggerCommandFor.bind(this))
    return {
      ok: outcome.status === 'success',
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      tabId: tab.id,
      action,
      url: outcome.state.url,
      elapsedMs: outcome.elapsedMs,
    }
  }

  getHistory(): DesktopBrowserHistoryEntry[] {
    return this.history.map((entry) => ({ ...entry }))
  }

  async clearHistory(): Promise<void> {
    this.history = []
    await this.writeJson(this.historyPath, { entries: [] })
    this.changed()
  }

  async clearBrowsingData(): Promise<void> {
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    await Promise.all([
      browserSession.clearCache(),
      browserSession.clearStorageData(),
      browserSession.clearAuthCache(),
    ])
  }

  async clearScreenshotCache(): Promise<BrowserScreenshotCacheStats> {
    return await this.screenshotStore.clear()
  }

  async screenshotCacheStats(): Promise<BrowserScreenshotCacheStats> {
    return await this.screenshotStore.stats()
  }

  async revealScreenshotCache(): Promise<void> {
    await mkdir(this.screenshotStore.rootPath, { recursive: true })
    const error = await shell.openPath(this.screenshotStore.rootPath)
    if (error.length > 0) throw new Error(`无法打开浏览器截图缓存：${error}`)
  }

  getScreenshotResource(resourceId: string): BrowserScreenshotResource | undefined {
    return this.screenshotStore.get(resourceId)
  }

  async handleAgentRequest(request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    const action = typeof request.action === 'string' ? request.action : ''
    if (!this.settings.enabled && action !== 'status') throw new Error('内置浏览器已在设置中关闭。')
    const sessionId = this.agentSessionId(request)
    if (action === 'status' || action === 'tabs') {
      return {
        ok: true,
        enabled: this.settings.enabled,
        panelOpen: this.panelOpen,
        activeTabId: this.sessionActiveTabs.get(sessionId) ?? null,
        tabs: this.sessionTabStates(sessionId),
      }
    }
    if (action === 'name-session') {
      if (typeof request.name !== 'string' || request.name.trim().length === 0 || request.name.length > 160) throw new Error('name 必须是非空短字符串。')
      this.sessionNames.set(sessionId, request.name.trim())
      return { ok: true, name: request.name.trim() }
    }
    if (action === 'user-tabs') {
      const tabs = [...this.tabs.values()].filter((tab) => tab.sessionId === undefined && !tab.view.webContents.isDestroyed()).map((tab) => {
        this.capturePageState(tab)
        return { id: tab.id, providerTabId: tab.id, title: tab.title, url: tab.url, lastOpened: tab.lastOpened }
      }).sort((left, right) => right.lastOpened.localeCompare(left.lastOpened))
      return { ok: true, tabs }
    }
    if (action === 'claim-tab') {
      if (request.userTab === null || typeof request.userTab !== 'object' || Array.isArray(request.userTab)) throw new Error('userTab 必须来自 browser.user.openTabs()。')
      const value = request.userTab as Record<string, unknown>
      const id = typeof value.providerTabId === 'string' ? value.providerTabId : value.id
      if (typeof id !== 'string' || id.length === 0) throw new Error('userTab 缺少有效 id。')
      const tab = this.tabs.get(id)
      if (tab === undefined || tab.sessionId !== undefined || tab.view.webContents.isDestroyed()) throw new Error('用户标签页已不可用或已被其他会话接管。')
      this.capturePageState(tab)
      if (value.title !== undefined && value.title !== tab.title) throw new Error('用户标签页标题已变化，请重新调用 openTabs()。')
      if (value.url !== undefined && value.url !== tab.url) throw new Error('用户标签页 URL 已变化，请重新调用 openTabs()。')
      this.agentStatuses.set(sessionId, true)
      tab.claimedFromUser = true
      this.bindAgentTab(tab, sessionId)
      return { ok: true, tabId: tab.id, title: tab.title, url: tab.url }
    }
    if (action === 'browser-history') {
      const queries = request.queries === undefined ? [] : request.queries
      if (!Array.isArray(queries) || queries.length > 12 || queries.some((query) => typeof query !== 'string' || query.trim().length === 0)) {
        throw new Error('queries 必须是最多 12 个非空字符串。')
      }
      const parseBound = (value: unknown, name: string): number | undefined => {
        if (value === undefined) return undefined
        if (typeof value !== 'string') throw new Error(`${name} 必须是 ISO 日期字符串。`)
        const timestamp = Date.parse(value)
        if (!Number.isFinite(timestamp)) throw new Error(`${name} 不是有效日期。`)
        return timestamp
      }
      const from = parseBound(request.from, 'from')
      const to = parseBound(request.to, 'to')
      const limit = request.limit === undefined ? 100 : positiveInteger(request.limit, 'limit', 1, 500)
      const terms = (queries as string[]).map((query) => query.toLocaleLowerCase())
      const entries = this.history.filter((entry) => {
        const timestamp = Date.parse(entry.visitedAt)
        const haystack = `${entry.title}\n${entry.url}`.toLocaleLowerCase()
        return (from === undefined || timestamp >= from) && (to === undefined || timestamp <= to)
          && (terms.length === 0 || terms.some((term) => haystack.includes(term)))
      }).slice(0, limit).map((entry) => ({ dateVisited: entry.visitedAt, title: entry.title, url: entry.url }))
      return { ok: true, entries }
    }
    if (action === 'browser-visibility') {
      if (request.visible === undefined) return { ok: true, visible: this.panelOpen && this.settings.enabled }
      if (typeof request.visible !== 'boolean') throw new Error('visible 必须是布尔值。')
      if (request.visible) {
        const tab = await this.agentTabForRequest(sessionId, request)
        await this.selectTab(tab.id)
      }
      await this.setPanelOpen(request.visible)
      return { ok: true, visible: this.panelOpen && this.settings.enabled }
    }
    if (action === 'browser-viewport') {
      const tab = await this.agentTabForRequest(sessionId, request)
      return await this.setViewport(tab, request)
    }
    if (action === 'new') {
      this.agentStatuses.set(sessionId, true)
      const tab = await this.createAgentTab(sessionId, true)
      const visible = this.settings.agentOpenMode === 'visible'
      if (visible) {
        await this.selectTab(tab.id)
        await this.setPanelOpen(true)
      }
      return { ok: true, tabId: tab.id, title: tab.title, url: tab.url, visible }
    }
    if (action === 'finalize') {
      const keep = new Set<string>()
      for (const tabId of this.sessionTabs.get(sessionId) ?? []) {
        if (this.tabs.get(tabId)?.retentionMark !== undefined) keep.add(tabId)
      }
      if (request.keep !== undefined && !Array.isArray(request.keep)) throw new Error('keep 必须是数组。')
      for (const entry of request.keep ?? []) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('keep 项格式无效。')
        const tabId = (entry as Record<string, unknown>).tabId
        const status = (entry as Record<string, unknown>).status
        if (typeof tabId !== 'string' || tabId.length === 0) throw new Error('keep 项缺少 tabId。')
        if (status !== 'handoff' && status !== 'completed') throw new Error('keep 项 status 必须是 handoff 或 completed。')
        if (!this.sessionTabs.get(sessionId)?.has(tabId)) throw new Error('保留的浏览器标签不属于当前 DSH 会话。')
        keep.add(tabId)
      }
      const closed: string[] = []
      const released: string[] = []
      for (const tabId of [...this.sessionTabs.get(sessionId) ?? []]) {
        const tab = this.tabs.get(tabId)
        if (keep.has(tabId)) {
          if (tab !== undefined) delete tab.retentionMark
          continue
        }
        if (tab?.claimedFromUser === true) {
          this.releaseClaimedTab(tab)
          released.push(tabId)
          continue
        }
        await this.closeTab(tabId)
        closed.push(tabId)
      }
      return { ok: true, closed, released, tabs: this.sessionTabStates(sessionId) }
    }
    this.agentStatuses.set(sessionId, true)
    const tab = await this.agentTabForRequest(sessionId, request)
    if (action === 'navigate') {
      if (typeof request.url !== 'string') throw new Error('url 是必填项。')
      const outcome = await this.navigateTab(tab, request.url, false)
      return {
        ok: outcome.status === 'success',
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        tabId: tab.id,
        url: outcome.state.url || normalizeBrowserAddress(request.url, false),
        elapsedMs: outcome.elapsedMs,
      }
    }
    if (action === 'snapshot') return await this.snapshot(tab)
    if (action === 'wait') return await waitForPage(tab, request, this.debuggerCommandFor.bind(this), this.snapshot.bind(this))
    if (action === 'navigation-state') {
      const state = await readNavigationState(tab, this.debuggerCommandFor.bind(this))
      return { ok: true, tabId: tab.id, version: state.version, url: state.url, title: state.title, before: state }
    }
    if (action === 'wait-navigation') return await waitForNavigation(tab, request, true, this.debuggerCommandFor.bind(this))
    if (action === 'wait-url') return await waitForNavigation(tab, request, false, this.debuggerCommandFor.bind(this))
    if (action === 'wait-timeout') {
      const timeoutMs = positiveInteger(request.timeoutMs, 'timeoutMs', 1, 30_000)
      await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      return { ok: true, tabId: tab.id, timeoutMs }
    }
    if (action === 'evaluate') return await evaluatePage(tab, request, this.debuggerCommandFor.bind(this))
    if (action === 'logs') return readConsoleLogs(tab, request)
    if (action === 'wait-event') return await this.waitForBrowserEvent(tab, request)
    if (action === 'filechooser-set-files') return await this.setFileChooserFiles(tab, request)
    if (action === 'download-path') return await this.downloadPath(tab, request)
    if (action === 'get-dialog') {
      await this.ensureDebuggerEvents(tab)
      return { ok: true, tabId: tab.id, dialog: tab.jsDialog ?? null }
    }
    if (action === 'handle-dialog') return await this.handleJsDialog(tab, request)
    if (action === 'mark-tab') {
      if (request.status !== 'handoff' && request.status !== 'completed') throw new Error('status 必须是 handoff 或 completed。')
      tab.retentionMark = request.status
      return { ok: true, tabId: tab.id, status: request.status }
    }
    if (action.startsWith('clipboard-')) return this.clipboardAction(tab, action, request)
    if (action === 'content-export' || action === 'content-export-gsuite' || action === 'content-export-youtube') {
      return await this.exportTabContent(tab, action, request)
    }
    if (action === 'page-assets-list') return await this.listPageAssets(tab)
    if (action === 'page-assets-bundle') return await this.bundlePageAssets(tab, request)
    if (action === 'locator') return await this.locatorAction(tab, request)
    if (action === 'hover') return await this.hover(tab, request)
    if (action === 'click') return await this.click(tab, request)
    if (action === 'drag') return await this.drag(tab, request)
    if (action === 'press') return await this.pressKey(tab, request)
    if (action === 'select-option') return await this.selectOption(tab, request)
    if (action === 'type') return await this.typeText(tab, request)
    if (action === 'scroll') return await this.scroll(tab, request)
    if (action === 'screenshot') return await this.screenshot(tab, request)
    if (action === 'element-screenshot') return await this.elementScreenshot(tab, request)
    if (action === 'viewport') return await this.setViewport(tab, request)
    if (action === 'visibility') {
      if (typeof request.visible !== 'boolean') throw new Error('visible 是必填布尔值。')
      if (request.visible) await this.selectTab(tab.id)
      await this.setPanelOpen(request.visible)
      return { ok: true, tabId: tab.id, visible: this.panelOpen }
    }
    if (action === 'back' || action === 'forward' || action === 'reload' || action === 'stop') {
      return await this.navigationActionFor(tab, action)
    }
    if (action === 'close') {
      await this.closeTab(tab.id)
      return { ok: true, tabId: tab.id }
    }
    throw new Error(`不支持的浏览器操作：${action || 'unknown'}`)
  }

  private clipboardAction(tab: BrowserTabRuntime, action: string, request: DesktopBrowserAgentRequest): Record<string, unknown> {
    if (action === 'clipboard-read-text') return { ok: true, tabId: tab.id, text: clipboard.readText() }
    if (action === 'clipboard-write-text') {
      if (typeof request.text !== 'string') throw new Error('text 必须是字符串。')
      clipboard.writeText(request.text)
      return { ok: true, tabId: tab.id }
    }
    if (action === 'clipboard-read') {
      const entries: Array<Record<string, unknown>> = []
      const formats = new Set(clipboard.availableFormats())
      const text = clipboard.readText()
      if (text.length > 0 || formats.has('text/plain')) entries.push({ mimeType: 'text/plain', text })
      const html = clipboard.readHTML()
      if (html.length > 0 || formats.has('text/html')) entries.push({ mimeType: 'text/html', text: html })
      const image = clipboard.readImage()
      if (!image.isEmpty()) entries.push({ mimeType: 'image/png', base64: image.toPNG().toString('base64') })
      return { ok: true, tabId: tab.id, items: entries.length === 0 ? [] : [{ entries, presentationStyle: 'unspecified' }] }
    }
    if (action === 'clipboard-write') {
      if (!Array.isArray(request.items) || request.items.length === 0) throw new Error('items 必须是非空剪贴板项数组。')
      let text: string | undefined
      let html: string | undefined
      let image: NativeImage | undefined
      for (const item of request.items) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('clipboard item 格式无效。')
        const entries = (item as Record<string, unknown>).entries
        if (!Array.isArray(entries) || entries.length === 0) throw new Error('clipboard item.entries 必须是非空数组。')
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('clipboard entry 格式无效。')
          const value = entry as Record<string, unknown>
          if (value.mimeType === 'text/plain' && typeof value.text === 'string') text = value.text
          else if (value.mimeType === 'text/html' && typeof value.text === 'string') html = value.text
          else if (value.mimeType === 'image/png' && typeof value.base64 === 'string') {
            image = nativeImage.createFromBuffer(Buffer.from(value.base64, 'base64'))
            if (image.isEmpty()) throw new Error('image/png 剪贴板数据无效。')
          } else throw new Error(`不支持的剪贴板 MIME：${String(value.mimeType)}`)
        }
      }
      clipboard.write({ ...(text === undefined ? {} : { text }), ...(html === undefined ? {} : { html }), ...(image === undefined ? {} : { image }) })
      return { ok: true, tabId: tab.id }
    }
    throw new Error(`不支持的剪贴板操作：${action}`)
  }

  private exportArtifactPath(tab: BrowserTabRuntime, extension: string, label = 'page'): string {
    const title = (tab.title || label).replaceAll(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 80) || label
    this.browserEventSequence += 1
    return join(this.exportsPath, `${Date.now().toString(36)}-${this.browserEventSequence.toString(36)}-${title}.${extension}`)
  }

  private async fetchArtifact(tab: BrowserTabRuntime, url: string, path: string): Promise<string> {
    const response = await tab.view.webContents.session.fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`导出下载失败：HTTP ${String(response.status)}`)
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    return path
  }

  private async exportTabContent(tab: BrowserTabRuntime, action: string, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (action === 'content-export') {
      const path = this.exportArtifactPath(tab, 'html')
      await tab.view.webContents.savePage(path, 'HTMLComplete')
      return { ok: true, tabId: tab.id, path }
    }
    if (action === 'content-export-gsuite') {
      const type = request.exportType
      if (!['pdf', 'md', 'xlsx', 'csv', 'docx', 'pptx'].includes(String(type))) throw new Error('不支持的 Google Workspace 导出类型。')
      const current = new URL(tab.view.webContents.getURL())
      if (current.hostname !== 'docs.google.com') throw new Error('当前标签不是 Google Workspace 文档。')
      const match = current.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/u)
      if (match === null) throw new Error('无法从当前 Google Workspace URL 识别文档。')
      const [, product, id] = match
      const exportType = String(type)
      let exportUrl: string
      if (product === 'presentation') exportUrl = `https://docs.google.com/presentation/d/${id}/export/${exportType}`
      else {
        const format = exportType === 'md' ? 'txt' : exportType
        exportUrl = `https://docs.google.com/${product}/d/${id}/export?format=${format}`
      }
      const path = this.exportArtifactPath(tab, exportType)
      await this.fetchArtifact(tab, exportUrl, path)
      return { ok: true, tabId: tab.id, path }
    }
    const currentUrl = tab.view.webContents.getURL()
    if (!/^https:\/\/(?:www\.)?youtube\.com\/watch(?:\?|$)/iu.test(currentUrl)) throw new Error('当前标签不是 YouTube 视频页。')
    const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
      expression: `(() => {
        const visible = [...document.querySelectorAll('ytd-transcript-segment-renderer .segment-text')]
          .map((node) => String(node.textContent || '').trim()).filter(Boolean);
        const tracks = globalThis.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        return { visible, captionUrl: tracks[0]?.baseUrl || null };
      })()`,
      returnByValue: true,
    }) as { result?: { value?: { visible?: unknown; captionUrl?: unknown } } }
    const visible = response.result?.value?.visible
    let transcript = Array.isArray(visible) ? visible.filter((entry): entry is string => typeof entry === 'string').join('\n') : ''
    if (transcript.length === 0 && typeof response.result?.value?.captionUrl === 'string') {
      const captionUrl = new URL(response.result.value.captionUrl)
      captionUrl.searchParams.set('fmt', 'json3')
      const captionResponse = await tab.view.webContents.session.fetch(captionUrl.toString())
      if (!captionResponse.ok) throw new Error(`字幕下载失败：HTTP ${String(captionResponse.status)}`)
      const payload = await captionResponse.json() as { events?: Array<{ segs?: Array<{ utf8?: unknown }> }> }
      transcript = (payload.events ?? []).flatMap((event) => event.segs ?? []).map((segment) => typeof segment.utf8 === 'string' ? segment.utf8 : '').join('').replaceAll('\n', '\n').trim()
    }
    if (transcript.length === 0) throw new Error('当前视频没有可用字幕；请先在页面中打开 transcript。')
    const path = this.exportArtifactPath(tab, 'txt', 'youtube-transcript')
    await writeFile(path, transcript, 'utf8')
    return { ok: true, tabId: tab.id, path }
  }

  private async listPageAssets(tab: BrowserTabRuntime): Promise<Record<string, unknown>> {
    const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
      expression: `(() => {
        const rows = [];
        const add = (url, kind, source) => {
          try {
            const absolute = new URL(String(url || ''), document.baseURI).href;
            if (!/^https?:/i.test(absolute)) return;
            rows.push({ url: absolute, kind, source });
          } catch {}
        };
        for (const entry of performance.getEntriesByType('resource')) {
          const initiator = String(entry.initiatorType || '');
          const kind = initiator === 'img' ? 'image' : initiator === 'css' || initiator === 'link' ? 'stylesheet'
            : initiator === 'video' ? 'video' : initiator === 'script' ? 'script' : 'other';
          add(entry.name, kind, { kind: 'resource' });
        }
        const selectors = [
          ['img[src],img[srcset]', 'image', ['src', 'srcset']],
          ['source[src],source[srcset]', 'image', ['src', 'srcset']],
          ['video[src],video[poster],video source[src]', 'video', ['src', 'poster']],
          ['link[rel~="stylesheet"][href]', 'stylesheet', ['href']],
          ['script[src]', 'script', ['src']],
        ];
        for (const [selector, kind, attributes] of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            for (const attribute of attributes) {
              const raw = element.getAttribute(attribute);
              if (!raw) continue;
              const values = attribute === 'srcset' ? raw.split(',').map((part) => part.trim().split(/\\s+/)[0]) : [raw];
              for (const value of values) add(value, kind, { kind: 'attribute', nodeId: [...document.querySelectorAll('*')].indexOf(element) + 1, property: attribute });
            }
          }
        }
        for (const element of [...document.querySelectorAll('body *')].slice(0, 600)) {
          const style = getComputedStyle(element);
          for (const property of ['background-image', 'mask-image', 'content']) {
            const value = style.getPropertyValue(property);
            for (const match of value.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) add(match[1], 'image', { kind: 'computedStyle', property });
          }
        }
        return {
          pageUrl: location.href,
          rows,
          inlineSvgs: [...document.querySelectorAll('svg')].slice(0, 100).map((svg, index) => ({
            markup: svg.outerHTML.slice(0, 200000),
            name: svg.getAttribute('aria-label') || svg.id || 'inline-svg-' + (index + 1),
          })),
        };
      })()`,
      returnByValue: true,
    }) as { result?: { value?: { pageUrl?: unknown; rows?: unknown; inlineSvgs?: unknown } } }
    const raw = response.result?.value
    const rows = Array.isArray(raw?.rows) ? raw.rows : []
    const byUrl = new Map<string, { kind: BrowserPageAssetKind; sources: BrowserPageAssetInventory['assets'][number]['sources'] }>()
    const classify = (url: string, hint: BrowserPageAssetKind): BrowserPageAssetKind => {
      const pathname = new URL(url).pathname.toLocaleLowerCase()
      if (/\.(?:woff2?|ttf|otf|eot)$/u.test(pathname)) return 'font'
      if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/u.test(pathname)) return 'image'
      if (/\.(?:css)$/u.test(pathname)) return 'stylesheet'
      if (/\.(?:mp4|webm|mov|m4v|ogg)$/u.test(pathname)) return 'video'
      return hint
    }
    for (const entry of rows.slice(0, 2_000)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const value = entry as Record<string, unknown>
      if (typeof value.url !== 'string' || !/^https?:\/\//iu.test(value.url)) continue
      const hinted = ['script', 'font', 'image', 'stylesheet', 'video', 'other'].includes(String(value.kind)) ? value.kind as BrowserPageAssetKind : 'other'
      const sourceValue = value.source !== null && typeof value.source === 'object' && !Array.isArray(value.source) ? value.source as Record<string, unknown> : {}
      const source = {
        kind: ['attribute', 'computedStyle', 'resource'].includes(String(sourceValue.kind)) ? sourceValue.kind as 'attribute' | 'computedStyle' | 'resource' : 'resource',
        ...(typeof sourceValue.nodeId === 'number' ? { nodeId: sourceValue.nodeId } : {}),
        ...(typeof sourceValue.property === 'string' ? { property: sourceValue.property } : {}),
      }
      const existing = byUrl.get(value.url)
      if (existing === undefined) byUrl.set(value.url, { kind: classify(value.url, hinted), sources: [source] })
      else if (!existing.sources.some((candidate) => JSON.stringify(candidate) === JSON.stringify(source))) existing.sources.push(source)
    }
    this.browserEventSequence += 1
    const inventoryId = `assets-${Date.now().toString(36)}-${this.browserEventSequence.toString(36)}`
    const assets = [...byUrl].map(([url, value], index) => {
      let name = `asset-${String(index + 1)}`
      try { name = decodeURIComponent(basename(new URL(url).pathname)) || name } catch {}
      return { id: `${inventoryId}-${String(index + 1)}`, kind: value.kind, name, url, sources: value.sources }
    })
    const inlineSvgs = (Array.isArray(raw?.inlineSvgs) ? raw.inlineSvgs : []).flatMap((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
      const value = entry as Record<string, unknown>
      if (typeof value.markup !== 'string') return []
      return [{ id: `${inventoryId}-svg-${String(index + 1)}`, markup: value.markup, name: typeof value.name === 'string' ? value.name : `inline-svg-${String(index + 1)}` }]
    })
    const inventory: BrowserPageAssetInventory = { id: inventoryId, tabId: tab.id, pageUrl: typeof raw?.pageUrl === 'string' ? raw.pageUrl : null, assets, inlineSvgs }
    this.pageAssetInventories.set(inventoryId, inventory)
    const byKind: Partial<Record<BrowserPageAssetKind, number>> = {}
    for (const asset of assets) byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1
    return { ok: true, tabId: tab.id, id: inventoryId, assets, inlineSvgs, pageUrl: inventory.pageUrl, summary: { byKind, inlineSvgCount: inlineSvgs.length, totalCount: assets.length } }
  }

  private async bundlePageAssets(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (typeof request.inventoryId !== 'string' || request.inventoryId.length === 0) throw new Error('inventoryId 是必填项。')
    const inventory = this.pageAssetInventories.get(request.inventoryId)
    if (inventory === undefined || inventory.tabId !== tab.id) throw new Error('pageAssets inventory 已失效或不属于当前标签。')
    const assetIds = request.assetIds === undefined ? undefined : request.assetIds
    if (assetIds !== undefined && (!Array.isArray(assetIds) || assetIds.some((id) => typeof id !== 'string'))) throw new Error('assetIds 必须是字符串数组。')
    const kinds = request.kinds === undefined ? undefined : request.kinds
    const bundleKinds = new Set<BrowserPageAssetKind>(['font', 'image', 'stylesheet', 'video'])
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((kind) => !bundleKinds.has(kind as BrowserPageAssetKind)))) throw new Error('kinds 包含不可打包的资源类型。')
    const idSet = assetIds === undefined ? undefined : new Set(assetIds as string[])
    const kindSet = kinds === undefined ? undefined : new Set(kinds as BrowserPageAssetKind[])
    const selected = inventory.assets.filter((asset) => bundleKinds.has(asset.kind)
      && (idSet === undefined || idSet.has(asset.id)) && (kindSet === undefined || kindSet.has(asset.kind)))
    const startedAt = Date.now()
    const directoryPath = join(this.exportsPath, `page-assets-${inventory.id}`)
    await mkdir(directoryPath, { recursive: true })
    const downloaded: Array<Record<string, unknown>> = []
    const failures: Array<Record<string, unknown>> = []
    const usedNames = new Set<string>()
    for (const asset of selected) {
      let name = asset.name.replaceAll(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || asset.id
      if (usedNames.has(name)) name = `${asset.id}-${name}`
      usedNames.add(name)
      const path = join(directoryPath, name)
      try {
        const response = await tab.view.webContents.session.fetch(asset.url, { redirect: 'follow' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        await writeFile(path, Buffer.from(await response.arrayBuffer()))
        downloaded.push({ id: asset.id, kind: asset.kind, name, path, url: asset.url, contentType: response.headers.get('content-type') })
      } catch (error) {
        failures.push({ id: asset.id, name, url: asset.url, contentType: null, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    const manifestPath = join(directoryPath, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify({ inventoryId: inventory.id, pageUrl: inventory.pageUrl, assets: downloaded, failures }, null, 2), 'utf8')
    return {
      ok: true,
      tabId: tab.id,
      assets: downloaded,
      directoryPath,
      failures,
      manifestPath,
      summary: { downloadedCount: downloaded.length, elapsedMs: Date.now() - startedAt, failedCount: failures.length, requestedCount: selected.length },
    }
  }

  private agentSessionId(request: DesktopBrowserAgentRequest): string {
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0 || request.sessionId.length > 240 || /[\r\n]/u.test(request.sessionId)) {
      throw new Error('sessionId 是必填项。')
    }
    return request.sessionId
  }

  private sessionTabStates(sessionId: string): DesktopBrowserTabState[] {
    const states: DesktopBrowserTabState[] = []
    for (const tabId of this.sessionTabs.get(sessionId) ?? []) {
      const tab = this.tabs.get(tabId)
      if (tab === undefined) continue
      this.capturePageState(tab)
      states.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        ...(tab.faviconUrl === undefined ? {} : { faviconUrl: tab.faviconUrl }),
        loading: tab.loading,
        agentActive: tab.agentActive,
        sessionBound: true,
        snapshotVersion: tab.snapshotVersion,
      })
    }
    return states
  }

  private refreshSessionAgentTabs(sessionId: string): boolean {
    const activeTabId = this.sessionActiveTabs.get(sessionId)
    const running = this.agentStatuses.get(sessionId) === true
    let changed = false
    for (const tabId of this.sessionTabs.get(sessionId) ?? []) {
      const tab = this.tabs.get(tabId)
      if (tab === undefined) continue
      const active = running && tab.id === activeTabId
      if (tab.agentActive === active) continue
      tab.agentActive = active
      changed = true
    }
    return changed
  }

  private registerFloatingWindowIpc(): void {
    ipcMain.handle(FLOATING_ACTION_CHANNEL, async (event, action: unknown, value?: unknown) => {
      const floating = this.floatingWindow
      if (floating === undefined || floating.isDestroyed() || event.sender !== floating.webContents || typeof action !== 'string') return
      if (action === 'ready') {
        this.sendFloatingWindowState()
        return
      }
      if (action === 'navigate' && typeof value === 'string') await this.navigate(value)
      else if (action === 'back' || action === 'forward') await this.navigationAction(action)
      else if (action === 'reload') await this.navigationAction(this.state.loading ? 'stop' : 'reload')
      else if (action === 'select-tab' && typeof value === 'string') await this.selectTab(value)
      else if (action === 'close-tab' && typeof value === 'string') await this.closeTab(value, true)
      else if (action === 'new-tab') await this.createManualTab()
      else if (action === 'maximize') floating.isMaximized() ? floating.unmaximize() : floating.maximize()
      else if (action === 'hide' || action === 'close') await this.setPanelOpen(false)
      else if (action === 'set-mode' && (value === 'split' || value === 'drawer' || value === 'floating')) await this.setDisplayMode(value)
      else if (action === 'set-zoom' && typeof value === 'number') await this.setZoomFactor(value)
      else if (action === 'set-device-viewport') await this.setDeviceViewport(value === null ? null : value as DesktopBrowserViewport)
      else if (action === 'clear-data') await this.clearBrowsingData()
      else if (action === 'history') return this.getHistory()
      else if (action === 'open-menu' && value !== null && typeof value === 'object') {
        const request = value as { kind?: unknown; anchor?: unknown }
        if ((request.kind === 'display' || request.kind === 'settings') && request.anchor !== null && typeof request.anchor === 'object') {
          await this.openPageMenu(request.kind, request.anchor as DesktopBrowserMenuAnchor)
        }
      }
      else if (action === 'dismiss-menu') this.closeMenu()
      else if (action === 'application-action' && (value === 'plugins' || value === 'development' || value === 'release-notes' || value === 'update' || value === 'desktop-update')) {
        this.closeMenu()
        this.emit('application-menu-action', value)
      }
      else if (action === 'overlay' && typeof value === 'boolean') {
        this.floatingOverlayOpen = value
        this.setNativeVisible(!value)
      }
    })
    ipcMain.handle(PAGE_MENU_ACTION_CHANNEL, async (event, action: unknown, value?: unknown) => {
      if ((event.sender !== this.view?.webContents && !this.menuController.isActiveSender(event.sender)) || typeof action !== 'string') return
      if (action === 'menu-ready') this.menuController.sendState()
      else if (action === 'menu-rendered' && typeof value === 'number') {
        this.menuController.resolveRendered(value)
      }
      else if (action === 'resize-menu' && value !== null && typeof value === 'object') {
        const size = value as { width?: unknown; height?: unknown }
        if (typeof size.width === 'number' && typeof size.height === 'number') this.menuController.resize(size.width, size.height)
      }
      else if (action === 'reopen-context-menu' && value !== null && typeof value === 'object') {
        const point = value as { x?: unknown; y?: unknown }
        if (typeof point.x === 'number' && typeof point.y === 'number') this.reopenContextMenuUnderShadow(point.x, point.y)
      }
      else if (action === 'dismiss-menu') this.closeMenu()
      else if (action === 'application-action' && (value === 'plugins' || value === 'development' || value === 'release-notes' || value === 'update' || value === 'desktop-update')) {
        this.closeMenu()
        this.emit('application-menu-action', value)
      }
      else if (action === 'set-mode' && (value === 'split' || value === 'drawer' || value === 'floating')) { this.closeMenu(); await this.setDisplayMode(value) }
      else if (action === 'set-zoom' && typeof value === 'number') await this.setZoomFactor(value)
      else if (action === 'set-device-viewport') { this.closeMenu(); await this.setDeviceViewport(value === null ? null : value as DesktopBrowserViewport) }
      else if (action === 'clear-data') { this.closeMenu(); await this.clearBrowsingData() }
      else if (action === 'navigate' && typeof value === 'string') { this.closeMenu(); await this.navigate(value) }
    })
  }

  private async ensureFloatingWindow(): Promise<BrowserWindow> {
    const existing = this.floatingWindow
    if (existing !== undefined && !existing.isDestroyed()) return existing
    const mainBounds = this.window?.getBounds()
    const width = Math.min(1100, Math.max(720, mainBounds?.width ?? 960))
    const height = Math.min(820, Math.max(520, (mainBounds?.height ?? 720) - 80))
    const floating = new BrowserWindow({
      width,
      height,
      minWidth: 620,
      minHeight: 420,
      show: false,
      frame: false,
      backgroundColor: this.theme === 'dark' ? '#101114' : '#f5f6f8',
      title: 'DFY DSH Desktop 浏览器',
      icon: app.isPackaged
        ? join(process.resourcesPath, 'app-icon.png')
        : join(app.getAppPath(), 'app-icon.png'),
      webPreferences: {
        preload: BROWSER_WINDOW_PRELOAD,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
      },
    })
    this.floatingWindow = floating
    floating.webContents.on('before-mouse-event', (_event, input) => {
      if (input.type !== 'mouseDown') return
      const requestId = this.closeMenu()
      if (requestId !== undefined) this.emit('context-menu-dismiss', requestId)
    })
    floating.webContents.on('before-input-event', (_event, input) => this.closeMenuForSystemKey(input))
    floating.webContents.on('context-menu', (event, params) => {
      if (!params.isEditable || params.frame === null) return
      event.preventDefault()
      this.emit('context-menu', params, floating.webContents, 'floating')
    })
    floating.on('resize', () => {
      this.layoutFloatingView()
      this.sendFloatingWindowState()
    })
    floating.on('maximize', () => this.sendFloatingWindowState())
    floating.on('unmaximize', () => this.sendFloatingWindowState())
    floating.on('close', (event) => {
      if (this.closingFloatingWindow) return
      event.preventDefault()
      void this.setPanelOpen(false)
    })
    floating.on('closed', () => {
      if (this.floatingWindow === floating) this.floatingWindow = undefined
    })
    const rendererDevUrl = !app.isPackaged ? process.env.HARNESS_DESKTOP_RENDERER_URL : undefined
    if (rendererDevUrl !== undefined) {
      const url = new URL(rendererDevUrl)
      url.pathname = '/browser-window.html'
      url.search = ''
      url.searchParams.set('theme', this.theme)
      await floating.loadURL(url.toString())
    } else {
      await floating.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'browser-window.html'), {
        query: { theme: this.theme },
      })
    }
    await this.menuController.ensure(floating)
    return floating
  }

  private async showFloatingWindow(): Promise<void> {
    const view = await this.ensureView()
    const floating = await this.ensureFloatingWindow()
    this.attachViewToWindow(view, floating)
    this.bounds = undefined
    this.layoutFloatingView()
    view.setVisible(true)
    floating.show()
    floating.focus()
    this.sendFloatingWindowState()
  }

  private leaveFloatingWindow(activateMain = false): void {
    const floating = this.floatingWindow
    if (floating !== undefined && !floating.isDestroyed()) floating.hide()
    const view = this.view
    const main = this.window
    if (view !== undefined && main !== undefined && !main.isDestroyed()) {
      this.attachViewToWindow(view, main)
      view.setVisible(false)
      if (activateMain) {
        if (main.isMinimized()) main.restore()
        main.show()
        main.focus()
      }
    }
    this.bounds = undefined
  }

  private destroyFloatingWindow(): void {
    const floating = this.floatingWindow
    this.floatingWindow = undefined
    if (floating === undefined || floating.isDestroyed()) return
    this.closingFloatingWindow = true
    try { floating.destroy() } finally { this.closingFloatingWindow = false }
  }

  private attachViewToWindow(view: WebContentsView, target: BrowserWindow): void {
    const tab = this.tabForView(view)
    if (tab?.hostWindow === target) {
      if (this.view === view) this.viewHostWindow = target
      return
    }
    try { tab?.hostWindow?.contentView.removeChildView(view) } catch {}
    target.contentView.addChildView(view)
    if (tab !== undefined) tab.hostWindow = target
    if (this.view === view) this.viewHostWindow = target
  }

  private layoutFloatingView(): void {
    const floating = this.floatingWindow
    const view = this.view
    if (floating === undefined || floating.isDestroyed() || view === undefined || view.webContents.isDestroyed()) return
    const size = floating.getContentSize()
    const width = size[0] ?? 1
    const height = size[1] ?? 1
    const toolbarHeight = FLOATING_TOOLBAR_HEIGHT + (this.viewport === undefined ? 0 : FLOATING_DEVICE_TOOLBAR_HEIGHT)
    if (this.viewport === undefined) {
      this.bounds = undefined
      view.setBounds({ x: 0, y: toolbarHeight, width: Math.max(1, width), height: Math.max(1, height - toolbarHeight) })
    } else {
      const availableWidth = Math.max(1, width - 72)
      const availableHeight = Math.max(1, height - toolbarHeight - 72)
      const scale = Math.max(0.1, Math.min(1, availableWidth / this.viewport.width, availableHeight / this.viewport.height))
      const viewWidth = Math.max(1, Math.round(this.viewport.width * scale))
      const viewHeight = Math.max(1, Math.min(availableHeight, Math.round(this.viewport.height * scale)))
      const bounds = {
        x: Math.round((width - viewWidth) / 2),
        y: toolbarHeight + Math.round((height - toolbarHeight - viewHeight) / 2),
        width: viewWidth,
        height: viewHeight,
      }
      this.bounds = bounds
      view.setBounds(bounds)
    }
    this.scheduleViewportApply()
  }

  private reopenContextMenuUnderShadow(localX: number, localY: number): void {
    const point = this.menuController.takeContextReopenPoint(localX, localY)
    if (point === undefined) return
    const { host, hostX, hostY, requestId } = point
    if (requestId !== undefined) this.emit('context-menu-dismiss', requestId)
    if (!point.insideHost) return

    setImmediate(() => {
      if (host.isDestroyed()) return
      const view = this.view
      const viewBounds = view?.getBounds()
      const targetsPage = view !== undefined
        && !view.webContents.isDestroyed()
        && this.viewHostWindow === host
        && viewBounds !== undefined
        && hostX >= viewBounds.x
        && hostY >= viewBounds.y
        && hostX < viewBounds.x + viewBounds.width
        && hostY < viewBounds.y + viewBounds.height
      const contents = targetsPage ? view.webContents : host.webContents
      if (contents.isDestroyed()) return
      const x = targetsPage && viewBounds !== undefined ? hostX - viewBounds.x : hostX
      const y = targetsPage && viewBounds !== undefined ? hostY - viewBounds.y : hostY
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
    })
  }

  private closeMenuForSystemKey(input: { key: string; alt: boolean; meta: boolean }): void {
    const key = input.key.toLowerCase()
    if (!input.alt && !input.meta && key !== 'alt' && key !== 'meta' && key !== 'os' && key !== 'super') return
    const requestId = this.closeMenu()
    if (requestId !== undefined) this.emit('context-menu-dismiss', requestId)
  }

  private applyTheme(target: BrowserWindow | undefined): void {
    if (target === undefined || target.isDestroyed() || target.webContents.isDestroyed()) return
    if (target === this.floatingWindow) target.setBackgroundColor(this.theme === 'dark' ? '#101114' : '#f5f6f8')
    if (target.webContents.isLoadingMainFrame()) return
    void target.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(this.theme)}`).catch(() => undefined)
  }

  private sendFloatingWindowState(): void {
    const floating = this.floatingWindow
    if (floating === undefined || floating.isDestroyed() || floating.webContents.isLoadingMainFrame()) return
    const state = this.state
    floating.webContents.send(FLOATING_STATE_CHANNEL, {
      loading: state.loading,
      url: state.url,
      title: state.title,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      maximized: floating.isMaximized(),
      displayMode: this.settings.displayMode,
      zoomFactor: this.zoomFactor,
      viewport: this.viewport ?? null,
      viewBounds: this.view?.getBounds() ?? null,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
    })
  }

  private activeTab(): BrowserTabRuntime | undefined {
    return this.activeTabId === undefined ? undefined : this.tabs.get(this.activeTabId)
  }

  private tabForView(view: WebContentsView): BrowserTabRuntime | undefined {
    return [...this.tabs.values()].find((tab) => tab.view === view)
  }

  private tabForContents(contents: WebContents): BrowserTabRuntime | undefined {
    return [...this.tabs.values()].find((tab) => tab.view.webContents === contents)
  }

  private async ensureView(): Promise<WebContentsView> {
    if (!this.settings.enabled) throw new Error('内置浏览器已在设置中关闭。')
    const active = this.activeTab()
    if (active !== undefined && !active.view.webContents.isDestroyed()) return active.view
    const existingTabId = resolveBrowserTabForDisplay([...this.tabs.values()].map((tab) => ({
      id: tab.id,
      destroyed: tab.view.webContents.isDestroyed(),
    })))
    if (existingTabId !== undefined) {
      const existing = this.tabs.get(existingTabId)
      if (existing !== undefined) {
        await this.selectTab(existing.id)
        return existing.view
      }
    }
    const manual = await this.createTab(MANUAL_TAB_ID)
    await this.selectTab(manual.id)
    return manual.view
  }

  private bindAgentTab(tab: BrowserTabRuntime, sessionId: string): BrowserTabRuntime {
    if (tab.sessionId !== undefined && tab.sessionId !== sessionId) throw new Error('该浏览器标签已属于另一个 DSH 会话。')
    tab.sessionId = sessionId
    if (tab.title === '新标签页') tab.title = 'Agent 浏览器'
    let sessionTabIds = this.sessionTabs.get(sessionId)
    if (sessionTabIds === undefined) {
      sessionTabIds = new Set()
      this.sessionTabs.set(sessionId, sessionTabIds)
    }
    sessionTabIds.add(tab.id)
    this.sessionActiveTabs.set(sessionId, tab.id)
    this.refreshSessionAgentTabs(sessionId)
    return tab
  }

  private releaseClaimedTab(tab: BrowserTabRuntime): void {
    const sessionId = tab.sessionId
    if (sessionId === undefined || tab.claimedFromUser !== true) return
    const sessionTabIds = this.sessionTabs.get(sessionId)
    sessionTabIds?.delete(tab.id)
    if (sessionTabIds?.size === 0) this.sessionTabs.delete(sessionId)
    if (this.sessionActiveTabs.get(sessionId) === tab.id) {
      const next = sessionTabIds === undefined ? undefined : [...sessionTabIds].at(-1)
      if (next === undefined) this.sessionActiveTabs.delete(sessionId)
      else this.sessionActiveTabs.set(sessionId, next)
    }
    delete tab.sessionId
    delete tab.claimedFromUser
    delete tab.retentionMark
    tab.agentActive = false
    this.refreshSessionAgentTabs(sessionId)
    this.changed()
  }

  private async createAgentTab(sessionId: string, reuseEmptyManual = false): Promise<BrowserTabRuntime> {
    const manual = reuseEmptyManual
      ? [...this.tabs.values()].reverse().find((candidate) => candidate.sessionId === undefined
        && !candidate.loading
        && candidate.url === ''
        && !candidate.view.webContents.isDestroyed())
      : undefined
    const tab = manual !== undefined
      && manual.sessionId === undefined
      && !manual.loading
      && manual.url === ''
      && !manual.view.webContents.isDestroyed()
      ? manual
      : await this.createTab(`agent-${(++this.tabSequence).toString(36)}`, sessionId)
    return this.bindAgentTab(tab, sessionId)
  }

  private async agentTabForRequest(sessionId: string, request: DesktopBrowserAgentRequest): Promise<BrowserTabRuntime> {
    const requestedTabId = request.tabId
    if (requestedTabId !== undefined && typeof requestedTabId !== 'string') throw new Error('tabId 必须是字符串。')
    const tabId = typeof requestedTabId === 'string' ? requestedTabId : this.sessionActiveTabs.get(sessionId)
    if (tabId === undefined) return await this.createAgentTab(sessionId, true)
    const tab = this.tabs.get(tabId)
    if (tab === undefined || tab.sessionId !== sessionId || !this.sessionTabs.get(sessionId)?.has(tabId)) {
      throw new Error('该浏览器标签不属于当前 DSH 会话。')
    }
    this.sessionActiveTabs.set(sessionId, tab.id)
    if (this.refreshSessionAgentTabs(sessionId)) this.changed()
    return tab
  }

  private async createTab(id: string, sessionId?: string): Promise<BrowserTabRuntime> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) throw new Error('桌面窗口尚未准备完成。')
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        preload: BROWSER_PRELOAD,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
      },
    })
    const tab: BrowserTabRuntime = {
      id,
      ...(sessionId === undefined ? {} : { sessionId }),
      view,
      hostWindow: window,
      loading: false,
      url: '',
      title: sessionId === undefined ? '新标签页' : 'Agent 浏览器',
      agentActive: sessionId === undefined ? false : this.agentStatuses.get(sessionId) === true,
      snapshotVersion: 0,
      navigationVersion: 0,
      lastNavigationKind: 'document',
      inflightRequests: new Set(),
      inflightRequestDetails: new Map(),
      networkActivityVersion: 0,
      networkIdleSince: Date.now(),
      lastOpened: new Date().toISOString(),
      snapshotTargets: new Map(),
      backgroundViewportActive: false,
      syntheticBlankHistory: true,
      historyTimer: undefined,
      consoleLogs: [],
      debuggerConfigured: false,
      pendingEvents: new Map(),
      eventWaiters: new Map(),
    }
    this.tabs.set(id, tab)
    view.setBounds({ x: 0, y: 0, ...BACKGROUND_VIEWPORT })
    view.setVisible(false)
    window.contentView.addChildView(view)
    const contents = view.webContents
    contents.setZoomFactor(this.zoomFactor)
    contents.backgroundThrottling = false
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//iu.test(url)) void this.openChildTab(tab, url)
      return { action: 'deny' }
    })
    contents.on('before-mouse-event', (_event, input) => {
      if (input.type !== 'mouseDown') return
      const requestId = this.closeMenu()
      if (requestId !== undefined) this.emit('context-menu-dismiss', requestId)
    })
    contents.on('before-input-event', (_event, input) => this.closeMenuForSystemKey(input))
    contents.on('context-menu', (event, params) => {
      if (params.frame === null) return
      event.preventDefault()
      this.emit('context-menu', params, contents, 'page')
    })
    contents.on('will-navigate', (event, target) => {
      if (target === 'about:blank' || /^https?:\/\//iu.test(target)) return
      event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      tab.loading = true
      delete tab.faviconUrl
      this.invalidateTabSnapshot(tab)
      if (this.activeTabId === tab.id) this.shellOverlaySnapshot = undefined
      this.changed()
    })
    contents.on('did-stop-loading', () => {
      tab.loading = false
      this.capturePageState(tab)
      this.scheduleHistoryRecord(tab)
      this.changed()
    })
    contents.on('did-navigate', () => {
      tab.navigationVersion += 1
      tab.lastNavigationKind = 'document'
      this.invalidateTabSnapshot(tab)
      this.capturePageState(tab)
      this.scheduleHistoryRecord(tab)
      this.changed()
    })
    contents.on('did-navigate-in-page', () => {
      tab.navigationVersion += 1
      tab.lastNavigationKind = 'same-document'
      this.invalidateTabSnapshot(tab)
      this.capturePageState(tab)
      this.scheduleHistoryRecord(tab)
      this.changed()
    })
    contents.on('page-title-updated', (_event, title) => {
      tab.title = title.trim() || (tab.url || '浏览器')
      this.scheduleHistoryRecord(tab)
      this.changed()
    })
    contents.on('page-favicon-updated', (_event, favicons) => {
      const faviconUrl = favicons.find((favicon) => /^(?:https?:|data:image\/)/iu.test(favicon))
      if (faviconUrl === tab.faviconUrl) return
      if (faviconUrl === undefined) delete tab.faviconUrl
      else tab.faviconUrl = faviconUrl
      this.changed()
    })
    contents.on('console-message', (details) => {
      const level = details.level === 'warning' ? 'warn' : details.level === 'error' || details.level === 'debug' ? details.level : 'info'
      tab.consoleLogs.push({
        level,
        message: details.message.slice(0, 8_000),
        timestamp: new Date().toISOString(),
        ...(details.sourceId.length === 0 ? {} : { url: details.sourceId }),
      })
      if (tab.consoleLogs.length > 500) tab.consoleLogs.splice(0, tab.consoleLogs.length - 500)
    })
    if (!this.browserSessionConfigured) {
      this.browserSessionConfigured = true
      contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      contents.session.on('will-download', (event, item, sourceContents) => {
        const sourceTab = sourceContents === undefined ? undefined : this.tabForContents(sourceContents)
        if (sourceTab?.sessionId === undefined) {
          event.preventDefault()
          return
        }
        const eventId = this.nextBrowserEventId('download')
        const filename = basename(item.getFilename()).replaceAll(/[^\p{L}\p{N}._ -]/gu, '_') || 'download'
        const path = join(this.downloadsPath, `${Date.now().toString(36)}-${eventId}-${filename}`)
        let finish = (): void => undefined
        const completion = new Promise<void>((resolve) => { finish = resolve })
        const runtime: BrowserDownloadRuntime = { tabId: sourceTab.id, path, state: 'progressing', completion }
        this.downloads.set(eventId, runtime)
        item.setSavePath(path)
        item.once('done', (_doneEvent, state) => {
          runtime.state = state
          finish()
        })
        this.publishBrowserEvent(sourceTab, 'download', { eventId, filename })
      })
    }
    await contents.loadURL(EMPTY_BROWSER_URL).catch(() => undefined)
    return tab
  }

  private destroyView(): void {
    this.closeMenu()
    this.view = undefined
    this.viewHostWindow = undefined
    this.activeTabId = undefined
    this.bounds = undefined
    this.shellOverlayOpen = false
    this.shellOverlaySnapshot = undefined
    this.destroyFloatingWindow()
    for (const tab of this.tabs.values()) this.destroyTabRuntime(tab)
    this.tabs.clear()
    this.sessionTabs.clear()
    this.sessionActiveTabs.clear()
    this.pageAssetInventories.clear()
  }

  private async openChildTab(parent: BrowserTabRuntime, url: string): Promise<void> {
    const tab = parent.sessionId === undefined
      ? await this.createTab(`manual-${(++this.tabSequence).toString(36)}`)
      : await this.createAgentTab(parent.sessionId)
    await this.navigateTab(tab, url, false)
    if (this.activeTabId === parent.id) await this.selectTab(tab.id)
    else this.changed()
  }

  private destroyTabRuntime(tab: BrowserTabRuntime): void {
    if (tab.historyTimer !== undefined) clearTimeout(tab.historyTimer)
    for (const waiters of tab.eventWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('浏览器标签已关闭。'))
      }
    }
    tab.eventWaiters.clear()
    for (const [eventId, chooser] of this.fileChoosers) {
      if (chooser.tabId === tab.id) this.fileChoosers.delete(eventId)
    }
    try { tab.hostWindow?.contentView.removeChildView(tab.view) } catch {}
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  }

  private setNativeVisible(visible: boolean): void {
    const view = this.view
    for (const tab of this.tabs.values()) {
      if (tab.view !== view && !tab.view.webContents.isDestroyed()) tab.view.setVisible(false)
    }
    if (view === undefined || view.webContents.isDestroyed()) return
    const floatingVisible = this.settings.displayMode === 'floating'
      && this.floatingWindow?.isVisible() === true
      && this.viewHostWindow === this.floatingWindow
    view.setVisible(visible && !this.floatingOverlayOpen && !this.shellOverlayOpen && this.panelOpen && this.settings.enabled && (floatingVisible || this.bounds !== undefined))
  }

  private capturePageState(tab: BrowserTabRuntime): void {
    const contents = tab.view.webContents
    if (contents === undefined || contents.isDestroyed()) return
    const current = contents.getURL()
    tab.url = /^https?:\/\//iu.test(current) ? current : ''
    tab.title = contents.getTitle().trim() || (tab.url || (tab.sessionId === undefined ? '新标签页' : 'Agent 浏览器'))
  }

  private scheduleHistoryRecord(tab: BrowserTabRuntime): void {
    if (tab.historyTimer !== undefined) clearTimeout(tab.historyTimer)
    tab.historyTimer = setTimeout(() => {
      tab.historyTimer = undefined
      void this.recordHistory(tab)
    }, 450)
  }

  private async recordHistory(tab: BrowserTabRuntime): Promise<void> {
    this.capturePageState(tab)
    if (!/^https?:\/\//iu.test(tab.url)) return
    const now = new Date().toISOString()
    const entry: DesktopBrowserHistoryEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      url: tab.url,
      title: tab.title === '浏览器' ? tab.url : tab.title,
      visitedAt: now,
    }
    this.history = [entry, ...this.history.filter((item) => item.url !== entry.url)].slice(0, MAX_HISTORY_ENTRIES)
    await this.writeJson(this.historyPath, { entries: this.history })
  }

  private invalidateTabSnapshot(tab: BrowserTabRuntime): void {
    if (tab.snapshotTargets.size === 0) return
    tab.snapshotTargets.clear()
    tab.snapshotVersion += 1
  }

  private nextBrowserEventId(kind: BrowserAsyncEventKind): string {
    this.browserEventSequence += 1
    return `${kind}-${Date.now().toString(36)}-${this.browserEventSequence.toString(36)}`
  }

  private publishBrowserEvent(tab: BrowserTabRuntime, kind: BrowserAsyncEventKind, payload: Record<string, unknown>): void {
    const waiters = tab.eventWaiters.get(kind)
    const waiter = waiters?.shift()
    if (waiter !== undefined) {
      clearTimeout(waiter.timer)
      waiter.resolve(payload)
      if (waiters?.length === 0) tab.eventWaiters.delete(kind)
      return
    }
    const pending = tab.pendingEvents.get(kind) ?? []
    pending.push(payload)
    if (pending.length > 8) pending.splice(0, pending.length - 8)
    tab.pendingEvents.set(kind, pending)
  }

  private async ensureDebuggerEvents(tab: BrowserTabRuntime): Promise<void> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) throw new Error('浏览器标签已关闭。')
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    if (tab.debuggerConfigured) return
    tab.debuggerConfigured = true
    contents.debugger.on('message', (_event, method, params) => {
      const payload = params !== null && typeof params === 'object' ? params as Record<string, unknown> : {}
      if (method === 'Page.fileChooserOpened') {
        const backendNodeId = payload.backendNodeId
        if (typeof backendNodeId !== 'number' || !Number.isSafeInteger(backendNodeId)) return
        const eventId = this.nextBrowserEventId('filechooser')
        const multiple = payload.mode === 'selectMultiple'
        this.fileChoosers.set(eventId, { tabId: tab.id, backendNodeId, multiple })
        this.publishBrowserEvent(tab, 'filechooser', { eventId, multiple })
        return
      }
      if (method === 'Page.javascriptDialogOpening') {
        const type = payload.type
        if (type !== 'alert' && type !== 'confirm' && type !== 'prompt' && type !== 'beforeunload') return
        tab.jsDialog = { type, message: typeof payload.message === 'string' ? payload.message.slice(0, 4_000) : '' }
        return
      }
      if (method === 'Page.javascriptDialogClosed') delete tab.jsDialog
      if (method === 'Network.requestWillBeSent') {
        const requestId = payload.requestId
        const resourceType = payload.type
        if (typeof requestId !== 'string' || resourceType === 'WebSocket' || resourceType === 'EventSource') return
        tab.inflightRequests.add(requestId)
        tab.networkActivityVersion = (tab.networkActivityVersion ?? 0) + 1
        const request = payload.request !== null && typeof payload.request === 'object'
          ? payload.request as Record<string, unknown>
          : {}
        tab.inflightRequestDetails ??= new Map()
        tab.inflightRequestDetails.set(requestId, {
          url: typeof request.url === 'string' ? request.url : '',
          type: typeof resourceType === 'string' ? resourceType : 'Other',
          startedAt: Date.now(),
        })
        tab.networkIdleSince = Number.POSITIVE_INFINITY
        return
      }
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const requestId = payload.requestId
        if (typeof requestId !== 'string') return
        tab.inflightRequests.delete(requestId)
        tab.inflightRequestDetails?.delete(requestId)
        if (tab.inflightRequests.size === 0) tab.networkIdleSince = Date.now()
      }
    })
    await contents.debugger.sendCommand('Page.enable')
    await contents.debugger.sendCommand('Network.enable')
    await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
  }

  private async waitForBrowserEvent(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    const kind = request.event
    if (kind !== 'filechooser' && kind !== 'download') throw new Error('event 必须是 filechooser 或 download。')
    await this.ensureDebuggerEvents(tab)
    const pending = tab.pendingEvents.get(kind)
    const queued = pending?.shift()
    if (queued !== undefined) {
      if (pending?.length === 0) tab.pendingEvents.delete(kind)
      return { ok: true, tabId: tab.id, ...queued }
    }
    const timeoutMs = positiveInteger(request.timeoutMs ?? 60_000, 'timeoutMs', 1, 60_000)
    const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiters = tab.eventWaiters.get(kind) ?? []
      const waiter: BrowserAsyncEventWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = tab.eventWaiters.get(kind)
          if (current !== undefined) {
            const index = current.indexOf(waiter)
            if (index >= 0) current.splice(index, 1)
            if (current.length === 0) tab.eventWaiters.delete(kind)
          }
          reject(new Error(`等待 ${kind} 超时。`))
        }, timeoutMs),
      }
      waiter.timer.unref?.()
      waiters.push(waiter)
      tab.eventWaiters.set(kind, waiters)
    })
    return { ok: true, tabId: tab.id, ...payload }
  }

  private async setFileChooserFiles(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    const eventId = request.eventId
    if (typeof eventId !== 'string' || eventId.length === 0) throw new Error('eventId 是必填项。')
    if (!Array.isArray(request.paths) || request.paths.length === 0 || request.paths.some((path) => typeof path !== 'string' || path.length === 0)) {
      throw new Error('paths 必须是非空文件路径数组。')
    }
    const chooser = this.fileChoosers.get(eventId)
    if (chooser === undefined || chooser.tabId !== tab.id) throw new Error('文件选择器已失效或不属于当前标签。')
    const paths = request.paths as string[]
    if (!chooser.multiple && paths.length > 1) throw new Error('该文件选择器只允许一个文件。')
    for (const path of paths) {
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || !info.isFile()) throw new Error(`文件不存在或不是普通文件：${path}`)
    }
    await this.debuggerCommandFor(tab, 'DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId })
    this.fileChoosers.delete(eventId)
    return { ok: true, tabId: tab.id, eventId, count: paths.length }
  }

  private async downloadPath(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    const eventId = request.eventId
    if (typeof eventId !== 'string' || eventId.length === 0) throw new Error('eventId 是必填项。')
    const download = this.downloads.get(eventId)
    if (download === undefined || download.tabId !== tab.id) throw new Error('下载任务已失效或不属于当前标签。')
    const timeoutMs = positiveInteger(request.timeoutMs ?? 120_000, 'timeoutMs', 1, 120_000)
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        download.completion,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('等待下载完成超时。')), timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (download.state !== 'completed') throw new Error(`下载未完成：${download.state}`)
    const info = await stat(download.path).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error('下载文件不存在。')
    this.downloads.delete(eventId)
    return { ok: true, tabId: tab.id, eventId, path: download.path }
  }

  private async handleJsDialog(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (typeof request.accept !== 'boolean') throw new Error('accept 必须是布尔值。')
    await this.ensureDebuggerEvents(tab)
    if (tab.jsDialog === undefined) throw new Error('当前标签没有待处理的 JavaScript 对话框。')
    const promptText = typeof request.promptText === 'string' ? request.promptText : ''
    await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', {
      accept: request.accept,
      ...(request.accept && tab.jsDialog.type === 'prompt' ? { promptText } : {}),
    })
    delete tab.jsDialog
    return { ok: true, tabId: tab.id }
  }

  private async debuggerCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const contents = (await this.ensureView()).webContents
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    return await contents.debugger.sendCommand(method, params)
  }

  private async debuggerCommandFor(tab: BrowserTabRuntime, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const contents = tab.view.webContents
    await this.ensureDebuggerEvents(tab)
    if (tab.viewport === undefined && !tab.view.getVisible() && !tab.backgroundViewportActive) {
      const bounds = tab.view.getBounds()
      if (bounds.width <= 1 || bounds.height <= 1) tab.view.setBounds({ x: 0, y: 0, ...BACKGROUND_VIEWPORT })
      await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        ...BACKGROUND_VIEWPORT,
        deviceScaleFactor: 1,
        mobile: false,
        scale: 1,
        screenWidth: BACKGROUND_VIEWPORT.width,
        screenHeight: BACKGROUND_VIEWPORT.height,
        // Keep the native WebContentsView as the visible surface. Without this,
        // Chromium resizes the surface to the emulated CSS viewport and it can
        // paint beyond the smaller device-preview bounds.
        dontSetVisibleSize: true,
      })
      tab.backgroundViewportActive = true
    }
    return await contents.debugger.sendCommand(method, params)
  }

  private async frameSnapshotSections(tab: BrowserTabRuntime): Promise<string[]> {
    const sections: string[] = []
    let visited = 0
    const visit = async (parent: WebFrameMain, chain: string[]): Promise<void> => {
      if (visited >= 12 || parent.isDestroyed()) return
      const descriptors = await parent.executeJavaScript(`(() => [...document.querySelectorAll('iframe,frame')].map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        tagIndex: [...document.querySelectorAll(element.tagName.toLowerCase())].indexOf(element) + 1,
        name: String(element.name || ''),
        url: String(element.src || '')
      })))()`).catch(() => []) as unknown
      if (!Array.isArray(descriptors)) return
      const children = parent.frames.filter((frame) => !frame.isDestroyed())
      for (const raw of descriptors) {
        if (visited >= 12) return
        const descriptor = raw as { index?: unknown; tag?: unknown; tagIndex?: unknown; name?: unknown; url?: unknown }
        const byName = typeof descriptor.name === 'string' && descriptor.name.length > 0
          ? children.filter((child) => child.name === descriptor.name)
          : []
        const byUrl = typeof descriptor.url === 'string' && descriptor.url.length > 0
          ? children.filter((child) => child.url === descriptor.url)
          : []
        const index = typeof descriptor.index === 'number' && Number.isInteger(descriptor.index) ? descriptor.index : -1
        const child = byName.length === 1 ? byName[0] : byUrl.length === 1 ? byUrl[0] : children[index]
        if (child === undefined || child.isDestroyed()) continue
        const tag = descriptor.tag === 'frame' ? 'frame' : 'iframe'
        const selector = typeof descriptor.name === 'string' && descriptor.name.length > 0
          ? `${tag}[name=${JSON.stringify(descriptor.name)}]`
          : typeof descriptor.url === 'string' && descriptor.url.length > 0
            ? `${tag}[src=${JSON.stringify(descriptor.url)}]`
            : `${tag}:nth-of-type(${String(descriptor.tagIndex ?? 1)})`
        const nextChain = [...chain, selector]
        visited += 1
        const value = await child.executeJavaScript(`(() => {
          const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > .01 && rect.width > 0 && rect.height > 0;
          };
          const role = (element) => {
            const explicit = normalize(element.getAttribute('role')).split(' ')[0];
            if (explicit) return explicit;
            const tag = element.tagName.toLowerCase();
            const type = normalize(element.getAttribute('type')).toLowerCase();
            if (tag === 'a' && element.hasAttribute('href')) return 'link';
            if (tag === 'button' || tag === 'summary') return 'button';
            if (tag === 'textarea' || element.isContentEditable) return 'textbox';
            if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
            if (tag === 'img') return 'img';
            if (/^h[1-6]$/.test(tag)) return 'heading';
            if (tag !== 'input') return tag;
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (['button','submit','reset','image'].includes(type)) return 'button';
            return 'textbox';
          };
          const name = (element) => normalize(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.innerText || element.textContent || element.getAttribute('placeholder'));
          const elements = [...document.querySelectorAll('a[href],button,input,textarea,select,summary,[role],[data-testid],[aria-label],[contenteditable="true"]')]
            .filter(visible).slice(0, 60).map((element) => ({ role: role(element), name: name(element).slice(0, 160), testId: element.getAttribute('data-testid') || '', placeholder: element.getAttribute('placeholder') || '' }));
          return { url: location.href, title: document.title, text: String(document.body?.innerText || '').slice(0, 3000), elements };
        })()`, false).catch(() => undefined) as { url?: unknown; title?: unknown; text?: unknown; elements?: unknown } | undefined
        if (value !== undefined) {
          const locator = nextChain.map((entry) => `frameLocator(${JSON.stringify(entry)})`).join('.')
          const elementLines = Array.isArray(value.elements) ? value.elements.map((entry) => {
            const item = entry as { role?: unknown; name?: unknown; testId?: unknown; placeholder?: unknown }
            const name = typeof item.name === 'string' && item.name.length > 0 ? ` “${item.name}”` : ''
            const testId = typeof item.testId === 'string' && item.testId.length > 0 ? ` data-testid="${item.testId}"` : ''
            const placeholder = typeof item.placeholder === 'string' && item.placeholder.length > 0 ? ` placeholder="${item.placeholder}"` : ''
            return `- ${String(item.role ?? 'element')}${name}${testId}${placeholder}`
          }) : []
          sections.push([
            `Frame: ${locator}`,
            `URL: ${String(value.url ?? child.url)}`,
            `Title: ${String(value.title ?? '')}`,
            'Visible text:',
            typeof value.text === 'string' && value.text.trim().length > 0 ? value.text.trim() : '(empty)',
            'Interactive elements:',
            elementLines.length > 0 ? elementLines.join('\n') : '(none)',
          ].join('\n'))
        }
        await visit(child, nextChain)
      }
    }
    await visit(tab.view.webContents.mainFrame, [])
    return sections
  }

  private async snapshot(tab: BrowserTabRuntime): Promise<Record<string, unknown>> {
    const expression = `(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01
          && rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0
          && rect.top < innerHeight && rect.left < innerWidth;
      };
      const label = (element) => {
        const aria = element.getAttribute('aria-label');
        const labelledBy = String(element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '').join(' ');
        const associated = 'labels' in element && element.labels ? [...element.labels].map((item) => item.innerText || item.textContent || '').join(' ') : '';
        const text = aria || labelledBy || associated || element.getAttribute('title') || element.getAttribute('alt')
          || element.innerText || element.textContent || element.getAttribute('placeholder') || '';
        return String(text).replace(/\\s+/g, ' ').trim().slice(0, 180);
      };
      const role = (element) => {
        const explicit = String(element.getAttribute('role') || '').trim().split(/\\s+/)[0];
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        const type = String(element.getAttribute('type') || '').toLowerCase();
        if (tag === 'a' && element.hasAttribute('href')) return 'link';
        if (tag === 'button' || tag === 'summary') return 'button';
        if (tag === 'textarea' || element.isContentEditable) return 'textbox';
        if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
        if (tag === 'img') return 'img';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'li') return 'listitem';
        if (tag === 'nav') return 'navigation';
        if (tag === 'main') return 'main';
        if (tag !== 'input') return '';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (!['hidden', 'color', 'file'].includes(type)) return 'textbox';
        return '';
      };
      const candidates = [...document.querySelectorAll('a[href],button,input,textarea,select,summary,label,h1,h2,h3,h4,h5,h6,[role],[data-testid],[aria-label],[contenteditable="true"],[tabindex]:not([tabindex="-1"])')]
        .filter(visible).slice(0, ${String(MAX_SNAPSHOT_ELEMENTS)});
      const storeKey = Symbol.for('dfy-dsh-desktop.browser.snapshot-refs');
      let store = globalThis[storeKey];
      if (!store || !(store.refs instanceof WeakMap) || !Number.isSafeInteger(store.next)) {
        store = { refs: new WeakMap(), next: 1 };
        globalThis[storeKey] = store;
      }
      const refFor = (element) => {
        let ref = store.refs.get(element);
        if (ref === undefined) {
          ref = store.next++;
          store.refs.set(element, ref);
        }
        return ref;
      };
      return {
        url: location.href,
        title: document.title,
        width: innerWidth,
        height: innerHeight,
        scrollX: Math.round(scrollX),
        scrollY: Math.round(scrollY),
        documentWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
        documentHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
        text: String(document.body?.innerText || '').slice(0, ${String(MAX_SNAPSHOT_TEXT)}),
        elements: candidates.map((element) => {
          const rect = element.getBoundingClientRect();
          const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
          return {
            ref: refFor(element),
            tag: element.tagName.toLowerCase(),
            type: element.getAttribute('type') || '',
            role: role(element),
            name: label(element),
            testId: element.getAttribute('data-testid') || '',
            placeholder: element.getAttribute('placeholder') || '',
            value: input && element.type !== 'password' ? String(element.value || '').slice(0, 180) : '',
            href: element instanceof HTMLAnchorElement ? element.href.slice(0, 500) : '',
            checked: 'checked' in element ? String(Boolean(element.checked)) : element.getAttribute('aria-checked') || '',
            expanded: element.getAttribute('aria-expanded') || '',
            multiple: element instanceof HTMLSelectElement && element.multiple,
            options: element instanceof HTMLSelectElement ? [...element.options].slice(0, 12).map((option) => {
              const text = String(option.label || option.text || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
              return option.value === text || option.value === '' ? text : text + ' (' + option.value.slice(0, 80) + ')';
            }) : [],
            x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height),
            disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
          };
        })
      };
    })()`
    const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown } }
    const value = response.result?.value as BrowserSnapshot | undefined
    if (value === undefined || !Array.isArray(value.elements)) throw new Error('无法读取当前网页。')
    tab.snapshotTargets.clear()
    tab.snapshotVersion += 1
    const elementFingerprints = new Map(value.elements.map((element) => [element.ref, JSON.stringify({
      tag: element.tag,
      type: element.type,
      role: element.role,
      name: element.name,
      testId: element.testId,
      placeholder: element.placeholder,
      value: element.value,
      href: element.href,
      checked: element.checked,
      expanded: element.expanded,
      multiple: element.multiple,
      options: element.options,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      disabled: element.disabled,
    })]))
    const previous = tab.lastSnapshot
    const changeLines: string[] = []
    if (previous === undefined) changeLines.push('Initial snapshot.')
    else if (previous.url !== value.url) changeLines.push(`Navigation from ${previous.url || '(blank)'}.`)
    else {
      const added = [...elementFingerprints.keys()].filter((ref) => !previous.elements.has(ref))
      const removed = [...previous.elements.keys()].filter((ref) => !elementFingerprints.has(ref))
      const changed = [...elementFingerprints.entries()]
        .filter(([ref, fingerprint]) => previous.elements.has(ref) && previous.elements.get(ref) !== fingerprint)
        .map(([ref]) => ref)
      const refs = (values: number[]): string => values.length === 0
        ? '(none)'
        : `${values.slice(0, 24).map((ref) => `[${String(ref)}]`).join(', ')}${values.length > 24 ? `, +${String(values.length - 24)} more` : ''}`
      changeLines.push(`Added elements: ${refs(added)}`)
      changeLines.push(`Removed elements: ${refs(removed)}`)
      changeLines.push(`Changed elements: ${refs(changed)}`)
      changeLines.push(`Visible text changed: ${previous.text === value.text ? 'no' : 'yes'}`)
    }
    const lines = value.elements.map((element) => {
      tab.snapshotTargets.set(element.ref, {
        x: element.x + Math.max(1, element.width) / 2,
        y: element.y + Math.max(1, element.height) / 2,
        width: Math.max(1, element.width),
        height: Math.max(1, element.height),
      })
      const role = element.role || element.tag
      const type = element.type ? ` type="${element.type}"` : ''
      const name = element.name ? ` “${element.name}”` : ''
      const testId = element.testId ? ` data-testid="${element.testId}"` : ''
      const placeholder = element.placeholder ? ` placeholder="${element.placeholder}"` : ''
      const currentValue = element.value ? ` value="${element.value}"` : ''
      const href = element.href ? ` href="${element.href}"` : ''
      const checked = element.checked ? ` checked=${element.checked}` : ''
      const expanded = element.expanded ? ` expanded=${element.expanded}` : ''
      const multiple = element.multiple ? ' multiple' : ''
      const options = element.options.length === 0 ? '' : ` options=[${element.options.map((option) => JSON.stringify(option)).join(', ')}]`
      const disabled = element.disabled ? ' disabled' : ''
      return `[${String(element.ref)}] ${role}${type}${name}${testId}${placeholder}${currentValue}${href}${checked}${expanded}${multiple}${options}${disabled} @ (${String(element.x)},${String(element.y)}) ${String(element.width)}×${String(element.height)}`
    })
    const frameSections = await this.frameSnapshotSections(tab)
    const snapshot = [
      `Tab: ${tab.id}`,
      `Snapshot version: ${String(tab.snapshotVersion)}`,
      `URL: ${value.url}`,
      `Title: ${value.title}`,
      `Viewport: ${String(value.width)}×${String(value.height)}`,
      `Page: ${String(value.documentWidth)}×${String(value.documentHeight)} at scroll (${String(value.scrollX)},${String(value.scrollY)})`,
      '',
      `Changes since snapshot version ${previous === undefined ? '(none)' : String(previous.version)}:`,
      ...changeLines,
      '',
      'Visible text:',
      value.text.trim() || '(empty)',
      '',
      'Interactive elements:',
      lines.join('\n') || '(none)',
      ...(frameSections.length === 0 ? [] : ['', 'Frames:', ...frameSections.flatMap((section, index) => index === 0 ? [section] : ['', section])]),
    ].join('\n')
    tab.lastSnapshot = {
      version: tab.snapshotVersion,
      url: value.url,
      text: value.text,
      elements: elementFingerprints,
    }
    return {
      tabId: tab.id,
      url: value.url,
      title: value.title,
      viewport: { width: value.width, height: value.height },
      page: { width: value.documentWidth, height: value.documentHeight, scrollX: value.scrollX, scrollY: value.scrollY },
      snapshotVersion: tab.snapshotVersion,
      snapshot,
    }
  }

  private async locatorExecutionFrame(
    tab: BrowserTabRuntime,
    plan: BrowserLocatorStep[],
  ): Promise<{ frame?: WebFrameMain; plan: BrowserLocatorStep[] }> {
    let frame = tab.view.webContents.mainFrame
    let frameCount = 0
    while (plan[frameCount]?.kind === 'frame') {
      const selector = plan[frameCount]?.value
      if (selector === undefined) break
      const descriptors = await frame.executeJavaScript(`(() => [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((element) => element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement)
        .map((element, index) => ({ index, name: String(element.name || ''), url: String(element.src || '') })))()`) as unknown
      if (!Array.isArray(descriptors)) throw new Error('无法读取 iframe。')
      if (descriptors.length === 0) throw new Error(`frameLocator 没有匹配到 iframe：${selector}`)
      if (descriptors.length > 1) throw new Error(`frameLocator 严格模式失败：匹配到 ${String(descriptors.length)} 个 iframe。`)
      const descriptor = descriptors[0] as { index?: unknown; name?: unknown; url?: unknown }
      const children = frame.frames.filter((child) => !child.isDestroyed())
      const byName = typeof descriptor.name === 'string' && descriptor.name.length > 0
        ? children.filter((child) => child.name === descriptor.name)
        : []
      const byUrl = typeof descriptor.url === 'string' && descriptor.url.length > 0
        ? children.filter((child) => child.url === descriptor.url)
        : []
      const index = typeof descriptor.index === 'number' && Number.isInteger(descriptor.index) ? descriptor.index : -1
      const child = byName.length === 1 ? byName[0] : byUrl.length === 1 ? byUrl[0] : children[index]
      if (child === undefined) throw new Error(`无法连接 frameLocator 匹配的 iframe：${selector}`)
      frame = child
      frameCount += 1
    }
    if (plan.slice(frameCount).some((step) => step.kind === 'frame')) {
      throw new Error('frameLocator 必须在该 FrameLocator 的元素定位步骤之前。')
    }
    return { ...(frameCount === 0 ? {} : { frame }), plan: plan.slice(frameCount) }
  }

  private async resolveLocator(
    tab: BrowserTabRuntime,
    plan: BrowserLocatorStep[],
    operation: string,
    request: DesktopBrowserAgentRequest,
  ): Promise<BrowserLocatorResolution> {
    const target = await this.locatorExecutionFrame(tab, plan)
    const locatorPlan = target.plan
    if (locatorPlan.length === 0) throw new Error('frameLocator 后必须继续定位 frame 内的元素。')
    const attribute = operation === 'get-attribute' ? request.attribute : undefined
    if (attribute !== undefined && (typeof attribute !== 'string' || attribute.length === 0 || attribute.length > 200)) {
      throw new Error('attribute 必须是非空字符串。')
    }
    const selection = operation === 'select-option' ? request.values : undefined
    if (selection !== undefined && (!Array.isArray(selection) || selection.length === 0 || selection.some((entry) => {
      if (typeof entry === 'string') return entry.length === 0
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return true
      const value = entry as Record<string, unknown>
      const keys = ['value', 'label', 'index'].filter((key) => value[key] !== undefined)
      return keys.length === 0
        || (value.value !== undefined && typeof value.value !== 'string')
        || (value.label !== undefined && typeof value.label !== 'string')
        || (value.index !== undefined && (typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0))
    }))) {
      throw new Error('values 必须是非空的字符串或 option 描述符数组。')
    }
    const evaluation = operation === 'evaluate' || operation === 'evaluate-all'
      ? prepareReadOnlyEvaluation(request)
      : undefined
    const frameDomAction = target.frame !== undefined
    const domClickCount = operation === 'click' && (!tab.view.getVisible() || frameDomAction)
      ? request.clickCount === undefined ? 1 : positiveInteger(request.clickCount, 'clickCount', 1, 3)
      : 0
    const domClickButton = operation === 'click' ? mouseButton(request.button) : mouseButton(undefined)
    const domClickModifiers = operation === 'click' ? inputModifierState(request.modifiers) : inputModifierState(undefined)
    const domInput = ((!tab.view.getVisible() || frameDomAction) && (operation === 'fill' || operation === 'type'))
      || operation === 'press-sequentially'
      ? request.value
      : undefined
    const domKey = operation === 'press' && (!tab.view.getVisible() || frameDomAction) ? request.key : undefined
    const domFocus = operation === 'focus'
    const domChecked = operation === 'set-checked' ? request.checked : undefined
    const expression = `(async () => {
      try {
        const plan = ${JSON.stringify(locatorPlan)};
        const operation = ${JSON.stringify(operation)};
        const attribute = ${JSON.stringify(attribute)};
        const selection = ${JSON.stringify(selection)};
        const domClickCount = ${String(domClickCount)};
        const domClickButton = ${String(domClickButton.dom)};
        const domClickModifiers = ${JSON.stringify(domClickModifiers)};
        const domInput = ${JSON.stringify(domInput)};
        const domKey = ${JSON.stringify(domKey)};
        const domFocus = ${String(domFocus)};
        const domChecked = ${JSON.stringify(domChecked)};
        const evaluationCallable = ${evaluation === undefined ? 'undefined' : `(${evaluation.source})`};
        const evaluationArgument = ${evaluation?.argument ?? 'null'};
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const matches = (actual, expected, exact) => {
          const left = normalize(actual);
          const right = normalize(expected);
          return exact ? left === right : left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
        };
        const matchesMatcher = (actual, matcher, exact = false) => matcher?.namePattern !== undefined
          ? new RegExp(matcher.namePattern, matcher.nameFlags || '').test(normalize(actual))
          : matches(actual, matcher?.value || '', exact);
        const labelledText = (element) => {
          const aria = element.getAttribute('aria-label');
          if (aria) return normalize(aria);
          const labelledBy = normalize(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean)
            .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '').join(' ');
          if (labelledBy) return normalize(labelledBy);
          if ('labels' in element && element.labels) {
            const labels = [...element.labels].map((label) => label.innerText || label.textContent || '').join(' ');
            if (labels) return normalize(labels);
          }
          return '';
        };
        const implicitRole = (element) => {
          const explicit = normalize(element.getAttribute('role')).split(' ')[0];
          if (explicit) return explicit;
          const tag = element.tagName.toLowerCase();
          const type = normalize(element.getAttribute('type')).toLowerCase();
          if (tag === 'a' && element.hasAttribute('href')) return 'link';
          if (tag === 'button' || tag === 'summary') return 'button';
          if (tag === 'textarea' || element.isContentEditable) return 'textbox';
          if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
          if (tag === 'img') return 'img';
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'li') return 'listitem';
          if (tag === 'ul' || tag === 'ol') return 'list';
          if (tag === 'nav') return 'navigation';
          if (tag === 'main') return 'main';
          if (tag === 'table') return 'table';
          if (tag === 'tr') return 'row';
          if (tag === 'th') return element.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
          if (tag === 'td') return 'cell';
          if (tag === 'option') return 'option';
          if (tag !== 'input') return '';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'range') return 'slider';
          if (type === 'number') return 'spinbutton';
          if (type === 'search') return 'searchbox';
          if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
          if (!['hidden', 'color', 'file'].includes(type)) return 'textbox';
          return '';
        };
        const accessibleName = (element) => {
          const labelled = labelledText(element);
          if (labelled) return labelled;
          const alt = element.getAttribute('alt') || element.getAttribute('title');
          if (alt) return normalize(alt);
          if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) && element.value) return normalize(element.value);
          return normalize(element.innerText || element.textContent || element.getAttribute('placeholder') || '');
        };
        const visible = (element) => {
          if (!element.isConnected) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01
            && rect.width > 0 && rect.height > 0;
        };
        const enabled = (element) => !Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true');
        const inputEvent = (inputType, data) => typeof InputEvent === 'function'
          ? new InputEvent('input', { bubbles: true, composed: true, inputType, data })
          : new Event('input', { bubbles: true, composed: true });
        const editableValue = (element) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
          if (element.isContentEditable) return element.textContent || '';
          return undefined;
        };
        const setEditableValue = (element, value, inputType = 'insertText') => {
          const current = editableValue(element);
          if (current === undefined) return false;
          element.focus();
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element instanceof HTMLInputElement && ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type)) return false;
            const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(element, value);
            else element.value = value;
            const caret = value.length;
            if (typeof element.setSelectionRange === 'function') element.setSelectionRange(caret, caret);
          } else {
            element.textContent = value;
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            const selection = getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
          element.dispatchEvent(inputEvent(inputType, value));
          return true;
        };
        const pressElement = (element, rawKey) => {
          element.focus();
          const parts = String(rawKey).split('+').filter(Boolean);
          const requested = parts.pop();
          if (!requested) return false;
          const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
          const modifiers = new Set(parts.map((part) => part === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : part));
          const key = requested === 'Space' ? ' ' : requested;
          const eventOptions = {
            key,
            code: requested.length === 1 && /^[a-z]$/i.test(requested) ? 'Key' + requested.toUpperCase() : requested,
            bubbles: true,
            composed: true,
            cancelable: true,
            altKey: modifiers.has('Alt'),
            ctrlKey: modifiers.has('Control'),
            metaKey: modifiers.has('Meta'),
            shiftKey: modifiers.has('Shift'),
          };
          const allowed = element.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
          if (allowed) {
            const editable = editableValue(element);
            const selectAll = requested.toLowerCase() === 'a' && (eventOptions.ctrlKey || eventOptions.metaKey);
            if (selectAll && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
              element.select();
            } else if (requested === 'Enter') {
              if (element instanceof HTMLAnchorElement || element instanceof HTMLButtonElement
                || (element instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image'].includes(element.type))) {
                element.click();
              } else if (element instanceof HTMLTextAreaElement || element.isContentEditable) {
                setEditableValue(element, (editable || '') + '\\n', 'insertLineBreak');
              } else if ('form' in element && element.form instanceof HTMLFormElement) {
                element.form.requestSubmit();
              }
            } else if (requested === 'Space' && (element instanceof HTMLButtonElement
              || (element instanceof HTMLInputElement && ['button', 'checkbox', 'radio'].includes(element.type)))) {
              element.click();
            } else if ((requested === 'Backspace' || requested === 'Delete') && editable !== undefined) {
              setEditableValue(element, editable.slice(0, -1), 'deleteContentBackward');
            } else if (requested.length === 1 && !eventOptions.altKey && !eventOptions.ctrlKey && !eventOptions.metaKey && editable !== undefined) {
              setEditableValue(element, editable + requested, 'insertText');
            }
          }
          element.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
          return true;
        };
        const descendants = (root) => [...root.querySelectorAll('*')];
        const unique = (values) => [...new Set(values)];
        const resolveSteps = (steps, initial = [document], depth = 0) => {
          if (depth > 4) throw new Error('Locator combination is too deeply nested');
          let roots = initial;
          for (const step of steps) {
            if (step.kind === 'nth') {
              const index = Number(step.value);
              const selected = index < 0 ? roots.at(index) : roots[index];
              roots = selected === undefined ? [] : [selected];
              continue;
            }
            if (step.kind === 'css') {
              roots = unique(roots.flatMap((root) => [...root.querySelectorAll(step.value)]));
              continue;
            }
            if (step.kind === 'filter') {
              const filter = JSON.parse(step.value);
              roots = roots.filter((element) => {
                const text = normalize(element.innerText || element.textContent || '');
                return (filter.hasText === undefined || matchesMatcher(text, filter.hasText))
                  && (filter.hasNotText === undefined || !matchesMatcher(text, filter.hasNotText))
                  && (filter.has === undefined || resolveSteps(filter.has, [element], depth + 1).length > 0)
                  && (filter.hasNot === undefined || resolveSteps(filter.hasNot, [element], depth + 1).length === 0)
                  && (filter.visible === undefined || visible(element) === filter.visible);
              });
              continue;
            }
            if (step.kind === 'and' || step.kind === 'or') {
              const other = resolveSteps(JSON.parse(step.value), [document], depth + 1);
              const otherSet = new Set(other);
              roots = step.kind === 'and' ? roots.filter((element) => otherSet.has(element)) : unique([...roots, ...other]);
              continue;
            }
            let candidates = unique(roots.flatMap(descendants)).filter((element) => !['script', 'style', 'noscript', 'template'].includes(element.tagName.toLowerCase()));
            if (step.kind === 'role') {
              candidates = candidates.filter((element) => implicitRole(element) === step.value
                && (step.name === undefined || matches(accessibleName(element), step.name, step.exact === true))
                && (step.namePattern === undefined || new RegExp(step.namePattern, step.nameFlags || '').test(accessibleName(element))));
            } else if (step.kind === 'text') {
              const matched = candidates.filter((element) => matchesMatcher(element.innerText || element.textContent || '', step, step.exact === true));
              candidates = matched.filter((element) => ![...element.children]
                .some((child) => matchesMatcher(child.innerText || child.textContent || '', step, step.exact === true)));
            } else if (step.kind === 'label') {
              candidates = candidates.filter((element) => matchesMatcher(labelledText(element), step, step.exact === true));
            } else if (step.kind === 'placeholder') {
              candidates = candidates.filter((element) => matchesMatcher(element.getAttribute('placeholder'), step, step.exact === true));
            } else if (step.kind === 'testid') {
              candidates = candidates.filter((element) => element.getAttribute('data-testid') === step.value);
            }
            roots = candidates;
          }
          return roots;
        };
        const roots = resolveSteps(plan);
        const elements = roots.filter((value) => value instanceof Element);
        if (elements.length === 1 && ['click', 'fill', 'type', 'press', 'press-sequentially', 'select-option', 'download-media'].includes(operation)) {
          elements[0].scrollIntoView({ block: 'center', inline: 'center' });
        }
        const first = elements[0];
        const result = {
          count: elements.length,
          visibleCount: elements.filter(visible).length,
          ...(operation === 'all-text-contents' ? { textContents: elements.map((element) => String(element.textContent || '').slice(0, 20000)) } : {}),
        };
        if (first) {
          const rect = first.getBoundingClientRect();
          result.first = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
            visible: visible(first),
            enabled: enabled(first),
            innerText: String(first.innerText || '').slice(0, 20000),
            textContent: first.textContent === null ? null : String(first.textContent).slice(0, 20000),
            ...(attribute === undefined ? {} : { attribute: first.getAttribute(attribute) }),
          };
          if (operation === 'download-media') {
            const source = first.currentSrc || first.href || first.src || first.getAttribute('href') || first.getAttribute('src');
            if (source) result.mediaUrl = new URL(source, document.baseURI).href;
          }
        }
        if ((operation === 'evaluate' || operation === 'evaluate-all') && evaluationCallable !== undefined) {
          if (typeof evaluationCallable !== 'function') return { ...result, error: 'Locator evaluate requires a callable function' };
          if (operation === 'evaluate' && elements.length === 1) {
            result.evaluation = await Promise.resolve(evaluationCallable(first, evaluationArgument));
          } else if (operation === 'evaluate-all') {
            result.evaluation = await Promise.resolve(evaluationCallable(elements, evaluationArgument));
          }
        }
        if (operation === 'select-option' && elements.length === 1) {
          if (!(first instanceof HTMLSelectElement)) return { ...result, error: 'Locator does not resolve to a native select element' };
          if (!visible(first)) return { ...result, error: 'Locator resolves to a hidden select element' };
          if (!enabled(first)) return { ...result, error: 'Locator resolves to a disabled select element' };
          const requested = selection;
          const options = [...first.options];
          const matched = requested.flatMap((entry) => {
            if (typeof entry === 'string') return options.filter((option) => option.value === entry);
            return options.filter((option, index) => (entry.value === undefined || option.value === entry.value)
              && (entry.label === undefined || option.label === entry.label || option.text.trim() === entry.label)
              && (entry.index === undefined || index === entry.index));
          }).filter((option, index, values) => values.indexOf(option) === index);
          if (matched.length === 0) return { ...result, error: 'No requested option exists in the select element' };
          const selected = first.multiple ? matched : matched.slice(0, 1);
          const selectedSet = new Set(selected);
          for (const option of first.options) option.selected = selectedSet.has(option);
          first.dispatchEvent(new Event('input', { bubbles: true }));
          first.dispatchEvent(new Event('change', { bubbles: true }));
          result.selectedValues = selected.map((option) => option.value);
          result.selectedLabels = selected.map((option) => option.label || option.text);
        }
        if (operation === 'click' && domClickCount > 0 && elements.length === 1) {
          if (!visible(first)) return { ...result, error: 'Locator resolves to a hidden element' };
          if (!enabled(first)) return { ...result, error: 'Locator resolves to a disabled element' };
          if (typeof first.dispatchEvent !== 'function') return { ...result, error: 'Locator does not resolve to a clickable element' };
          const rect = first.getBoundingClientRect();
          for (let count = 1; count <= domClickCount; count += 1) {
            const common = { bubbles: true, composed: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
              button: domClickButton, detail: count, ...domClickModifiers };
            first.dispatchEvent(new MouseEvent('mousedown', common));
            first.dispatchEvent(new MouseEvent('mouseup', common));
            first.dispatchEvent(new MouseEvent('click', common));
            if (domClickButton === 2) first.dispatchEvent(new MouseEvent('contextmenu', common));
          }
          if (domClickCount === 2) first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true, cancelable: true, button: domClickButton, detail: 2, ...domClickModifiers }));
          result.domAction = 'click';
        }
        if ((operation === 'fill' || operation === 'type') && domInput !== undefined && elements.length === 1) {
          if (!visible(first)) return { ...result, error: 'Locator resolves to a hidden element' };
          if (!enabled(first)) return { ...result, error: 'Locator resolves to a disabled element' };
          const nextValue = operation === 'fill' ? domInput : (editableValue(first) || '') + domInput;
          if (!setEditableValue(first, nextValue)) return { ...result, error: 'Locator does not resolve to an editable element' };
          if (operation === 'fill') first.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          result.domAction = operation;
        }
        if (operation === 'press-sequentially' && typeof domInput === 'string' && elements.length === 1) {
          if (!visible(first)) return { ...result, error: 'Locator resolves to a hidden element' };
          if (!enabled(first)) return { ...result, error: 'Locator resolves to a disabled element' };
          if (editableValue(first) === undefined) return { ...result, error: 'Locator does not resolve to an editable element' };
          for (const character of domInput) {
            const current = editableValue(first) || '';
            if (!setEditableValue(first, current + character)) return { ...result, error: 'Unable to type sequentially into this element' };
          }
          result.domAction = 'type';
        }
        if (operation === 'press' && domKey !== undefined && elements.length === 1) {
          if (!visible(first)) return { ...result, error: 'Locator resolves to a hidden element' };
          if (!enabled(first)) return { ...result, error: 'Locator resolves to a disabled element' };
          if (!pressElement(first, domKey)) return { ...result, error: 'Unable to press the requested key on this element' };
          result.domAction = 'press';
        }
        if (operation === 'focus' && domFocus && elements.length === 1) {
          if (!enabled(first)) return { ...result, error: 'Locator resolves to a disabled element' };
          if (typeof first.focus !== 'function') return { ...result, error: 'Locator does not resolve to a focusable element' };
          first.focus();
          result.domAction = 'focus';
        }
        if (operation === 'set-checked' && typeof domChecked === 'boolean' && elements.length === 1) {
          if (!visible(first)) return { ...result, error: 'Locator resolves to a hidden element' };
          if (!enabled(first)) return { ...result, error: 'Locator resolves to a disabled element' };
          const native = first instanceof HTMLInputElement && ['checkbox', 'radio'].includes(first.type);
          const current = native ? first.checked : first.getAttribute('aria-checked') === 'true';
          if (!native && first.getAttribute('role') !== 'checkbox' && first.getAttribute('role') !== 'switch') {
            return { ...result, error: 'Locator does not resolve to a checkbox or switch-like control' };
          }
          if (current !== domChecked) first.click();
          const updated = native ? first.checked : first.getAttribute('aria-checked') === 'true';
          if (updated !== domChecked) return { ...result, error: 'Control did not reach the requested checked state' };
          result.checked = updated;
          result.domAction = 'set-checked';
        }
        return result;
      } catch (error) {
        return { count: 0, visibleCount: 0, error: String(error?.message || error) };
      }
    })()`
    const resolution = target.frame === undefined
      ? ((await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: BrowserLocatorResolution } }).result?.value)
      : await target.frame.executeJavaScript(expression, true) as BrowserLocatorResolution
    if (resolution === undefined || !Number.isInteger(resolution.count) || !Number.isInteger(resolution.visibleCount)) {
      throw new Error('无法解析网页定位器。')
    }
    if (resolution.error !== undefined) throw new Error(resolution.error)
    return resolution
  }

  private async waitForLocator(
    tab: BrowserTabRuntime,
    plan: BrowserLocatorStep[],
    request: DesktopBrowserAgentRequest,
  ): Promise<Record<string, unknown>> {
    const state = request.state === undefined ? 'visible' : request.state
    if (state !== 'visible' && state !== 'hidden' && state !== 'attached' && state !== 'detached') {
      throw new Error('state 必须是 visible、hidden、attached 或 detached。')
    }
    const timeoutMs = request.timeoutMs === undefined ? 10_000 : positiveInteger(request.timeoutMs, 'timeoutMs', 250, 30_000)
    const deadline = Date.now() + timeoutMs
    let resolution: BrowserLocatorResolution | undefined
    while (Date.now() <= deadline) {
      resolution = await this.resolveLocator(tab, plan, 'wait-for', request)
      const ready = state === 'visible'
        ? resolution.visibleCount > 0
        : state === 'hidden'
          ? resolution.visibleCount === 0
          : state === 'attached'
            ? resolution.count > 0
            : resolution.count === 0
      if (ready) return { ok: true, tabId: tab.id, operation: 'wait-for', state, count: resolution.count }
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`等待 Locator 变为 ${state} 超时（${String(timeoutMs)}ms）。`)
  }

  private async resolveActionableLocator(
    tab: BrowserTabRuntime,
    plan: BrowserLocatorStep[],
    operation: string,
    request: DesktopBrowserAgentRequest,
  ): Promise<BrowserLocatorResolution> {
    const timeoutMs = request.timeoutMs === undefined ? 5_000 : positiveInteger(request.timeoutMs, 'timeoutMs', 250, 30_000)
    const deadline = Date.now() + timeoutMs
    let previous: BrowserLocatorMatch | undefined
    while (Date.now() <= deadline) {
      const resolution = await this.resolveLocator(tab, plan, 'wait-for', request)
      if (resolution.count > 1) throw new Error(`Locator 严格模式失败：匹配到 ${String(resolution.count)} 个元素。`)
      const match = resolution.first
      if (resolution.count === 1 && match !== undefined && match.visible && match.enabled) {
        const stable = previous !== undefined
          && Math.abs(previous.x - match.x) < 0.75
          && Math.abs(previous.y - match.y) < 0.75
          && Math.abs(previous.width - match.width) < 0.75
          && Math.abs(previous.height - match.height) < 0.75
        if (stable) return await this.resolveLocator(tab, plan, operation, request)
        previous = match
      } else {
        previous = undefined
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 75))
    }
    throw new Error(`等待 Locator 可操作超时（${String(timeoutMs)}ms）。`)
  }

  private async locatorAction(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (typeof request.operation !== 'string') throw new Error('operation 是必填项。')
    const operation = request.operation
    const supported = new Set([
      'count', 'click', 'fill', 'type', 'press', 'select-option', 'inner-text', 'text-content',
      'get-attribute', 'is-visible', 'is-enabled', 'wait-for', 'focus', 'all-text-contents', 'set-checked',
      'evaluate', 'evaluate-all', 'download-media', 'press-sequentially', 'screenshot',
    ])
    if (!supported.has(operation)) throw new Error(`不支持的 Locator 操作：${operation}`)
    if ((operation === 'fill' || operation === 'type' || operation === 'press-sequentially') && typeof request.value !== 'string') throw new Error('value 必须是字符串。')
    if (operation === 'press' && (typeof request.key !== 'string' || request.key.length === 0)) throw new Error('key 必须是非空字符串。')
    if (operation === 'set-checked' && typeof request.checked !== 'boolean') throw new Error('checked 必须是布尔值。')
    const plan = parseLocatorPlan(request)
    if (operation === 'screenshot' && plan.some((step) => step.kind === 'frame')) {
      throw new Error('暂不支持跨 frame 的 Locator 元素截图。')
    }
    if (operation === 'wait-for') return await this.waitForLocator(tab, plan, request)
    const actionable = new Set(['click', 'fill', 'type', 'press', 'press-sequentially', 'select-option', 'focus', 'set-checked', 'download-media'])
    const work = actionable.has(operation)
      ? this.resolveActionableLocator(tab, plan, operation, request)
      : this.resolveLocator(tab, plan, operation, request)
    const evaluation = operation === 'evaluate' || operation === 'evaluate-all' ? prepareReadOnlyEvaluation(request) : undefined
    const resolution = evaluation === undefined
      ? await work
      : await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`evaluate 超时（${String(evaluation.timeoutMs)}ms）。`)), evaluation.timeoutMs)),
        ])
    if (operation === 'count') return { ok: true, tabId: tab.id, operation, count: resolution.count }
    if (operation === 'is-visible') return { ok: true, tabId: tab.id, operation, value: resolution.first?.visible === true }
    if (operation === 'is-enabled') return { ok: true, tabId: tab.id, operation, value: resolution.first?.enabled === true }
    if (operation === 'all-text-contents') return { ok: true, tabId: tab.id, operation, values: resolution.textContents ?? [] }
    if (operation === 'evaluate-all') return { ok: true, tabId: tab.id, operation, value: resolution.evaluation ?? null }
    const match = strictLocator(resolution)
    if (operation === 'evaluate') return { ok: true, tabId: tab.id, operation, value: resolution.evaluation ?? null }
    if (operation === 'inner-text') return { ok: true, tabId: tab.id, operation, value: match.innerText }
    if (operation === 'text-content') return { ok: true, tabId: tab.id, operation, value: match.textContent }
    if (operation === 'get-attribute') return { ok: true, tabId: tab.id, operation, value: match.attribute ?? null }
    if (!match.visible) throw new Error('Locator 匹配的元素当前不可见。')
    if (operation === 'screenshot') {
      return await this.captureScreenshot(tab, 'element', {
        x: match.x - match.width / 2,
        y: match.y - match.height / 2,
        width: match.width,
        height: match.height,
      })
    }
    if (!match.enabled) throw new Error('Locator 匹配的元素当前不可用。')
    if (resolution.domAction === operation || (operation === 'press-sequentially' && resolution.domAction === 'type')) {
      this.invalidateTabSnapshot(tab)
      if (operation === 'click') {
        return { ok: true, tabId: tab.id, operation, clickCount: request.clickCount ?? 1, method: 'dom' }
      }
      if (operation === 'fill' || operation === 'type') return { ok: true, tabId: tab.id, operation, characters: String(request.value).length, method: 'dom' }
      if (operation === 'press-sequentially') return { ok: true, tabId: tab.id, operation, characters: String(request.value).length, method: 'dom' }
      if (operation === 'press') return { ok: true, tabId: tab.id, operation, key: request.key, method: 'dom' }
      if (operation === 'focus') return { ok: true, tabId: tab.id, operation, method: 'dom' }
      if (operation === 'set-checked') return { ok: true, tabId: tab.id, operation, checked: resolution.checked, method: 'dom' }
    }
    if (operation === 'click') {
      const result = await this.click(tab, { x: match.x, y: match.y, clickCount: request.clickCount, button: request.button, keypress: request.modifiers })
      return { ...result, operation }
    }
    if (operation === 'fill' || operation === 'type') {
      const result = await this.typeText(tab, { x: match.x, y: match.y, text: request.value, clear: operation === 'fill' })
      return { ...result, operation }
    }
    if (operation === 'press') {
      await this.click(tab, { x: match.x, y: match.y })
      const result = await this.pressKey(tab, { key: request.key })
      return { ...result, operation }
    }
    if (operation === 'focus') {
      throw new Error('无法聚焦 Locator 匹配的元素。')
    }
    if (operation === 'select-option') {
      this.invalidateTabSnapshot(tab)
      return {
        ok: true,
        tabId: tab.id,
        operation,
        values: resolution.selectedValues ?? [],
        labels: resolution.selectedLabels ?? [],
      }
    }
    if (operation === 'download-media') {
      if (typeof resolution.mediaUrl !== 'string' || !/^https?:\/\//iu.test(resolution.mediaUrl)) {
        throw new Error('Locator 没有可下载的 HTTP(S) 媒体地址。')
      }
      tab.view.webContents.downloadURL(resolution.mediaUrl)
      return { ok: true, tabId: tab.id, operation }
    }
    throw new Error(`不支持的 Locator 操作：${operation}`)
  }

  private async hover(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    const target = targetFromRequest(tab, request)
    const modifiers = inputModifierState(request.keypress)
    if (!tab.view.getVisible()) {
      const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
        expression: `(() => {
          const x = ${JSON.stringify(target.x)}, y = ${JSON.stringify(target.y)};
          const element = document.elementFromPoint(x, y);
          if (!element) return false;
          const modifiers = ${JSON.stringify(modifiers)};
          element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true, clientX: x, clientY: y, ...modifiers }));
          element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, composed: true, clientX: x, clientY: y, ...modifiers }));
          element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: x, clientY: y, ...modifiers }));
          return true;
        })()`,
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      if (response.result?.value !== true) throw new Error('坐标处没有可悬停的网页元素。')
      return { ok: true, tabId: tab.id, x: Math.round(target.x), y: Math.round(target.y), method: 'dom' }
    }
    await this.pointer(tab, target.x, target.y, false)
    await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, modifiers: modifiers.mask })
    this.invalidateTabSnapshot(tab)
    return { ok: true, tabId: tab.id, x: Math.round(target.x), y: Math.round(target.y) }
  }

  private async pressKey(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (!tab.view.getVisible()) {
      if (typeof request.key !== 'string' || request.key.length === 0) throw new Error('不支持这个按键。')
      const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
        expression: `(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLElement)) return false;
          const parts = ${JSON.stringify(request.key)}.split('+').filter(Boolean);
          const requested = parts.pop();
          if (!requested) return false;
          const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
          const modifiers = new Set(parts.map((part) => part === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : part));
          const key = requested === 'Space' ? ' ' : requested;
          const options = { key, code: requested.length === 1 ? 'Key' + requested.toUpperCase() : requested, bubbles: true, composed: true, cancelable: true,
            altKey: modifiers.has('Alt'), ctrlKey: modifiers.has('Control'), metaKey: modifiers.has('Meta'), shiftKey: modifiers.has('Shift') };
          const allowed = element.dispatchEvent(new KeyboardEvent('keydown', options));
          if (allowed && requested.toLowerCase() === 'a' && (options.ctrlKey || options.metaKey) && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) element.select();
          else if (allowed && requested === 'Enter') {
            if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) element.click();
            else if ('form' in element && element.form instanceof HTMLFormElement) element.form.requestSubmit();
          } else if (allowed && requested === 'Space' && (element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && ['checkbox','radio'].includes(element.type)))) element.click();
          else if (allowed && requested === 'Tab') {
            const focusable = [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]:not([tabindex="-1"])')].filter((entry) => !entry.disabled);
            const index = focusable.indexOf(element);
            const direction = options.shiftKey ? -1 : 1;
            const next = focusable[(index + direction + focusable.length) % focusable.length];
            if (next instanceof HTMLElement) next.focus();
          }
          element.dispatchEvent(new KeyboardEvent('keyup', options));
          return true;
        })()`,
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      if (response.result?.value !== true) throw new Error('当前页面没有可接收按键的焦点元素。')
      this.invalidateTabSnapshot(tab)
      return { ok: true, tabId: tab.id, key: request.key, method: 'dom' }
    }
    const definitions: Record<string, { code: string; virtualKeyCode: number; text?: string }> = {
      Enter: { code: 'Enter', virtualKeyCode: 13, text: '\r' },
      Escape: { code: 'Escape', virtualKeyCode: 27 },
      Tab: { code: 'Tab', virtualKeyCode: 9 },
      ArrowUp: { code: 'ArrowUp', virtualKeyCode: 38 },
      ArrowDown: { code: 'ArrowDown', virtualKeyCode: 40 },
      ArrowLeft: { code: 'ArrowLeft', virtualKeyCode: 37 },
      ArrowRight: { code: 'ArrowRight', virtualKeyCode: 39 },
      Backspace: { code: 'Backspace', virtualKeyCode: 8 },
      Delete: { code: 'Delete', virtualKeyCode: 46 },
      Home: { code: 'Home', virtualKeyCode: 36 },
      End: { code: 'End', virtualKeyCode: 35 },
      PageUp: { code: 'PageUp', virtualKeyCode: 33 },
      PageDown: { code: 'PageDown', virtualKeyCode: 34 },
      Space: { code: 'Space', virtualKeyCode: 32, text: ' ' },
    }
    if (typeof request.key !== 'string' || request.key.length === 0) throw new Error('不支持这个按键。')
    const requestedKey = request.key
    const keyParts = requestedKey.split('+').filter(Boolean)
    const key = keyParts.pop()
    if (key === undefined) throw new Error('不支持这个按键。')
    const printable = key.length === 1
      ? {
          code: /^[a-z]$/iu.test(key) ? `Key${key.toUpperCase()}` : /^\d$/u.test(key) ? `Digit${key}` : '',
          virtualKeyCode: key.toUpperCase().codePointAt(0) ?? 0,
          text: key,
        }
      : undefined
    const definition = definitions[key] ?? printable
    if (definition === undefined) throw new Error('不支持这个按键。')
    if (request.modifiers !== undefined && (!Array.isArray(request.modifiers) || request.modifiers.some((value) => typeof value !== 'string'))) {
      throw new Error('modifiers 必须是按键名称数组。')
    }
    const explicitModifiers = request.modifiers as string[] | undefined
    const modifierValues = [...new Set([
      ...keyParts.map((modifier) => modifier === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : modifier),
      ...(explicitModifiers ?? []),
    ])]
    const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
    let modifiers = 0
    for (const modifier of modifierValues) {
      const bit = modifierBits[modifier]
      if (bit === undefined) throw new Error(`不支持修饰键：${modifier}。`)
      modifiers |= bit
    }
    const sendsText = definition.text !== undefined && (modifiers & 7) === 0
    const common = {
      key: key === 'Space' ? ' ' : key,
      code: definition.code,
      windowsVirtualKeyCode: definition.virtualKeyCode,
      nativeVirtualKeyCode: definition.virtualKeyCode,
      modifiers,
      ...(sendsText ? { text: definition.text, unmodifiedText: definition.text } : {}),
    }
    await this.debuggerCommandFor(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...common })
    await this.debuggerCommandFor(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    this.invalidateTabSnapshot(tab)
    return { ok: true, tabId: tab.id, key: requestedKey, modifiers: modifierValues }
  }

  private async selectOption(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (typeof request.ref !== 'number') throw new Error('ref 是必填项。')
    targetFromRequest(tab, request)
    if (!Array.isArray(request.values) || request.values.length === 0 || request.values.some((value) => typeof value !== 'string')) {
      throw new Error('values 必须是非空字符串数组。')
    }
    const values = [...new Set(request.values as string[])]
    const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
      expression: `(() => {
        const store = globalThis[Symbol.for('dfy-dsh-desktop.browser.snapshot-refs')];
        if (!store || !(store.refs instanceof WeakMap)) return { error: 'stale' };
        const ref = ${String(request.ref)};
        const requested = ${JSON.stringify(values)};
        const element = [...document.querySelectorAll('select')].find((candidate) => store.refs.get(candidate) === ref);
        if (!(element instanceof HTMLSelectElement)) return { error: 'not-select' };
        const matches = [...element.options].filter((option) => requested.includes(option.value) || requested.includes(option.label) || requested.includes(option.text.trim()));
        if (matches.length === 0) return { error: 'missing-option' };
        const selected = element.multiple ? matches : matches.slice(0, 1);
        const selectedSet = new Set(selected);
        for (const option of element.options) option.selected = selectedSet.has(option);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { values: selected.map((option) => option.value), labels: selected.map((option) => option.label || option.text) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: { error?: unknown; values?: unknown; labels?: unknown } } }
    const result = response.result?.value
    if (result?.error === 'stale') throw new Error('这个元素引用已失效，请重新调用 browser_snapshot。')
    if (result?.error === 'not-select') throw new Error('指定元素不是原生下拉框。')
    if (result?.error === 'missing-option') throw new Error('下拉框中没有匹配的选项。')
    if (!Array.isArray(result?.values) || !Array.isArray(result.labels)) throw new Error('无法选择下拉框选项。')
    this.invalidateTabSnapshot(tab)
    return { ok: true, tabId: tab.id, values: result.values, labels: result.labels }
  }

  private async click(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    const target = targetFromRequest(tab, request)
    const clickCount = request.clickCount === undefined ? 1 : positiveInteger(request.clickCount, 'clickCount', 1, 3)
    const button = mouseButton(request.button)
    const modifiers = inputModifierState(request.keypress ?? request.modifiers)
    if (!tab.view.getVisible() && (button.cdp === 'back' || button.cdp === 'forward')) {
      return await this.historyNavigationFor(tab, button.cdp)
    }
    if (!tab.view.getVisible()) {
      const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
        expression: `(() => {
          const x = ${JSON.stringify(target.x)}, y = ${JSON.stringify(target.y)}, clickCount = ${String(clickCount)};
          const button = ${String(button.dom)}, modifiers = ${JSON.stringify(modifiers)};
          const element = document.elementFromPoint(x, y);
          if (!(element instanceof HTMLElement)) return false;
          element.focus({ preventScroll: true });
          element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: x, clientY: y, ...modifiers }));
          for (let count = 1; count <= clickCount; count += 1) {
            const common = { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button, detail: count, ...modifiers };
            element.dispatchEvent(new MouseEvent('mousedown', common));
            element.dispatchEvent(new MouseEvent('mouseup', common));
            element.dispatchEvent(new MouseEvent('click', common));
            if (button === 2) element.dispatchEvent(new MouseEvent('contextmenu', common));
          }
          if (clickCount === 2) element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button, detail: 2, ...modifiers }));
          return true;
        })()`,
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      if (response.result?.value !== true) throw new Error('坐标处没有可点击的网页元素。')
      this.invalidateTabSnapshot(tab)
      return { ok: true, tabId: tab.id, x: Math.round(target.x), y: Math.round(target.y), clickCount, button: button.cdp, method: 'dom' }
    }
    if (button.cdp === 'left') await this.pointer(tab, target.x, target.y, false)
    await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, modifiers: modifiers.mask })
    for (let count = 1; count <= clickCount; count += 1) {
      if (button.cdp === 'left') await this.pointer(tab, target.x, target.y, true)
      await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: button.cdp, clickCount: count, modifiers: modifiers.mask })
      await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: button.cdp, clickCount: count, modifiers: modifiers.mask })
      if (count < clickCount) await new Promise<void>((resolve) => setTimeout(resolve, 55))
    }
    if (button.cdp === 'left') await this.pointer(tab, target.x, target.y, false)
    this.invalidateTabSnapshot(tab)
    return { ok: true, tabId: tab.id, x: Math.round(target.x), y: Math.round(target.y), clickCount, button: button.cdp }
  }

  private async drag(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (request.startRef !== undefined && typeof request.startRef !== 'number') throw new Error('startRef 必须是整数。')
    if (request.endRef !== undefined && typeof request.endRef !== 'number') throw new Error('endRef 必须是整数。')
    const path = request.path === undefined
      ? [
          targetFromRequest(tab, { ref: request.startRef, snapshotVersion: request.snapshotVersion, x: request.startX, y: request.startY }),
          targetFromRequest(tab, { ref: request.endRef, snapshotVersion: request.snapshotVersion, x: request.endX, y: request.endY }),
        ]
      : (() => {
          if (!Array.isArray(request.path) || request.path.length < 2 || request.path.length > 120) throw new Error('path 必须包含 2–120 个坐标点。')
          return request.path.map((point) => {
            if (point === null || typeof point !== 'object' || Array.isArray(point)) throw new Error('path 坐标格式无效。')
            const value = point as Record<string, unknown>
            return { x: finiteCoordinate(value.x, 'path.x'), y: finiteCoordinate(value.y, 'path.y') }
          })
        })()
    const start = path[0]!
    const end = path.at(-1)!
    const modifiers = inputModifierState(request.keypress)
    const durationMs = request.durationMs === undefined ? 450 : positiveInteger(request.durationMs, 'durationMs', 100, 2_000)
    if (!tab.view.getVisible()) {
      const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
        expression: `(() => {
          const path = ${JSON.stringify(path)}, start = path[0], end = path.at(-1), modifiers = ${JSON.stringify(modifiers)};
          const source = document.elementFromPoint(start.x, start.y);
          const target = document.elementFromPoint(end.x, end.y);
          if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) return false;
          const data = typeof DataTransfer === 'function' ? new DataTransfer() : undefined;
          const mouse = (element, type, point, buttons) => element.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: point.x, clientY: point.y, button: 0, buttons, ...modifiers }));
          mouse(source, 'mousedown', start, 1);
          if (typeof DragEvent === 'function') source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
          for (const point of path.slice(1)) mouse(document.elementFromPoint(point.x, point.y) || target, 'mousemove', point, 1);
          if (typeof DragEvent === 'function') {
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
            source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }));
          }
          mouse(target, 'mouseup', end, 0);
          return true;
        })()`,
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      if (response.result?.value !== true) throw new Error('拖拽起点或终点没有网页元素。')
      this.invalidateTabSnapshot(tab)
      return { ok: true, tabId: tab.id, start, end, durationMs, method: 'dom' }
    }
    const steps = Math.max(path.length - 1, Math.min(60, Math.round(durationMs / 40)))
    await this.pointer(tab, start.x, start.y, false)
    await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y })
    let pressed = false
    try {
      await this.pointer(tab, start.x, start.y, true)
      await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, modifiers: modifiers.mask })
      pressed = true
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps
        const segmentProgress = progress * (path.length - 1)
        const segment = Math.min(path.length - 2, Math.floor(segmentProgress))
        const local = segmentProgress - segment
        const from = path[segment]!, to = path[segment + 1]!
        const x = from.x + (to.x - from.x) * local
        const y = from.y + (to.y - from.y) * local
        await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers: modifiers.mask })
        await this.pointer(tab, x, y, true)
        if (step < steps) await new Promise<void>((resolve) => setTimeout(resolve, Math.round(durationMs / steps)))
      }
    } finally {
      if (pressed) await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1, modifiers: modifiers.mask }).catch(() => undefined)
      await this.pointer(tab, end.x, end.y, false)
    }
    this.invalidateTabSnapshot(tab)
    return {
      ok: true,
      tabId: tab.id,
      start: { x: Math.round(start.x), y: Math.round(start.y) },
      end: { x: Math.round(end.x), y: Math.round(end.y) },
      durationMs,
    }
  }

  private async typeText(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (typeof request.text !== 'string') throw new Error('text 是必填项。')
    if (request.ref !== undefined || request.x !== undefined || request.y !== undefined) await this.click(tab, request)
    if (!tab.view.getVisible()) {
      const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
        expression: `(() => {
          const element = document.activeElement;
          const text = ${JSON.stringify(request.text)}, clear = ${String(request.clear === true)};
          if (!(element instanceof HTMLElement)) return false;
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element instanceof HTMLInputElement && ['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(element.type)) return false;
            const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            const next = clear ? text : element.value.slice(0, element.selectionStart ?? element.value.length) + text + element.value.slice(element.selectionEnd ?? element.value.length);
            if (setter) setter.call(element, next); else element.value = next;
            element.setSelectionRange?.(next.length, next.length);
          } else if (element.isContentEditable) {
            element.textContent = clear ? text : (element.textContent || '') + text;
          } else return false;
          element.dispatchEvent(typeof InputEvent === 'function' ? new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }) : new Event('input', { bubbles: true }));
          if (clear) element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return true;
        })()`,
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      if (response.result?.value !== true) throw new Error('当前焦点元素不可输入文本。')
      this.invalidateTabSnapshot(tab)
      return { ok: true, tabId: tab.id, characters: request.text.length, method: 'dom' }
    }
    if (request.clear === true) {
      const modifier = process.platform === 'darwin' ? 4 : 2
      const key = process.platform === 'darwin' ? 'Meta' : 'Control'
      const code = process.platform === 'darwin' ? 'MetaLeft' : 'ControlLeft'
      await this.debuggerCommandFor(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: modifier })
      await this.debuggerCommandFor(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier })
      await this.debuggerCommandFor(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier })
      await this.debuggerCommandFor(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: modifier })
    }
    await this.debuggerCommandFor(tab, 'Input.insertText', { text: request.text })
    this.invalidateTabSnapshot(tab)
    return { ok: true, tabId: tab.id, characters: request.text.length }
  }

  private async scroll(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    const modifiers = inputModifierState(request.keypress)
    if (request.top !== undefined || request.left !== undefined) {
      const top = request.top === undefined ? undefined : finiteCoordinate(request.top, 'top')
      const left = request.left === undefined ? undefined : finiteCoordinate(request.left, 'left')
      const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
        expression: `(() => {
          scrollTo({
            top: ${top === undefined ? 'scrollY' : JSON.stringify(top)},
            left: ${left === undefined ? 'scrollX' : JSON.stringify(left)},
            behavior: 'instant',
          });
          return { top: scrollY, left: scrollX };
        })()`,
        returnByValue: true,
      }) as { result?: { value?: { top?: unknown; left?: unknown } } }
      this.invalidateTabSnapshot(tab)
      return {
        ok: true,
        tabId: tab.id,
        top: typeof response.result?.value?.top === 'number' ? response.result.value.top : top ?? 0,
        left: typeof response.result?.value?.left === 'number' ? response.result.value.left : left ?? 0,
      }
    }
    const x = request.x === undefined ? (tab.viewport?.width ?? BACKGROUND_VIEWPORT.width) / 2 : finiteCoordinate(request.x, 'x')
    const y = request.y === undefined ? (tab.viewport?.height ?? BACKGROUND_VIEWPORT.height) / 2 : finiteCoordinate(request.y, 'y')
    const deltaX = typeof request.deltaX === 'number' && Number.isFinite(request.deltaX) ? request.deltaX : 0
    const deltaY = typeof request.deltaY === 'number' && Number.isFinite(request.deltaY) ? request.deltaY : request.deltaX === undefined ? 560 : 0
    if (!tab.view.getVisible()) {
      const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
        expression: `(() => {
          const x = ${JSON.stringify(x)};
          const y = ${JSON.stringify(y)};
          const deltaX = ${JSON.stringify(deltaX)};
          const deltaY = ${JSON.stringify(deltaY)};
          const modifiers = ${JSON.stringify(modifiers)};
          let target = document.elementFromPoint(x, y);
          let scroller;
          while (target && target !== document.documentElement) {
            const style = getComputedStyle(target);
            const scrollsX = target.scrollWidth > target.clientWidth && /(auto|scroll|overlay)/.test(style.overflowX);
            const scrollsY = target.scrollHeight > target.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY);
            if (scrollsX || scrollsY) { scroller = target; break; }
            target = target.parentElement;
          }
          (target || document).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaX, deltaY, ...modifiers }));
          if (scroller) scroller.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
          else scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
          return {
            left: scroller ? scroller.scrollLeft : scrollX,
            top: scroller ? scroller.scrollTop : scrollY,
            target: scroller ? scroller.tagName.toLowerCase() : 'window',
          };
        })()`,
        returnByValue: true,
      }) as { result?: { value?: { left?: unknown; top?: unknown; target?: unknown } } }
      this.invalidateTabSnapshot(tab)
      return {
        ok: true,
        tabId: tab.id,
        deltaX,
        deltaY,
        left: response.result?.value?.left,
        top: response.result?.value?.top,
        target: response.result?.value?.target,
        method: 'dom',
      }
    }
    await this.pointer(tab, x, y, false)
    await this.debuggerCommandFor(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: modifiers.mask })
    this.invalidateTabSnapshot(tab)
    return { ok: true, tabId: tab.id, deltaX, deltaY }
  }

  private parseScreenshotRect(value: unknown, name: string): CssScreenshotRect {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 格式无效。`)
    const source = value as Record<string, unknown>
    const rect = {
      x: finiteCoordinate(source.x, `${name}.x`),
      y: finiteCoordinate(source.y, `${name}.y`),
      width: finiteCoordinate(source.width, `${name}.width`),
      height: finiteCoordinate(source.height, `${name}.height`),
    }
    if (rect.width <= 0 || rect.height <= 0) throw new Error(`${name} 的 width 和 height 必须大于 0。`)
    return rect
  }

  private async screenshotViewportMetrics(tab: BrowserTabRuntime): Promise<{
    width: number
    height: number
    scrollX: number
    scrollY: number
  }> {
    const metrics = await this.debuggerCommandFor(tab, 'Page.getLayoutMetrics') as {
      cssVisualViewport?: { pageX?: unknown; pageY?: unknown; clientWidth?: unknown; clientHeight?: unknown }
      cssLayoutViewport?: { pageX?: unknown; pageY?: unknown; clientWidth?: unknown; clientHeight?: unknown }
    }
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport
    if (viewport !== undefined
      && typeof viewport.clientWidth === 'number' && Number.isFinite(viewport.clientWidth) && viewport.clientWidth > 0
      && typeof viewport.clientHeight === 'number' && Number.isFinite(viewport.clientHeight) && viewport.clientHeight > 0) {
      return {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scrollX: typeof viewport.pageX === 'number' && Number.isFinite(viewport.pageX) ? viewport.pageX : 0,
        scrollY: typeof viewport.pageY === 'number' && Number.isFinite(viewport.pageY) ? viewport.pageY : 0,
      }
    }
    const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
      expression: '({ width: innerWidth, height: innerHeight, scrollX, scrollY })',
      returnByValue: true,
    }) as { result?: { value?: { width?: unknown; height?: unknown; scrollX?: unknown; scrollY?: unknown } } }
    const value = response.result?.value
    if (typeof value?.width !== 'number' || !Number.isFinite(value.width) || value.width <= 0
      || typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height <= 0) {
      throw new Error('无法读取当前网页视口尺寸。')
    }
    return {
      width: value.width,
      height: value.height,
      scrollX: typeof value.scrollX === 'number' && Number.isFinite(value.scrollX) ? value.scrollX : 0,
      scrollY: typeof value.scrollY === 'number' && Number.isFinite(value.scrollY) ? value.scrollY : 0,
    }
  }

  private async captureScreenshot(
    tab: BrowserTabRuntime,
    kind: 'viewport' | 'rect' | 'element',
    requestedRect?: CssScreenshotRect,
  ): Promise<Record<string, unknown>> {
    const viewport = await this.screenshotViewportMetrics(tab)
    const capture = await this.capturePageImage(tab).catch((error: unknown) => {
      throw new Error(`网页截图失败（capturePage）：${error instanceof Error ? error.message : String(error)}`)
    })
    let png: Buffer
    let size: Electron.Size
    let rect: CssScreenshotRect | undefined
    try {
      const captured = capture.image
      if (captured.isEmpty()) throw new Error('网页截图失败：当前视口没有可捕获的图像。')
      let image = captured
      if (requestedRect !== undefined) {
        const capturedSize = captured.getSize()
        const plan = cssRectToImageCrop(requestedRect, viewport, capturedSize)
        image = captured.crop({
          x: plan.crop.x,
          y: plan.crop.y,
          width: plan.crop.width,
          height: plan.crop.height,
        })
        rect = plan.rect
      }
      if (image.isEmpty()) throw new Error('网页截图失败：裁剪后的区域为空。')
      size = image.getSize()
      if (size.width <= 0 || size.height <= 0
        || size.width > MAX_BROWSER_SCREENSHOT_EDGE || size.height > MAX_BROWSER_SCREENSHOT_EDGE
        || size.width * size.height > MAX_BROWSER_SCREENSHOT_PIXELS) {
        throw new Error(`网页截图尺寸超过限制：${String(size.width)}×${String(size.height)}。`)
      }
      // Encode exactly once while the temporary compositor host is alive. The
      // resulting Buffer survives host teardown and is shared by cache + registry.
      try {
        png = image.toPNG()
      } catch (error) {
        throw new Error(`网页截图失败（toPNG）：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      capture.release()
    }
    const result = await this.screenshotStore.save(png, {
      width: size.width,
      height: size.height,
      sourceUrl: tab.view.webContents.getURL() || tab.url,
      capturedAt: new Date().toISOString(),
      kind,
      ...(rect === undefined ? {} : { rect }),
      scrollX: viewport.scrollX,
      scrollY: viewport.scrollY,
    })
    return { ok: true, tabId: tab.id, url: result.sourceUrl, ...result }
  }

  private async capturePageImage(tab: BrowserTabRuntime): Promise<{ image: NativeImage; release: () => void }> {
    const view = tab.view
    if (view.getVisible()) return { image: await view.webContents.capturePage(), release: () => {} }
    const originalHost = tab.hostWindow
    if (originalHost === undefined || originalHost.isDestroyed()) throw new Error('网页截图失败：标签页没有可用的宿主窗口。')
    const originalBounds = view.getBounds()
    const originalVisible = view.getVisible()
    const captureBounds = {
      x: 0,
      y: 0,
      width: Math.max(1, originalBounds.width),
      height: Math.max(1, originalBounds.height),
    }
    const captureWindow = new BrowserWindow(browserScreenshotCaptureWindowOptions(captureBounds))
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      view.setVisible(false)
      if (!captureWindow.isDestroyed()) captureWindow.hide()
      try { captureWindow.contentView.removeChildView(view) } catch {}
      if (!originalHost.isDestroyed() && !view.webContents.isDestroyed()) {
        originalHost.contentView.addChildView(view)
        tab.hostWindow = originalHost
        view.setBounds(originalBounds)
        view.setVisible(originalVisible)
      }
      if (!captureWindow.isDestroyed()) captureWindow.destroy()
    }
    try {
      originalHost.contentView.removeChildView(view)
      captureWindow.contentView.addChildView(view)
      tab.hostWindow = captureWindow
      view.setBounds(captureBounds)
      view.setVisible(true)
      // A genuinely hidden BrowserWindow has no active compositor surface on
      // macOS. Keep this host fully transparent and outside practical displays,
      // then show it without focus so Electron can paint the WebContentsView
      // without flashing the captured page in the native window layer.
      captureWindow.showInactive()
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      let timer: NodeJS.Timeout | undefined
      try {
        const image = await Promise.race([
          view.webContents.capturePage(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('网页截图失败：等待 Electron 捕获超时。')), 10_000)
          }),
        ])
        return { image, release }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    } catch (error) {
      release()
      throw error
    }
  }

  private async screenshot(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (request.fullPage !== undefined && typeof request.fullPage !== 'boolean') throw new Error('fullPage 必须是布尔值。')
    if (request.fullPage === true) throw new Error('内置浏览器截图仅支持当前视口；请使用 rect 截取当前视口内的局部区域。')
    if (request.rect !== undefined && request.clip !== undefined) throw new Error('rect 与兼容参数 clip 不能同时使用。')
    if (request.ref !== undefined && (request.rect !== undefined || request.clip !== undefined)) throw new Error('ref 与 rect/clip 不能同时使用。')
    if (request.ref !== undefined) {
      const target = targetFromRequest(tab, request)
      if (target.width === undefined || target.height === undefined) throw new Error('元素引用缺少区域信息，请重新获取 DOM 快照。')
      return await this.captureScreenshot(tab, 'element', {
        x: target.x - target.width / 2,
        y: target.y - target.height / 2,
        width: target.width,
        height: target.height,
      })
    }
    const rawRect = request.rect ?? request.clip
    if (rawRect !== undefined) return await this.captureScreenshot(tab, 'rect', this.parseScreenshotRect(rawRect, request.rect === undefined ? 'clip' : 'rect'))
    return await this.captureScreenshot(tab, 'viewport')
  }

  private async elementScreenshot(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (request.ref !== undefined) return await this.screenshot(tab, request)
    const target = targetFromRequest(tab, request)
    const response = await this.debuggerCommandFor(tab, 'Runtime.evaluate', {
      expression: `(() => {
        const element = document.elementFromPoint(${JSON.stringify(target.x)}, ${JSON.stringify(target.y)});
        if (!(element instanceof Element)) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      })()`,
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    const value = response.result?.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('指定坐标处没有可截图的元素。')
    return await this.captureScreenshot(tab, 'element', this.parseScreenshotRect(value, 'element'))
  }

  private async setViewport(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<Record<string, unknown>> {
    if (request.width === undefined && request.height === undefined) {
      delete tab.viewport
      tab.backgroundViewportActive = false
      const contents = tab.view.webContents
      if (contents.debugger.isAttached()) await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
      if (this.activeTabId === tab.id) await this.setDeviceViewport(null)
      return { ok: true, tabId: tab.id, viewport: null }
    }
    const width = positiveInteger(request.width, 'width', 240, 3840)
    const height = positiveInteger(request.height, 'height', 240, 2160)
    tab.viewport = { width, height }
    tab.backgroundViewportActive = false
    if (this.activeTabId === tab.id) await this.setDeviceViewport({ width, height })
    else await this.debuggerCommandFor(tab, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      scale: 1,
      screenWidth: width,
      screenHeight: height,
      dontSetVisibleSize: true,
    })
    return { ok: true, tabId: tab.id, viewport: { width, height } }
  }

  private async applyViewport(): Promise<void> {
    const viewport = this.viewport
    if (this.view === undefined) return
    const tab = this.activeTab()
    if (viewport === undefined) {
      const contents = this.view.webContents
      if (contents.debugger.isAttached()) await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
      if (tab !== undefined) tab.backgroundViewportActive = false
      return
    }
    if (tab !== undefined) tab.backgroundViewportActive = false
    const width = this.bounds?.width ?? viewport.width
    const height = this.bounds?.height ?? viewport.height
    const scale = Math.max(0.1, Math.min(1, width / viewport.width, height / viewport.height))
    await this.debuggerCommand('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      scale,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      dontSetVisibleSize: true,
    })
  }

  private scheduleViewportApply(): void {
    this.viewportApplyDirty = true
    if (this.viewportLayoutTimer !== undefined || this.viewportApplyRunning) return
    this.viewportLayoutTimer = setTimeout(() => {
      this.viewportLayoutTimer = undefined
      void this.flushViewportApply()
    }, 8)
  }

  private async flushViewportApply(): Promise<void> {
    if (this.viewportApplyRunning) return
    this.viewportApplyRunning = true
    try {
      while (this.viewportApplyDirty) {
        this.viewportApplyDirty = false
        await this.applyViewport()
      }
    } finally {
      this.viewportApplyRunning = false
      if (this.viewportApplyDirty) this.scheduleViewportApply()
    }
  }

  private async pointer(tab: BrowserTabRuntime, x: number, y: number, pressed: boolean): Promise<void> {
    const contents = tab.view.webContents
    if (contents === undefined || contents.isDestroyed()) return
    contents.send(POINTER_CHANNEL, { x, y, pressed, theme: this.theme })
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true })
    const temporary = `${path}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  private changed(): void {
    this.sendFloatingWindowState()
    this.menuController.sendState()
    this.emit('state', this.state)
  }
}
