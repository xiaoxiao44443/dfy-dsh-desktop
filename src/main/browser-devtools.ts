import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import type { ColorTheme } from '../shared/contracts.js'
import { formatBrowserAddress } from '../shared/browser-address-display.js'

/** Own the DevTools host so its native window can share the application's icon. */
export class BrowserDevToolsController {
  private readonly windows = new Map<WebContents, BrowserWindow>()
  private readonly ready = new WeakSet<BrowserWindow>()
  private readonly themeUpdates = new WeakMap<BrowserWindow, Promise<void>>()
  private readonly closing = new WeakMap<WebContents, Promise<void>>()
  private theme: ColorTheme = 'light'

  setTheme(theme: ColorTheme): void {
    this.theme = theme
    for (const window of this.windows.values()) void this.applyTheme(window)
  }

  private applyTheme(window: BrowserWindow): Promise<void> {
    const update = (this.themeUpdates.get(window) ?? Promise.resolve()).then(async () => {
      if (window.isDestroyed() || !this.ready.has(window)) return
      window.setBackgroundColor(this.theme === 'dark' ? '#282828' : '#ffffff')
      // Use the bundled DevTools setting so its live theme listener updates all
      // panels without reloading the frontend or touching the inspected page.
      await window.webContents.executeJavaScript(`(async () => {
        const Common = await import('./core/common/common.js');
        Common.Settings.moduleSetting('ui-theme').set(${JSON.stringify(this.theme === 'dark' ? 'dark' : 'default')});
      })()`)
    }).catch((error: unknown) => {
      if (!window.isDestroyed()) console.error('[desktop] DevTools theme update failed', error)
    })
    this.themeUpdates.set(window, update)
    return update
  }

  private waitForFrontendDestruction(contents: WebContents, frontend: WebContents): Promise<void> {
    // BrowserWindow.closed precedes the frontend's native destruction. Wait for
    // all its destruction observers to finish before attaching a replacement.
    const closed = new Promise<void>((resolve) => {
      const finished = () => { setImmediate(resolve) }
      if (frontend.isDestroyed()) finished()
      else frontend.once('destroyed', finished)
    })
    this.closing.set(contents, closed)
    void closed.then(() => { if (this.closing.get(contents) === closed) this.closing.delete(contents) })
    return closed
  }

  async open(contents: WebContents): Promise<void> {
    const closing = this.closing.get(contents)
    if (closing !== undefined) await closing
    if (contents.isDestroyed()) return
    const existing = this.windows.get(contents)
    if (existing !== undefined && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    // A native DevTools frontend must be closed before replacing its host.
    if (contents.isDevToolsOpened()) {
      const frontend = contents.devToolsWebContents
      const closed = frontend === null ? undefined : this.waitForFrontendDestruction(contents, frontend)
      contents.closeDevTools()
      if (closed !== undefined) await closed
      if (contents.isDestroyed()) return
    }

    const title = () => `DevTools - ${formatBrowserAddress(contents.getURL(), { hideScheme: true }) || 'about:blank'}`
    const window = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: title(),
      backgroundColor: this.theme === 'dark' ? '#282828' : '#ffffff',
      icon: app.isPackaged
        ? join(process.resourcesPath, 'app-icon.png')
        : join(app.getAppPath(), 'app-icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false,
      },
    })
    window.setMenu(null)
    const frontend = window.webContents
    this.windows.set(contents, window)

    const updateTitle = () => {
      if (!contents.isDestroyed() && !window.isDestroyed()) window.setTitle(title())
    }
    const navigatedInPage = (_event: unknown, _url: string, isMainFrame: boolean) => {
      if (isMainFrame) updateTitle()
    }
    const opened = () => {
      if (contents.isDestroyed() || window.isDestroyed()) return
      this.ready.add(window)
      updateTitle()
      void this.applyTheme(window).then(() => {
        if (contents.isDestroyed() || window.isDestroyed()) return
        window.show()
        window.focus()
      })
    }
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      this.windows.delete(contents)
      contents.removeListener('did-navigate', updateTitle)
      contents.removeListener('did-navigate-in-page', navigatedInPage)
      contents.removeListener('devtools-opened', opened)
      contents.removeListener('devtools-closed', cleanup)
      contents.removeListener('destroyed', cleanup)
      void this.waitForFrontendDestruction(contents, frontend)
      if (!contents.isDestroyed()) contents.closeDevTools()
      if (!window.isDestroyed()) window.destroy()
    }
    // The DevTools document may replace its title as its frontend initializes.
    window.on('page-title-updated', (event) => { event.preventDefault(); updateTitle() })
    // Detach while the frontend still exists; destroying it first leaves the
    // inspected page holding a stale DevTools host when it is opened again.
    window.on('close', () => { if (!contents.isDestroyed()) contents.closeDevTools() })
    window.on('closed', cleanup)
    window.webContents.on('did-finish-load', () => { void this.applyTheme(window) })
    contents.on('did-navigate', updateTitle)
    contents.on('did-navigate-in-page', navigatedInPage)
    contents.on('devtools-opened', opened)
    contents.on('devtools-closed', cleanup)
    contents.once('destroyed', cleanup)
    try {
      contents.setDevToolsWebContents(window.webContents)
      contents.openDevTools({ mode: 'detach' })
    } catch (error) {
      cleanup()
      throw error
    }
  }
}
