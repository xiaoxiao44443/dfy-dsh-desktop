import { contextBridge, ipcRenderer } from 'electron'
import type { FloatingBrowserWindowBridge, FloatingBrowserWindowState } from './shared/contracts.js'

const ACTION_CHANNEL = 'desktop-browser:floating-action'
const STATE_CHANNEL = 'desktop-browser:floating-state'

const bridge: FloatingBrowserWindowBridge = {
  onBrowserPageFocus(listener) {
    const handler = (): void => listener()
    ipcRenderer.on('desktop-browser:page-focus', handler)
    return () => ipcRenderer.off('desktop-browser:page-focus', handler)
  },
  invoke: async <T,>(action: string, value?: unknown): Promise<T> => {
    return await ipcRenderer.invoke(ACTION_CHANNEL, action, value) as T
  },
  onState: (listener: (state: FloatingBrowserWindowState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: FloatingBrowserWindowState): void => listener(state)
    ipcRenderer.on(STATE_CHANNEL, handler)
    return () => ipcRenderer.removeListener(STATE_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld('floatingBrowser', bridge)
