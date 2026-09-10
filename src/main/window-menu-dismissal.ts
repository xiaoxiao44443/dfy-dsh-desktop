import type { BrowserWindow } from 'electron'

// CSS app-region:drag bypasses webContents mouse events on Windows.
const NON_CLIENT_MOUSE_DOWN = [0x00a1, 0x00a4, 0x00a7, 0x00ab] as const
const WM_PARENTNOTIFY = 0x0210
const CHILD_MOUSE_DOWN = new Set([0x0201, 0x0204, 0x0207, 0x020b])

export function installWindowMenuDismissal(
  window: BrowserWindow,
  dismiss: () => void,
  platform: NodeJS.Platform = process.platform,
): void {
  let pointerSequence = 0
  const dismissImmediately = () => {
    pointerSequence += 1
    dismiss()
  }
  window.on('blur', dismissImmediately)
  window.on('will-move', dismissImmediately)
  window.on('will-resize', dismissImmediately)
  window.on('system-context-menu', dismissImmediately)
  if (platform !== 'win32') return
  for (const message of NON_CLIENT_MOUSE_DOWN) {
    // Observe only: Windows must still handle dragging, double-click maximize,
    // resize borders and the native title-bar context menu normally.
    window.hookWindowMessage(message, dismissImmediately)
  }
  // Chromium's renderer child HWND can handle caption clicks without passing
  // WM_NC* through the top-level window. Windows still notifies its parent of
  // the press; only the low word identifies the event (the high word varies).
  window.hookWindowMessage(WM_PARENTNOTIFY, (wParam, lParam) => {
    if (!CHILD_MOUSE_DOWN.has(wParam.readUInt16LE(0))) return
    const sequence = ++pointerSequence
    if (window.isDestroyed()) return
    const contents = window.webContents
    if (contents.isDestroyed() || contents.isLoadingMainFrame()) return
    // All child presses produce this notification, including menu items.
    // Check only our trusted window shell and leave ordinary DOM input alone.
    // Parent-notify mouse coordinates are client pixels; DPR includes both the
    // Windows display scale and the shell's page zoom.
    const x = lParam.readInt16LE(0)
    const y = lParam.readInt16LE(2)
    const script = `(() => {
      const ratio = window.devicePixelRatio;
      if (!Number.isFinite(ratio) || ratio <= 0) return false;
      let target = document.elementFromPoint(${x} / ratio, ${y} / ratio);
      while (target) {
        const region = getComputedStyle(target).webkitAppRegion;
        if (region === 'no-drag') return false;
        if (region === 'drag') return true;
        target = target.parentElement;
      }
      return false;
    })()`
    void (async () => {
      try {
        const isTitlebar: unknown = await contents.executeJavaScript(script)
        if (isTitlebar === true && sequence === pointerSequence
          && !window.isDestroyed() && !contents.isDestroyed() && !contents.isLoadingMainFrame()) dismiss()
      } catch {
        // Closing or navigating the shell can invalidate its execution context.
      }
    })()
  })
}
