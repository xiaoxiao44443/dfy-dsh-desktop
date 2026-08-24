import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { app, BrowserWindow, type Rectangle, type WebContents } from 'electron'
import type {
  BrowserMenuKind,
  ColorTheme,
  DesktopApplicationMenuState,
  DesktopBrowserHistoryEntry,
  DesktopBrowserMenuAnchor,
  DesktopBrowserState,
} from '../shared/contracts.js'
import type { DesktopContextMenuRequest } from '../shared/context-menu.js'
import type { BrowserOverlayMenuKind } from './desktop-browser-types.js'

const BROWSER_MENU_PRELOAD = fileURLToPath(new URL('../browser-menu-preload.cjs', import.meta.url))
const MENU_STATE_CHANNEL = 'desktop-browser:menu-state'
const MENU_SHADOW_PADDING = 28
const MENU_OFFSCREEN_BOUNDS: Rectangle = Object.freeze({ x: -32_000, y: -32_000, width: 1, height: 1 })

interface DesktopBrowserMenuControllerOptions {
  getTheme(): ColorTheme
  getState(): DesktopBrowserState
  getHistory(): DesktopBrowserHistoryEntry[]
}

export interface ContextMenuReopenPoint {
  host: BrowserWindow
  hostX: number
  hostY: number
  requestId?: string
  insideHost: boolean
}

export class DesktopBrowserMenuController {
  private readonly windows = new Map<number, BrowserWindow>()
  private readonly windowReady = new Map<number, Promise<void>>()
  private view: BrowserWindow | undefined
  private hostWindow: BrowserWindow | undefined
  private kind: BrowserOverlayMenuKind | undefined
  private anchor: DesktopBrowserMenuAnchor | undefined
  private contextRequest: DesktopContextMenuRequest | undefined
  private applicationState: DesktopApplicationMenuState | undefined
  private targetBounds: Rectangle | undefined
  private presented = false
  private renderSequence = 0
  private readonly renderWaiters = new Map<number, () => void>()

  constructor(private readonly options: DesktopBrowserMenuControllerOptions) {}

