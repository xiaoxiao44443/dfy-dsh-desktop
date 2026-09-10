import { describe, expect, it, vi } from 'vitest'
import type { NativeImage, WebContentsView } from 'electron'
import type { BrowserTabRuntime } from '../src/main/desktop-browser-types.js'
import type { DesktopBrowserShellSnapshot } from '../src/shared/contracts.js'

vi.mock('electron', () => ({
  app: {}, BrowserWindow: class {}, WebContentsView: class {}, clipboard: {}, ipcMain: {}, nativeImage: {}, session: {}, shell: {},
}))

import { DesktopBrowserService } from '../src/main/desktop-browser.js'

interface Capture { image: NativeImage; release(): void }

interface TestAccess {
  activeTabId?: string
  zoomFactor: number
  panelOpen: boolean
  shellOverlayOpen: boolean
  shellOverlaySnapshot?: DesktopBrowserShellSnapshot
  bounds: { x: number; y: number; width: number; height: number }
  tabs: Map<string, BrowserTabRuntime>
  view: WebContentsView
  viewHostWindow: unknown
  window: unknown
  changed(): void
  setNativeVisible(visible: boolean): void
  ensureView(): Promise<WebContentsView>
  capturePageImage(tab: BrowserTabRuntime): Promise<Capture>
}

function fixture() {
  const service = new DesktopBrowserService('/unused-zoom-preview-test')
  const access = service as unknown as TestAccess
  let zoom = 1
  const setZoomFactor = vi.fn((value: number) => { zoom = value })
  const view = { webContents: { isDestroyed: () => false, getURL: () => 'https://example.com/', setZoomFactor } } as unknown as WebContentsView
  access.view = view
  access.window = { isDestroyed: () => false }
  access.viewHostWindow = access.window
  access.bounds = { x: 10, y: 50, width: 800, height: 600 }
  access.activeTabId = 'zoom-test'
  access.tabs.set('zoom-test', { id: 'zoom-test', url: 'https://example.com/', view } as BrowserTabRuntime)
  access.panelOpen = true
  access.shellOverlayOpen = true
  access.shellOverlaySnapshot = { dataUrl: 'data:image/jpeg;base64,old', bounds: { ...access.bounds } }
  vi.spyOn(access, 'changed').mockImplementation(() => {})
  vi.spyOn(access, 'ensureView').mockResolvedValue(view)
  const visibility = vi.spyOn(access, 'setNativeVisible').mockImplementation(() => {})
  function frame(): Capture {
    const capturedZoom = zoom
    return {
      image: {
        isEmpty: () => false,
        getSize: () => ({ width: 800, height: 600 }),
        toJPEG: () => Buffer.from(`zoom=${capturedZoom}`),
      } as unknown as NativeImage,
      release: vi.fn(),
    }
  }
  const capture = vi.spyOn(access, 'capturePageImage').mockImplementation(async () => frame())
  return { service, access, capture, visibility, frame, setZoomFactor }
}

describe('browser zoom preview while a menu is open', () => {
  it('ignores decrease, increase and reset requests on a blank new tab without changing the shared zoom', async () => {
    const { service, access, setZoomFactor } = fixture()
    access.tabs.get('zoom-test')!.url = ''
    access.zoomFactor = 0.7
    const snapshot = access.shellOverlaySnapshot
    for (const zoom of [0.6, 0.8, 1]) await service.setZoomFactor(zoom)
    expect(access.zoomFactor).toBe(0.7)
    expect(access.shellOverlaySnapshot).toBe(snapshot)
    expect(setZoomFactor).not.toHaveBeenCalled()
    expect(access.ensureView).not.toHaveBeenCalled()
    expect(access.changed).not.toHaveBeenCalled()
  })

  it('does not create a new view to handle zoom when no tab is active', async () => {
    const { service, access, setZoomFactor } = fixture()
    delete access.activeTabId
    await service.setZoomFactor(0.8)
    expect(access.zoomFactor).toBe(1)
    expect(setZoomFactor).not.toHaveBeenCalled()
    expect(access.ensureView).not.toHaveBeenCalled()
  })

  it('continues to allow zoom on a local HTML page', async () => {
    const { service, access, setZoomFactor } = fixture()
    access.tabs.get('zoom-test')!.url = 'file:///C:/pages/index.html'
    await service.setZoomFactor(0.8)
    expect(access.zoomFactor).toBe(0.8)
    expect(setZoomFactor).toHaveBeenCalledWith(0.8)
  })

  it('keeps the existing image until zoom invalidates it, then captures a fresh hidden-page preview', async () => {
    const { service, access, capture, visibility, frame, setZoomFactor } = fixture()
    expect(await service.refreshShellSnapshot()).toBe(access.shellOverlaySnapshot)
    expect(capture).not.toHaveBeenCalled()
    await service.setZoomFactor(0.7)
    const page = frame()
    capture.mockResolvedValueOnce(page)
    const snapshot = await service.refreshShellSnapshot()
    expect(setZoomFactor).toHaveBeenCalledWith(0.7)
    expect(snapshot?.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('zoom=0.7').toString('base64')}`)
    expect(access.shellOverlayOpen).toBe(true)
    expect(access.panelOpen).toBe(true)
    expect(page.release).toHaveBeenCalledOnce()
    expect(visibility).toHaveBeenLastCalledWith(false)
    expect(await service.refreshShellSnapshot()).toBe(snapshot)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('serializes captures during rapid zoom changes and discards the older frame', async () => {
    const { service, capture, frame } = fixture()
    await service.setZoomFactor(0.7)
    const oldPage = frame()
    let finishCapture!: (page: Capture) => void
    capture.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = resolve }))
    const first = service.refreshShellSnapshot()
    await service.setZoomFactor(0.8)
    const second = service.refreshShellSnapshot()
    expect(capture).toHaveBeenCalledOnce()
    finishCapture(oldPage)
    expect(await first).toBeUndefined()
    expect((await second)?.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('zoom=0.8').toString('base64')}`)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(oldPage.release).toHaveBeenCalledOnce()
  })

  it('restores the live page if the menu closes while its preview is being captured', async () => {
    const { service, access, capture, frame, visibility } = fixture()
    await service.setZoomFactor(0.7)
    const page = frame()
    let finishCapture!: (page: Capture) => void
    capture.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = resolve }))
    const refresh = service.refreshShellSnapshot()
    await service.setShellOverlay(null)
    finishCapture(page)
    await refresh
    expect(access.shellOverlayOpen).toBe(false)
    expect(page.release).toHaveBeenCalledOnce()
    expect(visibility).toHaveBeenLastCalledWith(true)
  })

  it('releases the capture host even when image encoding fails', async () => {
    const { service, capture, frame } = fixture()
    await service.setZoomFactor(0.7)
    const page = frame()
    page.image.toJPEG = () => { throw new Error('Encoding failed') }
    capture.mockResolvedValueOnce(page)
    await expect(service.refreshShellSnapshot()).rejects.toThrow('Encoding failed')
    expect(page.release).toHaveBeenCalledOnce()
    expect(await service.refreshShellSnapshot()).toBeDefined()
  })
})
