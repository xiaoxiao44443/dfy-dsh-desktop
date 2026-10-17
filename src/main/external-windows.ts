import { BrowserWindow, dialog, shell } from 'electron'

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Keep Harness login's preopened WindowProxy alive until its authorization URL arrives. */
export function installExternalWindowHandling(window: BrowserWindow, isHarnessUrl: (url: string) => boolean): void {
  const pending = new Set<BrowserWindow>()
  const openExternal = async (url: string): Promise<void> => {
    try {
      await shell.openExternal(url)
    } catch {
      if (!window.isDestroyed()) {
        await dialog.showMessageBox(window, {
          type: 'error',
          title: '无法打开默认浏览器',
          message: '请复制链接后在系统默认浏览器中手动打开。',
        }).catch(() => undefined)
      }
    }
  }

  window.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (isWebUrl(url)) {
      void openExternal(url)
      return { action: 'deny' }
    }
    if (url !== 'about:blank' || !isHarnessUrl(referrer.url)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { show: false, skipTaskbar: true, focusable: false },
      createWindow(options) {
        // Electron retains the native opener/WindowProxy relationship. This window
        // only holds about:blank; no authorization page is loaded in the desktop.
        const webPreferences = { ...options.webPreferences }
        delete webPreferences.preload
        const popup = new BrowserWindow({
          ...options,
          show: false,
          skipTaskbar: true,
          focusable: false,
          webPreferences,
        })
        pending.add(popup)
        let handled = false
        const close = (): void => { if (!popup.isDestroyed()) popup.destroy() }
        const timeout = setTimeout(close, 5 * 60_000)
        timeout.unref()
        popup.once('closed', () => {
          clearTimeout(timeout)
          pending.delete(popup)
        })
        const navigate = (event: Electron.Event, destination: string): void => {
          event.preventDefault()
          if (handled || destination === 'about:blank') return
          handled = true
          if (isWebUrl(destination)) void openExternal(destination).finally(close)
          else close()
        }
        popup.webContents.on('will-navigate', (event, destination) => navigate(event, destination))
        popup.webContents.on('will-redirect', (event, destination) => navigate(event, destination))
        popup.webContents.on('will-frame-navigate', (event) => {
          if (!event.isMainFrame) event.preventDefault()
        })
        popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        return popup.webContents
      },
    }
  })
  window.once('closed', () => {
    for (const popup of pending) if (!popup.isDestroyed()) popup.destroy()
  })
}
