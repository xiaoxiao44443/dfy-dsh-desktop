import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopBridge,
  BrowserDisplayMode,
  BrowserMenuKind,
  DesktopBrowserMenuAnchor,
  DesktopBrowserHistoryEntry,
  DesktopBrowserNavigationAction,
  DesktopBrowserShellSnapshot,
  DesktopBrowserViewBounds,
  DesktopBrowserViewport,
  DesktopApplicationMenuAction,
  DesktopState,
  DevelopmentPluginRequest,
  PluginActivationRequest,
  PluginInstallRequest,
  PluginInventory,
  PluginMutationResult,
  PluginRemoveRequest,
  PluginUpdateRequest,
  TitleMenuAction,
  WindowAction,
} from './shared/contracts.js'
import type { DesktopContextMenuActionRequest, DesktopContextMenuRequest, DesktopPointerInput } from './shared/context-menu.js'

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke('desktop:get-state') as Promise<DesktopState>,
  windowAction: (action: WindowAction) => ipcRenderer.invoke('desktop:window-action', action) as Promise<void>,
  reportHarnessFrameLoaded: (url: string) => ipcRenderer.invoke('desktop:harness-frame-loaded', url) as Promise<void>,
  titleMenuAction: (action: TitleMenuAction) => ipcRenderer.invoke('desktop:title-menu-action', action) as Promise<void>,
  checkForHarnessUpdate: () => ipcRenderer.invoke('desktop:check-update') as Promise<void>,
  installHarnessVersion: (version: string) => ipcRenderer.invoke('desktop:install-update-version', version) as Promise<void>,
  openHarnessRelease: (version: string) => ipcRenderer.invoke('desktop:open-harness-release', version) as Promise<void>,
  restartToApplyUpdate: () => ipcRenderer.invoke('desktop:restart-update') as Promise<void>,
  checkForDesktopUpdate: () => ipcRenderer.invoke('desktop:check-application-update') as Promise<void>,
  downloadDesktopUpdate: () => ipcRenderer.invoke('desktop:download-application-update') as Promise<void>,
  openDesktopRelease: () => ipcRenderer.invoke('desktop:open-application-release') as Promise<void>,
  installDesktopUpdate: () => ipcRenderer.invoke('desktop:install-application-update') as Promise<void>,
  chooseDevelopmentPatch: () => ipcRenderer.invoke('desktop:development-choose-patch') as Promise<void>,
  clearDevelopmentPatch: () => ipcRenderer.invoke('desktop:development-clear-patch') as Promise<void>,
  restartHarnessForDevelopment: () => ipcRenderer.invoke('desktop:development-restart') as Promise<void>,
  copyDevelopmentHarnessUrl: () => ipcRenderer.invoke('desktop:development-copy-harness-url') as Promise<void>,
  openDevelopmentHarnessUrl: () => ipcRenderer.invoke('desktop:development-open-harness-url') as Promise<void>,
  setDevelopmentCliEnabled: (enabled: boolean) => ipcRenderer.invoke('desktop:development-cli-enabled', enabled) as Promise<void>,
  recoverFailedPlugin: () => ipcRenderer.invoke('desktop:plugin-recovery-disable') as Promise<void>,
  restoreRecoveredPlugin: (entryId: string) => ipcRenderer.invoke('desktop:plugin-recovery-restore', entryId) as Promise<void>,
  runDevelopmentPlugin: (request: DevelopmentPluginRequest) => ipcRenderer.invoke('desktop:development-run-plugin', request) as Promise<void>,
  getPluginInventory: () => ipcRenderer.invoke('desktop:plugins-inventory') as Promise<PluginInventory>,
  chooseLocalPluginDirectory: () => ipcRenderer.invoke('desktop:plugins-choose-local') as Promise<string | undefined>,
  installPlugin: (request: PluginInstallRequest) => ipcRenderer.invoke('desktop:plugins-install', request) as Promise<PluginMutationResult>,
  updatePlugin: (request: PluginUpdateRequest) => ipcRenderer.invoke('desktop:plugins-update', request) as Promise<PluginMutationResult>,
  removePlugin: (request: PluginRemoveRequest) => ipcRenderer.invoke('desktop:plugins-remove', request) as Promise<PluginMutationResult>,
  setPluginActive: (request: PluginActivationRequest) => ipcRenderer.invoke('desktop:plugins-set-active', request) as Promise<PluginMutationResult>,
  copyPluginText: (text: string) => ipcRenderer.invoke('desktop:plugins-copy-text', text) as Promise<void>,
  openPluginDocumentation: () => ipcRenderer.invoke('desktop:plugins-open-documentation') as Promise<void>,
  setBrowserPanelOpen: (open: boolean) => ipcRenderer.invoke('desktop:browser-panel-open', open) as Promise<void>,
  setBrowserDisplayMode: (mode: BrowserDisplayMode) => ipcRenderer.invoke('desktop:browser-display-mode', mode) as Promise<void>,
  openBrowserMenu: (kind: BrowserMenuKind, anchor: DesktopBrowserMenuAnchor) => ipcRenderer.invoke('desktop:browser-open-menu', kind, anchor) as Promise<void>,
  setBrowserZoomFactor: (factor: number) => ipcRenderer.invoke('desktop:browser-zoom-factor', factor) as Promise<void>,
  setBrowserDeviceViewport: (viewport: DesktopBrowserViewport | null) => ipcRenderer.invoke('desktop:browser-device-viewport', viewport) as Promise<void>,
  previewBrowserDeviceViewport: (viewport: DesktopBrowserViewport) => ipcRenderer.invoke('desktop:browser-device-preview', viewport) as Promise<void>,
  setBrowserViewBounds: (bounds: DesktopBrowserViewBounds | null) => ipcRenderer.invoke('desktop:browser-view-bounds', bounds) as Promise<void>,
  refreshBrowserShellSnapshot: () => ipcRenderer.invoke('desktop:browser-shell-snapshot') as Promise<DesktopBrowserShellSnapshot | undefined>,
  setBrowserShellOverlay: (bounds: DesktopBrowserViewBounds | null) => ipcRenderer.invoke('desktop:browser-shell-overlay', bounds) as Promise<DesktopBrowserShellSnapshot | undefined>,
  commitBrowserShellOverlay: () => ipcRenderer.invoke('desktop:browser-shell-overlay-commit') as Promise<void>,
  navigateBrowser: (value: string) => ipcRenderer.invoke('desktop:browser-navigate', value) as Promise<void>,
  browserNavigationAction: (action: DesktopBrowserNavigationAction) => ipcRenderer.invoke('desktop:browser-navigation-action', action) as Promise<void>,
  createBrowserTab: () => ipcRenderer.invoke('desktop:browser-new-tab') as Promise<void>,
  selectBrowserTab: (tabId: string) => ipcRenderer.invoke('desktop:browser-select-tab', tabId) as Promise<void>,
  closeBrowserTab: (tabId: string) => ipcRenderer.invoke('desktop:browser-close-tab', tabId) as Promise<void>,
  getBrowserHistory: () => ipcRenderer.invoke('desktop:browser-history') as Promise<DesktopBrowserHistoryEntry[]>,
  clearBrowserHistory: () => ipcRenderer.invoke('desktop:browser-clear-history') as Promise<void>,
  clearBrowserData: () => ipcRenderer.invoke('desktop:browser-clear-data') as Promise<void>,
  selectContextMenuItem: (request: DesktopContextMenuActionRequest) => ipcRenderer.invoke('desktop:context-menu-select', request) as Promise<void>,
  dismissContextMenu: (requestId: string, restoreFocus = true) => ipcRenderer.invoke('desktop:context-menu-dismiss', requestId, restoreFocus) as Promise<void>,
  onState(listener: (state: DesktopState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState): void => listener(state)
    ipcRenderer.on('desktop:state', handler)
    return () => ipcRenderer.off('desktop:state', handler)
  },
  onApplicationMenuAction(listener: (action: DesktopApplicationMenuAction) => void) {
    const handler = (_event: Electron.IpcRendererEvent, action: DesktopApplicationMenuAction): void => listener(action)
    ipcRenderer.on('desktop:application-menu-action', handler)
    return () => ipcRenderer.off('desktop:application-menu-action', handler)
  },
  onContextMenu(listener: (request: DesktopContextMenuRequest) => void) {
    const handler = (_event: Electron.IpcRendererEvent, request: DesktopContextMenuRequest): void => listener(request)
    ipcRenderer.on('desktop:context-menu', handler)
    return () => ipcRenderer.off('desktop:context-menu', handler)
  },
  onPointerInput(listener: (input: DesktopPointerInput) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: DesktopPointerInput): void => listener(input)
    ipcRenderer.on('desktop:pointer-input', handler)
    return () => ipcRenderer.off('desktop:pointer-input', handler)
  },
}

contextBridge.exposeInMainWorld('desktop', bridge)
