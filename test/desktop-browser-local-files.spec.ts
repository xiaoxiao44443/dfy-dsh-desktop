import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTabRuntime } from '../src/main/desktop-browser-types.js'

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events')
  class MockContents extends MockEventEmitter {
    url = ''
    title = ''
    childFrames: unknown[] = []
    readonly mainFrame: { url: string; parent: null; framesInSubtree: unknown[] }
    readonly navigationHistory = {
      clear: vi.fn(),
      canGoBack: () => false,
      canGoForward: () => false,
    }
    readonly session = { setPermissionRequestHandler: vi.fn(), on: vi.fn() }
    openWindow: ((details: { url: string; referrer: { url: string } }) => unknown) | undefined
    setWindowOpenHandler = vi.fn((handler: typeof this.openWindow) => { this.openWindow = handler })
    setZoomFactor = vi.fn()
    isDestroyed = () => false
    getURL = () => this.url
    getTitle = () => this.title
    close = vi.fn()
    loadURL = vi.fn(async (url: string) => { this.url = url })
    constructor() {
      super()
      const owner = this
      this.mainFrame = {
        get url(): string { return owner.url },
        parent: null,
        get framesInSubtree(): unknown[] { return [this, ...owner.childFrames] },
      }
    }
  }
  class MockView {
    readonly webContents = new MockContents()
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor(readonly options: unknown) {}
  }
  return {
    WebContentsView: MockView,
    BrowserWindow: class {},
    app: {},
    clipboard: {},
    ipcMain: {},
    nativeImage: {},
    session: {},
    shell: {},
  }
})

vi.mock('../src/main/desktop-browser-automation.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/desktop-browser-automation.js')>(),
  readNavigationState: vi.fn(async () => ({ url: '' })),
  waitForNavigationStability: vi.fn(async () => ({ status: 'success' })),
}))

// Image capture has its own DOM/frame tests; this fixture models navigation only.
vi.mock('../src/main/image-context.js', () => ({ installImageContextCapture: vi.fn() }))

import { DesktopBrowserService } from '../src/main/desktop-browser.js'
import { normalizeBrowserAddress, normalizeBrowserHistory } from '../src/main/desktop-browser-utils.js'
import { normalizeLocalHtmlUrl } from '../src/shared/browser-address.js'

interface MockBrowserContents extends EventEmitter {
  url: string
  title: string
  childFrames: unknown[]
  mainFrame: { url: string; parent: null; framesInSubtree: unknown[] }
  openWindow(details: { url: string; referrer: { url: string } }): unknown
  loadURL: ReturnType<typeof vi.fn>
}

interface BrowserTestAccess {
  window: unknown
  createTab(id: string): Promise<BrowserTabRuntime>
  navigateTab(tab: BrowserTabRuntime, url: string, allowSearch: boolean): Promise<unknown>
  openChildTab(parent: BrowserTabRuntime, url: string): Promise<void>
  recordHistory(tab: BrowserTabRuntime): Promise<void>
}

const temporaryDirectories: string[] = []
const browserServices: DesktopBrowserService[] = []

