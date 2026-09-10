import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { BrowserMenuWindowPayload, DesktopBrowserState } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {} }))
import { DesktopBrowserMenuController } from '../src/main/desktop-browser-menu-controller.js'

function fixture() {
  const controller = new DesktopBrowserMenuController({
    getTheme: () => 'light', getState: () => ({} as DesktopBrowserState), getHistory: () => [],
  })
  const sent: BrowserMenuWindowPayload[] = []
  const menu = {
    isDestroyed: () => false, setBounds: vi.fn(), showInactive: vi.fn(),
    webContents: { isDestroyed: () => false, isLoadingMainFrame: () => false,
      send: (_channel: string, payload: BrowserMenuWindowPayload) => { sent.push(payload) },
    },
  }
  const host = { isDestroyed: () => false, getContentBounds: () => ({ x: 100, y: 100, width: 900, height: 700 }) } as BrowserWindow
  const ensure = vi.spyOn(controller, 'ensure').mockResolvedValue(menu as unknown as BrowserWindow)
  const request = { requestId: 'context-1', x: 20, y: 30, items: [{ kind: 'item' as const, id: 'select-all', label: '全选', enabled: true }] }
  return { controller, menu, host, ensure, sent, request }
}

describe('menu replacement across asynchronous window preparation', () => {
  it('does not reopen a context menu whose window became ready after a newer page menu', async () => {
    const { controller, menu, host, ensure, sent, request } = fixture()
    let ready!: (window: BrowserWindow) => void
    ensure.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve }))
    const old = controller.openContext(host, request)
    const current = controller.openPage('settings', host, { x: 50, y: 20, width: 30, height: 30 })
    await Promise.resolve()
    controller.resolveRendered(sent.at(-1)!.renderToken!)
    await current
    ready(menu as unknown as BrowserWindow)
    expect(await old).toBe(false)
    expect(sent.map((payload) => payload.kind)).toEqual(['settings'])
    expect(menu.showInactive).toHaveBeenCalledOnce()
  })

  it('does not present a newer menu early when the replaced menu acknowledges rendering', async () => {
    const { controller, menu, host, sent, request } = fixture()
    const old = controller.openPage('settings', host, { x: 50, y: 20, width: 30, height: 30 })
    await Promise.resolve()
    const oldToken = sent.at(-1)!.renderToken!
    const current = controller.openContext(host, request)
    await Promise.resolve()
    controller.resolveRendered(oldToken)
    await old
    expect(menu.showInactive).not.toHaveBeenCalled()
    controller.resolveRendered(sent.at(-1)!.renderToken!)
    expect(await current).toBe(true)
    expect(menu.showInactive).toHaveBeenCalledOnce()
  })

  it('keeps a dismissed menu closed when its window initialization finishes', async () => {
    const { controller, menu, host, ensure, sent, request } = fixture()
    let ready!: (window: BrowserWindow) => void
    ensure.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve }))
    const opening = controller.openContext(host, request)
    controller.close()
    ready(menu as unknown as BrowserWindow)
    expect(await opening).toBe(false)
    expect(sent).toHaveLength(0)
    expect(menu.showInactive).not.toHaveBeenCalled()
  })
})