  private createWindow(host: BrowserWindow): BrowserWindow {
    const menu = new BrowserWindow({
      parent: host,
      modal: false,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: BROWSER_MENU_PRELOAD,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
      },
    })
    if (process.platform === 'darwin') menu.excludedFromShownWindowsMenu = true
    menu.setMenuBarVisibility(false)
    menu.setFocusable(false)
    menu.on('closed', () => {
      if (this.windows.get(host.id) === menu) {
        this.windows.delete(host.id)
        this.windowReady.delete(host.id)
      }
      if (this.view !== menu) return
      this.resetActiveState()
    })
    return menu
  }

  async ensure(host: BrowserWindow): Promise<BrowserWindow> {
    const existing = this.windows.get(host.id)
    if (existing !== undefined && !existing.isDestroyed() && !existing.webContents.isDestroyed()) {
      await this.windowReady.get(host.id)
      return existing
    }
    const menu = this.createWindow(host)
    this.windows.set(host.id, menu)
    const rendererDevUrl = !app.isPackaged ? process.env.HARNESS_DESKTOP_RENDERER_URL : undefined
    const loading = rendererDevUrl !== undefined
      ? (() => {
          const url = new URL(rendererDevUrl)
          url.pathname = '/browser-menu.html'
          url.search = ''
          url.searchParams.set('theme', this.options.getTheme())
          return menu.loadURL(url.toString())
        })()
      : menu.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'browser-menu.html'), {
          query: { theme: this.options.getTheme() },
        })
    const ready = loading
      .then(() => {
        if (menu.isDestroyed()) return
        menu.setBounds(MENU_OFFSCREEN_BOUNDS)
        menu.showInactive()
      })
      .catch((error: unknown) => {
        if (!menu.isDestroyed()) menu.destroy()
        throw error
      })
    this.windowReady.set(host.id, ready)
    await ready
    return menu
  }

  destroy(): void {
    this.resetActiveState()
    for (const resolve of this.renderWaiters.values()) resolve()
    this.renderWaiters.clear()
    const menus = [...this.windows.values()]
    this.windows.clear()
    this.windowReady.clear()
    for (const menu of menus) {
      if (!menu.isDestroyed()) menu.destroy()
    }
  }

  async openPage(
    kind: BrowserMenuKind,
    host: BrowserWindow,
    anchor: DesktopBrowserMenuAnchor,
    applicationState?: DesktopApplicationMenuState,
  ): Promise<void> {
    this.close()
    const menu = await this.ensure(host)
    this.view = menu
    this.hostWindow = host
    this.kind = kind
    this.anchor = { ...anchor }
    this.applicationState = applicationState
    this.resize(kind === 'application' ? 326 : kind === 'display' ? 220 : 272, kind === 'application' ? 150 : kind === 'display' ? 116 : 210)
    await this.renderAndPresent(menu)
  }

  async openContext(host: BrowserWindow, request: DesktopContextMenuRequest): Promise<boolean> {
    this.close()
    const menu = await this.ensure(host)
    this.view = menu
    this.hostWindow = host
    this.kind = 'context'
    this.anchor = { x: request.x, y: request.y, width: 0, height: 0 }
    this.contextRequest = request
    this.applicationState = undefined
    const requestedHeight = request.items.reduce((height, entry) => height + (entry.kind === 'separator' ? 9 : 31), 8)
    this.resize(212, Math.max(40, requestedHeight))
    try {
      await this.renderAndPresent(menu)
      return true
    } catch {
      this.close()
      return false
    }
  }

  owns(contents: WebContents): boolean {
    return [...this.windows.values()].some((menu) => !menu.isDestroyed() && menu.webContents === contents)
  }

  isActiveSender(contents: WebContents): boolean {
    return this.view !== undefined && !this.view.isDestroyed() && this.view.webContents === contents
  }

  updateContext(request: DesktopContextMenuRequest): boolean {
    const menu = this.view
    const current = this.contextRequest
    if (
      this.kind !== 'context'
      || menu === undefined
      || menu.isDestroyed()
      || current === undefined
      || current.requestId !== request.requestId
    ) return false
    this.contextRequest = { ...current, items: request.items }
    const requestedHeight = request.items.reduce((height, entry) => height + (entry.kind === 'separator' ? 9 : 31), 8)
    this.resize(212, Math.max(40, requestedHeight))
    this.sendState()
    return true
  }

  close(): string | undefined {
    const menu = this.view
    const requestId = this.kind === 'context' ? this.contextRequest?.requestId : undefined
    this.resetActiveState()
    if (menu !== undefined && !menu.isDestroyed()) menu.setBounds(MENU_OFFSCREEN_BOUNDS)
    return requestId
  }

  resolveRendered(token: number): void {
    const resolve = this.renderWaiters.get(token)
    if (resolve === undefined) return
    this.renderWaiters.delete(token)
    resolve()
  }

  resize(requestedWidth: number, requestedHeight: number): void {
    const menu = this.view
    const host = this.hostWindow
    const anchor = this.anchor
    if (menu === undefined || menu.isDestroyed() || menu.webContents.isDestroyed() || host === undefined || host.isDestroyed() || anchor === undefined) return
    const contentBounds = host.getContentBounds()
    const margin = 8
    const cardWidth = Math.max(160, Math.min(Math.round(requestedWidth), Math.max(160, contentBounds.width - margin * 2)))
    const cardHeight = Math.max(40, Math.min(Math.round(requestedHeight), Math.max(40, contentBounds.height - margin * 2)))
    const width = cardWidth + MENU_SHADOW_PADDING * 2
    const height = cardHeight + MENU_SHADOW_PADDING * 2
    const isContext = this.kind === 'context'
    const preferredCardX = isContext ? Math.round(anchor.x) : Math.round(anchor.x + anchor.width - cardWidth)
    const belowCardY = isContext ? Math.round(anchor.y) : Math.round(anchor.y + anchor.height + 5)
    const aboveCardY = isContext ? Math.round(anchor.y - cardHeight) : Math.round(anchor.y - cardHeight - 5)
    const fitsBelow = belowCardY + cardHeight <= contentBounds.height - margin
    const fitsAbove = aboveCardY >= margin
    const preferredCardY = fitsBelow || !fitsAbove ? belowCardY : aboveCardY
    const cardX = Math.max(margin, Math.min(preferredCardX, contentBounds.width - cardWidth - margin))
    const cardY = Math.max(margin, Math.min(preferredCardY, contentBounds.height - cardHeight - margin))
    this.targetBounds = {
      x: contentBounds.x + cardX - MENU_SHADOW_PADDING,
      y: contentBounds.y + cardY - MENU_SHADOW_PADDING,
      width,
      height,
    }
    menu.setBounds(this.presented
      ? this.targetBounds
      : { x: MENU_OFFSCREEN_BOUNDS.x, y: MENU_OFFSCREEN_BOUNDS.y, width, height })
  }

  takeContextReopenPoint(localX: number, localY: number): ContextMenuReopenPoint | undefined {
    const menu = this.view
    const host = this.hostWindow
    if (menu === undefined || menu.isDestroyed() || host === undefined || host.isDestroyed() || !Number.isFinite(localX) || !Number.isFinite(localY)) return undefined
    const menuBounds = menu.getBounds()
    const hostBounds = host.getContentBounds()
    const hostX = Math.round(menuBounds.x - hostBounds.x + localX)
    const hostY = Math.round(menuBounds.y - hostBounds.y + localY)
    const requestId = this.close()
    return {
      host,
      hostX,
      hostY,
      ...(requestId === undefined ? {} : { requestId }),
      insideHost: hostX >= 0 && hostY >= 0 && hostX < hostBounds.width && hostY < hostBounds.height,
    }
  }

  sendState(renderToken?: number): void {
    const menu = this.view
    const kind = this.kind
    if (menu === undefined || menu.isDestroyed() || menu.webContents.isDestroyed() || menu.webContents.isLoadingMainFrame() || kind === undefined) return
    menu.webContents.send(MENU_STATE_CHANNEL, {
      kind,
      state: this.options.getState(),
      history: kind === 'settings' ? this.options.getHistory() : [],
      ...(renderToken === undefined ? {} : { renderToken }),
      ...(kind === 'application' && this.applicationState !== undefined ? { application: this.applicationState } : {}),
      ...(kind === 'context' && this.contextRequest !== undefined ? { context: this.contextRequest } : {}),
    })
  }

  applyTheme(theme: ColorTheme): void {
    for (const menu of this.windows.values()) {
      if (menu.isDestroyed() || menu.webContents.isDestroyed() || menu.webContents.isLoadingMainFrame()) continue
      void menu.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`).catch(() => undefined)
    }
  }

  private async renderAndPresent(menu: BrowserWindow): Promise<void> {
    const token = ++this.renderSequence
    const rendered = new Promise<void>((resolve) => this.renderWaiters.set(token, resolve))
    this.sendState(token)
    await Promise.race([rendered, new Promise<void>((resolve) => setTimeout(resolve, 120))])
    this.renderWaiters.delete(token)
    if (this.view !== menu || menu.isDestroyed() || this.targetBounds === undefined) return
    this.presented = true
    menu.setBounds(this.targetBounds)
    menu.showInactive()
  }

  private resetActiveState(): void {
    this.view = undefined
    this.hostWindow = undefined
    this.kind = undefined
    this.anchor = undefined
    this.contextRequest = undefined
    this.applicationState = undefined
    this.targetBounds = undefined
    this.presented = false
  }
}
