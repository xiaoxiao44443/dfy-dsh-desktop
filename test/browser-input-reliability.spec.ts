import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { BROWSER_HIT_TARGET_HELPERS } from '../src/main/browser-hit-target.js'
import { PREPARE_BROWSER_INPUT, VERIFY_BROWSER_INPUT } from '../src/main/browser-input.js'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, WebContentsView: class {}, clipboard: {}, ipcMain: {}, nativeImage: {}, session: {}, shell: {} }))
import { DesktopBrowserService } from '../src/main/desktop-browser.js'

interface InputTransport {
  sendDebuggerCommand(contents: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown>
}

describe('browser input coordinate transport', () => {
  it('applies compositor scale once, leaves page zoom out of positions, and converts wheel CSS deltas', async () => {
    const service = new DesktopBrowserService('/unused') as unknown as InputTransport
    const sendCommand = vi.fn(async () => ({}))
    const contents = { debugger: { sendCommand }, getZoomFactor: () => 1.25 } as unknown as WebContents
    await service.sendDebuggerCommand(contents, 'Emulation.setDeviceMetricsOverride', { scale: 0.4 })
    await service.sendDebuggerCommand(contents, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 125, button: 'left' })
    expect(sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 50, button: 'left' })
    await service.sendDebuggerCommand(contents, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 125, deltaX: 20, deltaY: 80 })
    expect(sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 120, y: 50, deltaX: 10, deltaY: 40 })
    await service.sendDebuggerCommand(contents, 'Emulation.clearDeviceMetricsOverride')
    await service.sendDebuggerCommand(contents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 125 })
    expect(sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 125 })
  })

  it('does not record a device scale that Chromium rejected', async () => {
    const service = new DesktopBrowserService('/unused') as unknown as InputTransport
    const sendCommand = vi.fn(async (_method: string, _params?: unknown) => ({}))
    const contents = { debugger: { sendCommand }, getZoomFactor: () => 1 } as unknown as WebContents
    await service.sendDebuggerCommand(contents, 'Emulation.setDeviceMetricsOverride', { scale: 0.5 })
    sendCommand.mockRejectedValueOnce(new Error('target closed'))
    await expect(service.sendDebuggerCommand(contents, 'Emulation.setDeviceMetricsOverride', { scale: 0.25 })).rejects.toThrow('target closed')
    await service.sendDebuggerCommand(contents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 120 })
    expect(sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 60 })
  })
})

type Rect = { left: number; top: number; right: number; bottom: number }
function hitFixture(rect: Rect, options: { clip?: Rect; covered?: boolean; coverCenter?: boolean } = {}): unknown {
  const root = { host: null }
  const parent = options.clip === undefined ? null : {
    parentElement: null, getRootNode: () => root, getBoundingClientRect: () => options.clip,
    style: { overflowX: 'hidden', overflowY: 'hidden' },
  }
  const target = { parentElement: parent, getRootNode: () => root, getClientRects: () => [rect] }
  const coveringElement = { parentElement: null, getRootNode: () => root }
  return vm.runInNewContext(`(() => { ${BROWSER_HIT_TARGET_HELPERS}; return clickablePoint(target); })()`, {
    target, innerWidth: 600, innerHeight: 400, window: {}, getComputedStyle: (element: { style: unknown }) => element.style,
    document: { elementFromPoint: (x: number, y: number) => {
      if (options.covered || (options.coverCenter && x > 100 && x < 190 && y > 100 && y < 140)) return coveringElement
      return target
    } },
  })
}

describe('browser click hit testing', () => {
  it('rejects a nonzero visible box that is entirely outside the viewport', () => {
    expect(hitFixture({ left: 774, top: 18, right: 878, bottom: 56 })).toEqual({ inViewport: false, hitTarget: false })
  })

  it('chooses a point inside the visible portion instead of the offscreen center', () => {
    expect(hitFixture({ left: 500, top: 30, right: 1000, bottom: 70 })).toEqual({ x: 550, y: 50, inViewport: true, hitTarget: true })
  })

  it('accounts for clipping ancestors and covered targets', () => {
    expect(hitFixture({ left: 100, top: 100, right: 200, bottom: 150 }, { clip: { left: 190, top: 90, right: 210, bottom: 160 } }))
      .toEqual({ x: 195, y: 125, inViewport: true, hitTarget: true })
    expect(hitFixture({ left: 100, top: 100, right: 200, bottom: 150 }, { covered: true }))
      .toEqual({ inViewport: true, hitTarget: false })
  })

  it('can use an uncovered part of the target when its center is covered', () => {
    expect(hitFixture({ left: 100, top: 100, right: 200, bottom: 150 }, { coverCenter: true })).toMatchObject({ hitTarget: true })
  })

  it('lets browser hit testing accept a fixed descendant that escapes ancestor overflow', () => {
    expect(hitFixture({ left: 300, top: 200, right: 400, bottom: 240 }, { clip: { left: 0, top: 0, right: 100, bottom: 100 } }))
      .toEqual({ x: 350, y: 220, inViewport: true, hitTarget: true })
  })
})

describe('browser text input verification', () => {
  function inputFixture() {
    class Input {
      isConnected = true
      disabled = false
      readOnly = false
      type = 'text'
      value = 'before after'
      selectionStart = 7
      selectionEnd = 7
      ownerDocument = { activeElement: this }
      getAttribute = () => null
      select(): void { this.selectionStart = 0; this.selectionEnd = this.value.length }
    }
    const element = new Input()
    const realm = vm.createContext({ HTMLInputElement: Input, HTMLTextAreaElement: class {}, setTimeout })
    const prepare = vm.runInContext(`(${PREPARE_BROWSER_INPUT})`, realm) as (this: Input, text: string, clear: boolean) => { expected?: string; kind?: string; error?: string }
    const verify = vm.runInContext(`(${VERIFY_BROWSER_INPUT})`, realm) as (this: Input, expected: string, kind: string) => Promise<boolean>
    return { element, prepare, verify }
  }

  it('preserves an existing caret and prepares an empty fill as selection replacement', async () => {
    const { element, prepare, verify } = inputFixture()
    expect(prepare.call(element, 'new ', false)).toEqual({ expected: 'before new after', kind: 'value' })
    expect(prepare.call(element, '', true)).toEqual({ expected: '', kind: 'value' })
    expect(element.selectionStart).toBe(0)
    expect(element.selectionEnd).toBe(element.value.length)
    expect(await verify.call(element, '', 'value')).toBe(false)
    element.value = ''
    expect(await verify.call(element, '', 'value')).toBe(true)
  })

  it('rejects readonly or lost-focus targets and detects a framework resetting the value', async () => {
    const { element, prepare, verify } = inputFixture()
    element.readOnly = true
    expect(prepare.call(element, 'new', true).error).toContain('不可编辑')
    element.readOnly = false
    prepare.call(element, 'new', true)
    element.value = ''
    expect(await verify.call(element, 'new', 'value')).toBe(false)
    element.isConnected = false
    expect(prepare.call(element, 'new', true).error).toContain('失去焦点')
  })
})
