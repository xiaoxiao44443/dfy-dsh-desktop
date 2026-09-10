import { Menu, Tray, nativeImage } from 'electron'
import type { BrowserWindow, Event, MenuItemConstructorOptions } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface DesktopTrayOptions {
  platform: NodeJS.Platform
  iconsRoot: string
  version: string
  settingsPath: string
  showWindow: () => Promise<void>
  quit: () => void
  onError: (error: unknown) => void
}

/** Keep the main window and its conversation alive while it is in the tray. */
export class DesktopTray {
  private tray: Tray | undefined
  private window: BrowserWindow | undefined
  private quitOnClose = false

  constructor(private readonly options: DesktopTrayOptions) {}

  get isActive(): boolean {
    return this.tray !== undefined && !this.tray.isDestroyed()
  }

  start(): void {
    if (this.isActive || !['darwin', 'win32'].includes(this.options.platform)) return
    try {
      const settings: unknown = JSON.parse(readFileSync(this.options.settingsPath, 'utf8'))
      this.quitOnClose = settings !== null && typeof settings === 'object'
        && 'quitOnClose' in settings && settings.quitOnClose === true
    } catch { this.quitOnClose = false }
    const isMac = this.options.platform === 'darwin'
    const icon = isMac
      ? nativeImage.createFromPath(join(this.options.iconsRoot, 'trayTemplate.png'))
      : join(this.options.iconsRoot, 'tray.ico')
    if (typeof icon !== 'string') {
      if (icon.isEmpty()) throw new Error('无法加载 macOS 菜单栏图标。')
      icon.setTemplateImage(true)
    }
    const tray = new Tray(icon)
    try {
      tray.setToolTip(`DFY DSH Desktop ${this.options.version}`)
      const items: MenuItemConstructorOptions[] = [
        { id: 'show', label: '打开 DFY DSH Desktop', click: () => this.run(this.options.showWindow) },
        {
          id: 'quit-on-close', label: '关闭窗口时退出', type: 'checkbox', checked: this.quitOnClose,
          click: (item) => {
            try { this.saveQuitOnClose(item.checked) }
            catch (error) {
              item.checked = this.quitOnClose
              this.options.onError(error)
            }
          },
        },
        { type: 'separator' },
        { id: 'quit', label: '退出 DFY DSH Desktop', click: () => this.options.quit() },
      ]
      tray.setContextMenu(Menu.buildFromTemplate(items))
      // macOS opens its native menu on click. Windows uses left-click to restore
      // the main window and right-click for the context menu.
      if (!isMac) tray.on('click', () => this.run(this.options.showWindow))
      this.tray = tray
    } catch (error) {
      tray.destroy()
      throw error
    }
  }

  attachWindow(window: BrowserWindow): void {
    if (this.window === window) return
    this.detachWindow()
    this.window = window
    window.on('close', this.onClose)
    window.on('closed', this.onClosed)
    // Windows shutdown/logoff must be able to close the window normally.
    window.on('query-session-end', this.onSessionEnd)
  }

  dispose(): void {
    this.detachWindow()
    this.tray?.destroy()
    this.tray = undefined
  }

  private readonly onClose = (event: Event): void => {
    const window = this.window
    if (!this.isActive || event.defaultPrevented || window === undefined || window.isDestroyed()) return
    event.preventDefault()
    if (this.quitOnClose) this.options.quit()
    else window.hide()
  }

  private readonly onClosed = (): void => { this.detachWindow() }
  private readonly onSessionEnd = (): void => { this.dispose() }

  private detachWindow(): void {
    this.window?.off('close', this.onClose)
    this.window?.off('closed', this.onClosed)
    this.window?.off('query-session-end', this.onSessionEnd)
    this.window = undefined
  }

  private run(action: () => Promise<void>): void {
    void Promise.resolve().then(action).catch(this.options.onError)
  }

  private saveQuitOnClose(value: boolean): void {
    const path = this.options.settingsPath
    const temporaryPath = `${path}.${process.pid}.tmp`
    // This tiny write is synchronous so immediately quitting after toggling the
    // menu cannot lose the preference or race another click's atomic rename.
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temporaryPath, `${JSON.stringify({ quitOnClose: value })}\n`, 'utf8')
      renameSync(temporaryPath, path)
      this.quitOnClose = value
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }
}
