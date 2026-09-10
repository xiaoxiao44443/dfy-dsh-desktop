import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { installWindowMenuDismissal } from '../src/main/window-menu-dismissal.js'

function fixture(platform: NodeJS.Platform) {
  const hooks = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
  const contents = {
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    executeJavaScript: vi.fn<(script: string) => Promise<unknown>>().mockResolvedValue(false),
  }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    webContents: contents,
    hookWindowMessage: vi.fn((message: number, callback: (wParam: Buffer, lParam: Buffer) => void) => hooks.set(message, callback)),
  })
  const dismiss = vi.fn()
  installWindowMenuDismissal(window as unknown as BrowserWindow, dismiss, platform)
  return { window, hooks, dismiss, contents }
}

describe('window title-bar menu dismissal', () => {
  it.each([0x00a1, 0x00a4, 0x00a7, 0x00ab])('observes Windows non-client mouse-down %# without replacing native handling', (message) => {
    const { hooks, dismiss } = fixture('win32')
    expect(hooks.size).toBe(5)
    expect(hooks.get(message)?.(Buffer.alloc(8), Buffer.alloc(8))).toBeUndefined()
    expect(dismiss).toHaveBeenCalledExactlyOnceWith()
    expect(hooks.has(0x0084)).toBe(false) // Never override WM_NCHITTEST.
  })

  it.each([0x0201, 0x0204, 0x0207, 0x020b])('checks renderer child button-down %# regardless of the high word', async (message) => {
    const { hooks, dismiss, contents } = fixture('win32')
    contents.executeJavaScript.mockResolvedValue(true)
    for (const byteLength of [4, 8]) {
      const wParam = Buffer.alloc(byteLength)
      wParam.writeUInt32LE(0xabcd0000 + message)
      expect(hooks.get(0x0210)?.(wParam, Buffer.alloc(byteLength))).toBeUndefined()
      await Promise.resolve()
    }
    expect(dismiss).toHaveBeenCalledTimes(2)
  })

  it.each([
    { regions: ['drag'], expected: true },
    { regions: ['none', 'drag'], expected: true },
    { regions: ['none', 'no-drag', 'drag'], expected: false },
    { regions: ['none', 'none'], expected: false },
  ])('checks the shell DOM before dismissing: $regions', async ({ regions, expected }) => {
    const { hooks, dismiss, contents } = fixture('win32')
    type Element = { region: string; parentElement: Element | null }
    const target = regions.reduceRight<Element | null>((parentElement, region) => ({ region, parentElement }), null)
    const elementFromPoint = vi.fn(() => target)
    contents.executeJavaScript.mockImplementation(async (script) => vm.runInNewContext(script, {
      window: { devicePixelRatio: 1.75 },
      document: { elementFromPoint },
      getComputedStyle: (element: Element) => ({ webkitAppRegion: element.region }),
    }))
    const wParam = Buffer.alloc(8)
    wParam.writeUInt32LE(0x0201)
    const lParam = Buffer.alloc(8)
    lParam.writeInt16LE(420, 0)
    lParam.writeInt16LE(98, 2)
    hooks.get(0x0210)!(wParam, lParam)
    await Promise.resolve()
    expect(elementFromPoint).toHaveBeenCalledExactlyOnceWith(240, 56)
    expect(dismiss).toHaveBeenCalledTimes(expected ? 1 : 0)
  })

  it.each(['window-destroyed', 'contents-destroyed', 'loading', 'rejected', 'thrown'] as const)('ignores unavailable shell: %s', async (state) => {
    const { window, hooks, dismiss, contents } = fixture('win32')
    if (state === 'window-destroyed') window.isDestroyed.mockReturnValue(true)
    if (state === 'contents-destroyed') contents.isDestroyed.mockReturnValue(true)
    if (state === 'loading') contents.isLoadingMainFrame.mockReturnValue(true)
    if (state === 'rejected') contents.executeJavaScript.mockRejectedValue(new Error('Context destroyed'))
    if (state === 'thrown') contents.executeJavaScript.mockImplementation(() => { throw new Error('Contents destroyed') })
    const wParam = Buffer.alloc(8)
    wParam.writeUInt32LE(0x0201)
    hooks.get(0x0210)!(wParam, Buffer.alloc(8))
    await Promise.resolve()
    expect(dismiss).not.toHaveBeenCalled()
    if (!['rejected', 'thrown'].includes(state)) expect(contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it.each(['new-press', 'window-destroyed', 'contents-destroyed', 'loading'] as const)('ignores a pending title-bar result after %s', async (state) => {
    const { window, hooks, dismiss, contents } = fixture('win32')
    let resolve!: (value: unknown) => void
    contents.executeJavaScript.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const wParam = Buffer.alloc(8)
    wParam.writeUInt32LE(0x0201)
    hooks.get(0x0210)!(wParam, Buffer.alloc(8))
    if (state === 'new-press') hooks.get(0x0210)!(wParam, Buffer.alloc(8))
    if (state === 'window-destroyed') window.isDestroyed.mockReturnValue(true)
    if (state === 'contents-destroyed') contents.isDestroyed.mockReturnValue(true)
    if (state === 'loading') contents.isLoadingMainFrame.mockReturnValue(true)
    resolve(true)
    await Promise.resolve()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('ignores child creation, destruction, movement, release and double-click notifications', () => {
    const { hooks, dismiss, contents } = fixture('win32')
    for (const message of [0x0001, 0x0002, 0x0200, 0x0202, 0x0203, 0x0205, 0x0206, 0x0208, 0x0209, 0x020c, 0x020d]) {
      const wParam = Buffer.alloc(8)
      wParam.writeUInt32LE(0xabcd0000 + message)
      hooks.get(0x0210)?.(wParam, Buffer.alloc(8))
    }
    expect(dismiss).not.toHaveBeenCalled()
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it.each(['win32', 'darwin', 'linux'] as const)('dismisses on native window interactions on %s without cancelling them', (platform) => {
    const { window, dismiss } = fixture(platform)
    for (const eventName of ['blur', 'will-move', 'will-resize', 'system-context-menu']) {
      const event = { preventDefault: vi.fn() }
      window.emit(eventName, event)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(dismiss).toHaveBeenCalledTimes(4)
    if (platform !== 'win32') expect(window.hookWindowMessage).not.toHaveBeenCalled()
  })

  it('keeps hooks scoped to their own window and ignores pointer movement', () => {
    const first = fixture('win32')
    const second = fixture('win32')
    expect(first.hooks.has(0x00a0)).toBe(false) // WM_NCMOUSEMOVE must not close menus.
    first.hooks.get(0x00a1)!(Buffer.alloc(8), Buffer.alloc(8))
    expect(first.dismiss).toHaveBeenCalledOnce()
    expect(second.dismiss).not.toHaveBeenCalled()
  })
})