afterEach(async () => {
  for (const service of browserServices.splice(0)) service.detachWindow()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createBrowser(): Promise<{
  service: DesktopBrowserService
  access: BrowserTestAccess
  tab: BrowserTabRuntime
  contents: MockBrowserContents
  directory: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-browser-local-'))
  temporaryDirectories.push(directory)
  const service = new DesktopBrowserService(directory)
  browserServices.push(service)
  const access = service as unknown as BrowserTestAccess
  access.window = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
  const tab = await access.createTab('manual')
  return { service, access, tab, directory, contents: tab.view.webContents as unknown as MockBrowserContents }
}

describe('local HTML browser addresses', () => {
  it('encodes native absolute paths while preserving literal Chinese, spaces, hashes and percent signs', () => {
    const path = join(tmpdir(), '中文网页 #100%', '播放器 50%#1.HTML')
    const expected = pathToFileURL(path).href
    expect(normalizeBrowserAddress(path, false)).toBe(expected)
    expect(expected).toContain('%20%23100%25')
    expect(expected).toContain('%E4%B8%AD')
    expect(normalizeBrowserAddress(expected, false)).toBe(expected)
    expect(normalizeBrowserAddress(`${expected}?mode=loop#controls`, false)).toBe(`${expected}?mode=loop#controls`)
  })

  it.each(['html', 'htm', 'xhtml'])('opens local .%s pages as files instead of searches', (extension) => {
    const path = join(tmpdir(), `page.${extension}`)
    expect(normalizeBrowserAddress(path)).toBe(pathToFileURL(path).href)
  })

  it.each([
    'javascript:alert(1)', 'data:text/html,<h1>Hi</h1>', 'file:///tmp/secret.txt',
    'file:///tmp/index.html%2fsecret.txt', 'file:///tmp/index%ZZ.html',
    'file://server/share/index.html', '\\\\server\\share\\index.html',
    'file:////server/share/index.html', 'file://///server/share/index.html',
    'file:///%2fserver/share/index.html', 'file:///%2F%2Fserver/share/index.html',
    'file:///C:/folder%5Cindex.html', 'file:///%43%3A/folder%5cindex.html',
  ])('rejects unsupported address %s even in the address bar', (value) => {
    expect(() => normalizeBrowserAddress(value)).toThrow()
  })

  it('preserves a literal backslash in POSIX filenames without treating it as a separator', () => {
    const url = 'file:///Users/person/name%5Cwith-backslash.html'
    expect(normalizeLocalHtmlUrl(url)).toBe(url)
    expect(normalizeBrowserAddress(url, false)).toBe(url)
  })

  it('keeps supported local pages in history and filters non-page files', () => {
    const entry = { id: 'local', title: '播放器', visitedAt: '2026-09-09T00:00:00.000Z' }
    expect(normalizeBrowserHistory({ entries: [
      { ...entry, url: 'file:///tmp/player.html#controls' },
      { ...entry, url: 'file:///tmp/secret.txt' },
      { ...entry, url: 'javascript:alert(1)' },
    ] })).toEqual([{ ...entry, url: 'file:///tmp/player.html#controls' }])
  })
})

describe('local HTML browser navigation', () => {
  it('loads the original file URL and preserves its directory for relative assets', async () => {
    const { access, tab, contents } = await createBrowser()
    const file = join(tmpdir(), '播放器 #100%', 'index.html')
    await access.navigateTab(tab, file, false)
    const url = pathToFileURL(file).href
    expect(contents.loadURL).toHaveBeenLastCalledWith(url)
    expect(new URL('./assets/video.mp4', contents.url).href).toBe(pathToFileURL(join(tmpdir(), '播放器 #100%', 'assets', 'video.mp4')).href)
    expect((tab.view as unknown as { options: unknown }).options).toMatchObject({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
  })

  it('reports the local page and anchor in tab state and persisted history', async () => {
    const { access, service, tab, contents, directory } = await createBrowser()
    contents.url = 'file:///tmp/player.html#controls'
    contents.title = '视频播放器'
    contents.emit('did-navigate-in-page')
    expect(service.state.tabs[0]).toMatchObject({ url: contents.url, title: contents.title })
    await access.recordHistory(tab)
    const stored = JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'))
    expect(normalizeBrowserHistory(stored)).toEqual([expect.objectContaining({ url: contents.url, title: contents.title })])
  })

  it.each(['will-navigate', 'will-frame-navigate'])('allows local HTML navigation and rejects remote initiators in %s', async (eventName) => {
    const { contents } = await createBrowser()
    contents.url = 'file:///tmp/index.html'
    const event = (url: string, initiator: unknown = contents.mainFrame) => ({
      url, initiator, frame: contents.mainFrame, isMainFrame: true, isSameDocument: false, preventDefault: vi.fn(),
    })
    const local = event(new URL('./next.html#controls', contents.url).href)
    contents.emit(eventName, local, local.url)
    expect(local.preventDefault).not.toHaveBeenCalled()
    const remoteFrame = event('file:///tmp/next.html', { url: 'https://example.com/', parent: contents.mainFrame })
    contents.emit(eventName, remoteFrame, remoteFrame.url)
    expect(remoteFrame.preventDefault).toHaveBeenCalledOnce()
    const nonHtml = event('file:///tmp/secret.txt')
    contents.emit(eventName, nonHtml, nonHtml.url)
    expect(nonHtml.preventDefault).toHaveBeenCalledOnce()
    contents.url = 'https://example.com/'
    const fromRemote = event('file:///tmp/next.html')
    contents.emit(eventName, fromRemote, fromRemote.url)
    expect(fromRemote.preventDefault).toHaveBeenCalledOnce()
    const web = event('https://example.com/next')
    contents.emit(eventName, web, web.url)
    expect(web.preventDefault).not.toHaveBeenCalled()
  })

  it('blocks redirects to local files even when the original document was local', async () => {
    const { contents } = await createBrowser()
    contents.url = 'file:///tmp/index.html'
    const event = { url: 'file:///tmp/next.html', preventDefault: vi.fn() }
    contents.emit('will-redirect', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it.each(['about:srcdoc', 'data:text/html,<p>Embedded content</p>', 'blob:https://example.com/iframe-id'])(
    'preserves embedded %s documents while retaining the top-level address policy', async (url) => {
      const { contents } = await createBrowser()
      contents.url = 'https://example.com/'
      const frame = { url: 'about:blank', parent: contents.mainFrame }
      const embedded = { url, frame, initiator: contents.mainFrame, isMainFrame: false, preventDefault: vi.fn() }
      contents.emit('will-frame-navigate', embedded)
      expect(embedded.preventDefault).not.toHaveBeenCalled()

      const topLevel = { ...embedded, frame: contents.mainFrame, isMainFrame: true, preventDefault: vi.fn() }
      contents.emit('will-navigate', topLevel)
      expect(topLevel.preventDefault).toHaveBeenCalledOnce()
    },
  )

  it('blocks local-file subframes from a remote page and malformed network-share URLs from a local page', async () => {
    const { contents } = await createBrowser()
    for (const [source, url] of [
      ['https://example.com/', 'file:///C:/private/index.html'],
      ['file:///C:/pages/index.html', 'file:////server/share/index.html'],
    ]) {
      contents.url = source!
      const event = {
        url, frame: { url: 'about:blank', parent: contents.mainFrame },
        initiator: contents.mainFrame, isMainFrame: false, preventDefault: vi.fn(),
      }
      contents.emit('will-frame-navigate', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })

  it('opens local child tabs only from local pages and known local frame trees', async () => {
    const { access, tab, contents } = await createBrowser()
    const child = vi.spyOn(access, 'openChildTab').mockResolvedValue()
    const localUrl = 'file:///tmp/next.html'
    contents.url = 'file:///tmp/index.html'
    expect(contents.openWindow({ url: localUrl, referrer: { url: '' } })).toEqual({ action: 'deny' })
    expect(child).toHaveBeenCalledWith(tab, localUrl)
    child.mockClear()
    contents.childFrames = [{ url: 'https://example.com/', parent: contents.mainFrame }]
    contents.openWindow({ url: localUrl, referrer: { url: '' } })
    contents.openWindow({ url: localUrl, referrer: { url: 'https://example.com/' } })
    expect(child).not.toHaveBeenCalled()
    contents.url = 'https://example.com/'
    contents.openWindow({ url: localUrl, referrer: { url: '' } })
    expect(child).not.toHaveBeenCalled()
    contents.openWindow({ url: 'https://example.com/next', referrer: { url: '' } })
    expect(child).toHaveBeenCalledWith(tab, 'https://example.com/next')
  })
})
