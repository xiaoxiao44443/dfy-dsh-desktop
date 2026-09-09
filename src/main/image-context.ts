import type { Event, FrameCreatedDetails, WebContents, WebFrameMain } from 'electron'

export const IMAGE_CONTEXT_KEY = 'dfy-dsh-desktop.image-context'

const CAPTURE_SCRIPT = `(() => {
  const key = Symbol.for(${JSON.stringify(IMAGE_CONTEXT_KEY)})
  if (Object.prototype.hasOwnProperty.call(window, key)) return
  let current = Object.freeze({ target: null, capturedAt: 0 })
  Object.defineProperty(window, key, { get: () => current, enumerable: false })
  window.addEventListener('contextmenu', (event) => {
    if (event.isTrusted !== true) return
    const target = event.composedPath().find(element =>
      element instanceof HTMLImageElement || element instanceof HTMLCanvasElement)
    current = Object.freeze({ target: target || null, capturedAt: Date.now() })
  }, true)
})()`

const installed = new WeakSet<WebContents>()

/** Remember the actual clicked media in each frame; this is a DOM locator, not an authority grant. */
export function installImageContextCapture(contents: WebContents): void {
  if (contents.isDestroyed() || installed.has(contents)) return
  installed.add(contents)
  const listeners = new Map<WebFrameMain, () => void>()

  const prune = (): void => {
    for (const [frame, listener] of listeners) {
      if (!frame.isDestroyed() && !frame.detached) continue
      frame.off('dom-ready', listener)
      listeners.delete(frame)
    }
  }
  const watch = (frame: WebFrameMain): void => {
    prune()
    if (frame.isDestroyed() || frame.detached || listeners.has(frame)) return
    const inject = (): void => {
      prune()
      if (contents.isDestroyed() || frame.isDestroyed() || frame.detached) return
      // Navigation may destroy the document while execution is pending.
      try { void frame.executeJavaScript(CAPTURE_SCRIPT).catch(() => undefined) } catch { /* Frame detached before dispatch. */ }
    }
    listeners.set(frame, inject)
    frame.on('dom-ready', inject)
    inject()
  }
  const created = (_event: Event, details: FrameCreatedDetails): void => {
    if (details.frame !== null) watch(details.frame)
  }
  const destroyed = (): void => {
    contents.off('frame-created', created)
    for (const [frame, listener] of listeners) frame.off('dom-ready', listener)
    listeners.clear()
    installed.delete(contents)
  }
  contents.on('frame-created', created)
  contents.once('destroyed', destroyed)
  for (const frame of contents.mainFrame.framesInSubtree) watch(frame)
}
