// Run with Electron after build:main. Uses the bundled upstream BrowserLogin and
// real iframe/WindowProxy navigation; replaces only the OS browser launch.
import { app, BrowserWindow, shell } from 'electron'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { installExternalWindowHandling } from '../../dist/main/external-windows.js'

const dataRoot = process.env.DFY_LOGIN_TEST_DATA
if (!dataRoot) throw new Error('DFY_LOGIN_TEST_DATA must point to an isolated test directory')
mkdirSync(dataRoot, { recursive: true })
const log = (value) => { appendFileSync(resolve(dataRoot, 'fixture.log'), `${value}\n`); console.log(value) }
log('Starting isolated Electron login fixture')
app.setPath('userData', resolve(dataRoot))
app.disableHardwareAcceleration()

const client = readFileSync(new URL('../../build/harness-runtime/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js', import.meta.url), 'utf8')
const start = client.indexOf('var BrowserLogin = class {')
const end = client.indexOf('\n\t\t//#endregion', start)
assert.ok(start >= 0 && end > start, 'Upstream BrowserLogin fixture needs updating')
const browserLogin = client.slice(start, end)
const opened = []
shell.openExternal = async (url) => { opened.push(url) }

let window
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>Isolated login fixture</title>Login fixture')
})
const waitFor = async (condition) => {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for login window lifecycle')
    await new Promise((done) => setTimeout(done, 20))
  }
}

async function main() {
  try {
    await app.whenReady()
    log('Electron ready')
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${server.address().port}`
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: resolve('dist/preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    const navigationRequests = []
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['https://accounts.example.test/*'] }, (details, callback) => {
      navigationRequests.push(details.url)
      callback({ cancel: true })
    })
    await window.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><iframe name="harness-frame" src="${origin}/"></iframe>`)}`)
    log('Harness iframe ready')
    const frame = window.webContents.mainFrame.framesInSubtree.find((entry) => entry.name === 'harness-frame')
    assert.ok(frame)
    await frame.executeJavaScript(`${browserLogin}; window.login = new BrowserLogin(url => url)`)

    // Reproduce the old desktop handler against the real upstream implementation.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    assert.equal(await frame.executeJavaScript('login.begin(); login.popup === null', true), true)
    log('Original blocked popup reproduced')

    installExternalWindowHandling(window, (url) => { try { return new URL(url).origin === origin } catch { return false } })
    assert.equal(await frame.executeJavaScript('login.begin(); login.popup !== null && !login.popup.closed', true), true)
    const popup = BrowserWindow.getAllWindows().find((entry) => entry !== window)
    assert.ok(popup)
    assert.equal(popup.isVisible(), false)
    assert.equal(popup.webContents.getLastWebPreferences().preload, undefined)
    assert.equal(await popup.webContents.executeJavaScript('typeof window.desktop'), 'undefined')
    log('Placeholder is hidden and has no desktop preload')
    assert.equal(await frame.executeJavaScript('login.popup.opener === null'), true)
    const authorizeUrl = 'https://accounts.example.test/authorize?state=a%2Bb&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback&theme=dark'
    await frame.executeJavaScript(`login.follow(${JSON.stringify({ attempt: { id: 'one', phase: 'pending', authorizeUrl } })})`)
    await waitFor(() => opened.length === 1 && popup.isDestroyed())
    assert.deepEqual(opened, [authorizeUrl])
    assert.deepEqual(navigationRequests, [])

    // A request that completes later still has a live WindowProxy after the click.
    await frame.executeJavaScript(`login.start(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return ${JSON.stringify({ attempt: { id: 'two', phase: 'pending', authorizeUrl } })};
    }, () => undefined)`, true)
    await waitFor(() => opened.length === 2 && BrowserWindow.getAllWindows().length === 1)
    assert.deepEqual(opened, [authorizeUrl, authorizeUrl])

    // Cancel before receiving a URL: upstream closes the unused placeholder.
    await frame.executeJavaScript('login.begin(); login.follow({attempt:{id:"cancel",phase:"cancelled"}})', true)
    await waitFor(() => BrowserWindow.getAllWindows().length === 1)
    assert.equal(opened.length, 2)

    // Unsupported destinations never reach the OS or a desktop browser window.
    await frame.executeJavaScript('login.begin(); login.follow({attempt:{id:"file",phase:"pending",authorizeUrl:"file:///C:/not-a-login.html"}})', true)
    // Chromium may reject a local-file navigation before will-navigate is emitted.
    for (const entry of BrowserWindow.getAllWindows()) if (entry !== window) assert.equal(entry.webContents.getURL(), 'about:blank')
    await frame.executeJavaScript('login.dispose()')
    await waitFor(() => BrowserWindow.getAllWindows().length === 1)
    assert.equal(opened.length, 2)

    await frame.executeJavaScript('login.begin()', true)
    assert.equal(BrowserWindow.getAllWindows().length, 2)
    window.destroy()
    await waitFor(() => BrowserWindow.getAllWindows().length === 0)
    log('PASS: original failure reproduced; hidden login relay, delayed URL, exact URL forwarding, no shell preload, no embedded request, cancellation and parent-close cleanup')
  } catch (error) {
    process.exitCode = 1
    log(String(error.stack ?? error))
    console.error(error)
  } finally {
    for (const entry of BrowserWindow.getAllWindows()) if (!entry.isDestroyed()) entry.destroy()
    await new Promise((done) => server.close(done))
    app.exit(process.exitCode ?? 0)
  }
}
void main()
