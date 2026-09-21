import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLocatorResolution, BrowserTabRuntime, DesktopBrowserAgentRequest } from '../src/main/desktop-browser-types.js'
import { BrowserPointerMotion } from '../src/main/browser-pointer-motion.js'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, WebContentsView: class {}, clipboard: {}, ipcMain: {}, nativeImage: {}, session: {}, shell: {} }))
import { DesktopBrowserService } from '../src/main/desktop-browser.js'

afterEach(() => vi.useRealTimers())

describe('visual browser pointer motion', () => {
  it('starts at the first known position and eases to the exact destination within a bounded time', async () => {
    vi.useFakeTimers()
    const paint = vi.fn()
    const motion = new BrowserPointerMotion(paint)
    await motion.move({ x: 10, y: 20 }, () => true)
    expect(paint).toHaveBeenLastCalledWith({ x: 10, y: 20 }, false)
    paint.mockClear()
    const moving = motion.move({ x: 1010, y: 20 }, () => true)
    await vi.advanceTimersByTimeAsync(80)
    const early = paint.mock.lastCall![0].x as number
    expect(early).toBeGreaterThan(10)
    expect(early).toBeLessThan(10 + 1000 * 80 / 350)
    await vi.advanceTimersByTimeAsync(300)
    await moving
    expect(paint).toHaveBeenLastCalledWith({ x: 1010, y: 20 }, false)
    expect(paint.mock.calls.length).toBeGreaterThan(10)
    expect(paint.mock.calls.every(([point]) => point.y === 20 && point.x >= 10 && point.x <= 1010)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels on navigation reset and never paints old coordinates into the new document', async () => {
    vi.useFakeTimers()
    const paint = vi.fn()
    const motion = new BrowserPointerMotion(paint)
    motion.place({ x: 0, y: 0 }, false)
    const result = motion.move({ x: 500, y: 300 }, () => true).catch(error => error)
    await vi.advanceTimersByTimeAsync(50)
    motion.reset()
    const frames = paint.mock.calls.length
    await vi.runAllTimersAsync()
    expect(await result).toBeInstanceOf(Error)
    expect(paint).toHaveBeenCalledTimes(frames)
    await motion.move({ x: 30, y: 40 }, () => true)
    expect(paint).toHaveBeenLastCalledWith({ x: 30, y: 40 }, false)
  })

  it('lets direct drag/pressed frames supersede an animation without smoothing them', async () => {
    vi.useFakeTimers()
    const paint = vi.fn()
    const motion = new BrowserPointerMotion(paint)
    motion.place({ x: 0, y: 0 }, false)
    const result = motion.move({ x: 500, y: 0 }, () => true).catch(error => error)
    await vi.advanceTimersByTimeAsync(40)
    motion.place({ x: 20, y: 30 }, true)
    await vi.runAllTimersAsync()
    expect(await result).toBeInstanceOf(Error)
    expect(paint).toHaveBeenLastCalledWith({ x: 20, y: 30 }, true)
  })
})

interface PointerService {
  hover(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<unknown>
  click(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest, plan?: unknown[]): Promise<unknown>
  pointerTarget(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Promise<{ x: number; y: number }>
  debuggerCommandFor(tab: BrowserTabRuntime, method: string, params: Record<string, unknown>): Promise<unknown>
  resolveLocator(...args: unknown[]): Promise<BrowserLocatorResolution>
  invalidateTabSnapshot(tab: BrowserTabRuntime): void
}

function fixture() {
  const service = new DesktopBrowserService('/unused') as unknown as PointerService
  let visible = true
  const send = vi.fn()
  const tab = { navigationVersion: 0, view: { getVisible: () => visible, webContents: { isDestroyed: () => false, send } } } as unknown as BrowserTabRuntime
  const input = vi.spyOn(service, 'debuggerCommandFor').mockResolvedValue({})
  vi.spyOn(service, 'invalidateTabSnapshot').mockImplementation(() => undefined)
  vi.spyOn(service, 'pointerTarget').mockImplementation(async (_tab, request) => ({ x: Number(request.x), y: Number(request.y) }))
  return { service, tab, input, send, hide: () => { visible = false } }
}

describe('browser input and visual motion separation', () => {
  it('paints intermediate positions but sends only one endpoint move before clicking', async () => {
    vi.useFakeTimers()
    const { service, tab, input, send } = fixture()
    await service.hover(tab, { x: 10, y: 20 })
    input.mockClear()
    send.mockClear()
    const clicking = service.click(tab, { x: 800, y: 20 })
    await vi.advanceTimersByTimeAsync(100)
    expect(input).not.toHaveBeenCalled()
    expect(send.mock.calls.length).toBeGreaterThan(3)
    await vi.runAllTimersAsync()
    await clicking
    expect(input.mock.calls.map(([, method, params]) => [method, params.type, params.x])).toEqual([
      ['Input.dispatchMouseEvent', 'mouseMoved', 800],
      ['Input.dispatchMouseEvent', 'mousePressed', 800],
      ['Input.dispatchMouseEvent', 'mouseReleased', 800],
    ])
  })

  it('stops a pending click when the tab becomes hidden', async () => {
    vi.useFakeTimers()
    const { service, tab, input, hide } = fixture()
    await service.hover(tab, { x: 10, y: 20 })
    input.mockClear()
    const result = service.click(tab, { x: 800, y: 20 }).catch(error => error)
    await vi.advanceTimersByTimeAsync(50)
    hide()
    await vi.runAllTimersAsync()
    expect(await result).toBeInstanceOf(Error)
    expect(input).not.toHaveBeenCalled()
  })

  it('rechecks a locator after animation and follows a moved target before clicking', async () => {
    vi.useFakeTimers()
    const { service, tab, input } = fixture()
    await service.hover(tab, { x: 10, y: 20 })
    input.mockClear()
    vi.spyOn(service, 'resolveLocator').mockResolvedValue({ count: 1, visibleCount: 1, first: {
      x: 900, y: 30, width: 40, height: 30, visible: true, enabled: true, hitTarget: true,
    } } as BrowserLocatorResolution)
    const clicking = service.click(tab, { x: 800, y: 20 }, [])
    await vi.runAllTimersAsync()
    await clicking
    expect(input.mock.calls.map(([, , params]) => [params.type, params.x, params.y])).toEqual([
      ['mouseMoved', 900, 30], ['mousePressed', 900, 30], ['mouseReleased', 900, 30],
    ])
  })
})
