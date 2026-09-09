import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IMAGE_CONTEXT_KEY, installImageContextCapture } from '../src/main/image-context.js'

class Frame extends EventEmitter {
  destroyed = false
  detached = false
  framesInSubtree: Frame[] = [this]
  now = 1_000
  Image = class HTMLImageElement {}
  Canvas = class HTMLCanvasElement {}
  handlers: Array<(event: unknown) => void> = []
  window = {
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void, capture: boolean) => {
      expect(type).toBe('contextmenu')
      expect(capture).toBe(true)
      this.handlers.push(listener)
    }),
  }
  runtime = createContext({
    window: this.window,
    HTMLImageElement: this.Image,
    HTMLCanvasElement: this.Canvas,
    Date: { now: () => this.now },
  })
  executeJavaScript = vi.fn(async (script: string) => runInContext(script, this.runtime) as unknown)
  isDestroyed(): boolean { return this.destroyed }
  contextmenu(path: unknown[], isTrusted = true): void {
    for (const handler of this.handlers) handler({ isTrusted, composedPath: () => path })
  }
  capture(): { target: unknown; capturedAt: number } {
    return (this.window as unknown as Record<symbol, { target: unknown; capturedAt: number }>)[Symbol.for(IMAGE_CONTEXT_KEY)]!
  }
}

class Contents extends EventEmitter {
  destroyed = false
  mainFrame = new Frame()
  isDestroyed(): boolean { return this.destroyed }
  install(): void { installImageContextCapture(this as unknown as WebContents) }
}

describe('image context target capture', () => {
  it('captures the actual trusted image or canvas from a composed path', () => {
    const contents = new Contents()
    contents.install()
    const frame = contents.mainFrame
    const image = new frame.Image()
    frame.contextmenu([image, { tagName: 'DIV' }, frame.window])
    expect(frame.capture()).toEqual({ target: image, capturedAt: 1_000 })
    const canvas = new frame.Canvas()
    frame.now = 2_000
    frame.contextmenu([canvas, { shadowRoot: true }, frame.window])
    expect(frame.capture()).toEqual({ target: canvas, capturedAt: 2_000 })
    expect(Object.getOwnPropertyDescriptor(frame.window, Symbol.for(IMAGE_CONTEXT_KEY)))
      .toMatchObject({ enumerable: false, configurable: false, set: undefined })
    expect(Object.isFrozen(frame.capture())).toBe(true)
  })

  it('ignores synthetic events and clears a previous image on a trusted non-image click', () => {
    const contents = new Contents()
    contents.install()
    const frame = contents.mainFrame
    const image = new frame.Image()
    frame.contextmenu([image], false)
    expect(frame.capture()).toEqual({ target: null, capturedAt: 0 })
    frame.contextmenu([image])
    frame.now = 2_000
    frame.contextmenu([new frame.Canvas()], false)
    expect(frame.capture()).toEqual({ target: image, capturedAt: 1_000 })
    frame.contextmenu([{ tagName: 'IMG' }, frame.window])
    expect(frame.capture()).toEqual({ target: null, capturedAt: 2_000 })
  })

  it('installs in existing and newly created frames and keeps their targets separate', () => {
    const contents = new Contents()
    const existing = new Frame()
    contents.mainFrame.framesInSubtree.push(existing)
    contents.install()
    const later = new Frame()
    contents.emit('frame-created', {}, { frame: later })
    const image = new existing.Image()
    existing.contextmenu([image])
    const canvas = new later.Canvas()
    later.contextmenu([canvas])
    expect(existing.capture().target).toBe(image)
    expect(later.capture().target).toBe(canvas)
    expect(contents.mainFrame.capture().target).toBeNull()
    // Another frame's class cannot masquerade as a local DOM element.
    later.contextmenu([image])
    expect(later.capture().target).toBeNull()
  })

  it('does not duplicate listeners or reset the captured target on reinjection', () => {
    const contents = new Contents()
    contents.install()
    contents.install()
    const frame = contents.mainFrame
    const image = new frame.Image()
    frame.contextmenu([image])
    frame.emit('dom-ready')
    contents.emit('frame-created', {}, { frame })
    expect(contents.listenerCount('frame-created')).toBe(1)
    expect(frame.listenerCount('dom-ready')).toBe(1)
    expect(frame.window.addEventListener).toHaveBeenCalledTimes(1)
    expect(frame.capture().target).toBe(image)
  })

  it('cleans detached frame listeners and removes native subscriptions on contents destruction', () => {
    const contents = new Contents()
    const oldFrame = new Frame()
    contents.mainFrame.framesInSubtree.push(oldFrame)
    contents.install()
    oldFrame.detached = true
    const newFrame = new Frame()
    contents.emit('frame-created', {}, { frame: newFrame })
    expect(oldFrame.listenerCount('dom-ready')).toBe(0)
    contents.destroyed = true
    contents.emit('destroyed')
    expect(contents.listenerCount('frame-created')).toBe(0)
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(contents.mainFrame.listenerCount('dom-ready')).toBe(0)
    expect(newFrame.listenerCount('dom-ready')).toBe(0)
    const calls = newFrame.executeJavaScript.mock.calls.length
    newFrame.emit('dom-ready')
    expect(newFrame.executeJavaScript).toHaveBeenCalledTimes(calls)
  })

  it('tolerates disappearing frames and does not attach to destroyed contents', async () => {
    const contents = new Contents()
    contents.mainFrame.executeJavaScript.mockRejectedValueOnce(new Error('frame navigated'))
    contents.install()
    await Promise.resolve()
    contents.mainFrame.emit('dom-ready')
    expect(contents.mainFrame.handlers).toHaveLength(1)
    const closed = new Contents()
    closed.destroyed = true
    closed.install()
    expect(closed.mainFrame.executeJavaScript).not.toHaveBeenCalled()
    expect(closed.eventNames()).toEqual([])
  })
})
