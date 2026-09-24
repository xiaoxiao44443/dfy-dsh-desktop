import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run in an isolated Electron application, never against the user's DSH profile.
async function main() {
  const [modulePath, root, iconsRoot, mode] = process.argv.slice(2)
  app.setPath('userData', root)
  app.setName('DFY tray lifecycle test')
  const { DesktopTray } = await import(pathToFileURL(modulePath).href)
  const settingsPath = join(root, 'tray-settings.json')
  writeFileSync(settingsPath, JSON.stringify({ quitOnClose: mode === 'close-to-quit' }))
  const events = []
  let tray
  let inClose = false
  app.on('before-quit', () => {
    events.push(inClose ? 'reentrant-before-quit' : 'before-quit')
    tray?.dispose()
  })
  app.on('window-all-closed', () => events.push('window-all-closed'))
  app.on('quit', () => console.log(JSON.stringify({ events, windows: BrowserWindow.getAllWindows().length })))
  const timedOut = () => {
    events.push('timeout')
    console.log(JSON.stringify({ events, windows: BrowserWindow.getAllWindows().length }))
    app.exit(91)
  }
  const startupTimeout = setTimeout(timedOut, 12_000)
  startupTimeout.unref()
  await app.whenReady()
  events.push('ready')
  const window = new BrowserWindow({ width: 320, height: 180, show: false })
  window.on('closed', () => events.push('closed'))
  tray = new DesktopTray({
    platform: process.platform, iconsRoot, version: 'test', settingsPath,
    showWindow: async () => window.show(), quit: () => app.quit(),
    onError: error => { console.error(error); app.exit(92) },
  })
  tray.start()
  tray.attachWindow(window)
  await window.loadURL('data:text/html,<title>DFY tray lifecycle test</title>')
  window.show()
  events.push('loaded')
  clearTimeout(startupTimeout)
  setTimeout(timedOut, 5_000).unref()
  inClose = true
  window.close()
  inClose = false
  if (mode === 'close-to-hide') {
    if (window.isDestroyed() || window.isVisible() || !tray.isActive) app.exit(93)
    events.push('hidden')
    window.show()
    if (!window.isVisible()) app.exit(94)
    events.push('restored')
    await new Promise(resolve => setImmediate(resolve))
    app.quit()
  }
}
void main().catch(error => { console.error(error); app.exit(95) })
