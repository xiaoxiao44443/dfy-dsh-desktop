import type { DesktopContextMenuActionRequest, DesktopContextMenuRequest, DesktopPointerInput } from './context-menu.js'

export type HarnessLifecycle = 'starting' | 'ready' | 'stopped' | 'error'
export type ColorTheme = 'dark' | 'light'
export type DesktopPlatform = 'windows' | 'macos' | 'linux'

export type HarnessUpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error'

export interface HarnessReleaseVersion {
  version: string
  publishedAt?: string
  /** npm distribution channels currently pointing at this version. */
  distTags?: string[]
}

export type DevelopmentCliStatus =
  | 'enabled'
  | 'disabled'
  | 'broken'
  | 'conflict'
  | 'unavailable'
  | 'unsupported'
  | 'error'

export interface DevelopmentCliState {
  status: DevelopmentCliStatus
  changing: boolean
  commandPath: string
  message: string
}

export interface DevelopmentState {
  patchPath?: string
  dshVersion?: string
  pnpmVersion: string
  cli: DevelopmentCliState
  restarting: boolean
  commandRunning: boolean
  lastCommand?: string
  commandOutput?: string
  lastExitCode?: number
}

export interface DevelopmentPluginRequest {
  profile: string
  argumentsText: string
}

export type PluginSourceType = 'builtin' | 'local' | 'git' | 'npm' | 'workspace' | 'unknown'
export type PluginInstallStatus = 'ready' | 'missing'

export interface ManagedPluginEntry {
  name: string
  version?: string
  description?: string
  sourceType: PluginSourceType
  source: string
  active: boolean
  toggleable: boolean
  removable: boolean
  status: PluginInstallStatus
}

export interface PluginProfileInventory {
  name: string
  plugins: ManagedPluginEntry[]
  error?: string
}

export interface PluginInventory {
  profiles: PluginProfileInventory[]
  scannedAt: string
}

export interface PluginInstallRequest {
  profile: string
  source: string
}

export interface PluginRemoveRequest {
  profile: string
  packageName: string
}

export interface PluginUpdateRequest {
  profile: string
  packageName: string
}

export interface PluginActivationRequest {
  profile: string
  packageName: string
  active: boolean
}

export interface PluginMutationResult {
  inventory: PluginInventory
  command: string
  output: string
  exitCode: number
}

export interface PluginRecoveryEntry {
  entryId: string
  pluginName: string
}

export interface PluginInitializationFailure extends PluginRecoveryEntry {
  detail: string
  recoverable: boolean
}

export type BrowserAgentOpenMode = 'background' | 'visible'
export type BrowserDisplayMode = 'split' | 'drawer' | 'floating'
export type BrowserMenuKind = 'application' | 'display' | 'settings'
export type DesktopApplicationMenuAction = 'plugins' | 'development' | 'release-notes' | 'update'

export interface DesktopApplicationMenuState {
  appVersion: string
  harnessVersion?: string
  updateStatus: HarnessUpdateStatus
  updateVersion?: string
  updateLatestVersion?: string
  updateProgress?: number
  patchEnabled: boolean
}

export interface DesktopBrowserMenuAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopBrowserSettings {
  enabled: boolean
  agentOpenMode: BrowserAgentOpenMode
  displayMode: BrowserDisplayMode
}

export interface DesktopBrowserViewport {
  width: number
  height: number
  deviceScaleFactor?: number
}

export interface DesktopBrowserTabState {
  id: string
  title: string
  url: string
  faviconUrl?: string
  loading: boolean
  agentActive: boolean
  sessionBound: boolean
  snapshotVersion: number
}

export interface DesktopBrowserState {
  settings: DesktopBrowserSettings
  panelOpen: boolean
  loading: boolean
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number
  tabs: DesktopBrowserTabState[]
  activeTabId?: string
  viewport?: DesktopBrowserViewport
}

export interface DesktopBrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopBrowserShellSnapshot {
  dataUrl: string
  bounds: DesktopBrowserViewBounds
}

export interface DesktopBrowserHistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: string
}

export interface FloatingBrowserWindowState {
  loading: boolean
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  maximized: boolean
  displayMode: BrowserDisplayMode
  zoomFactor: number
  viewport: DesktopBrowserViewport | null
  viewBounds: DesktopBrowserViewBounds | null
  tabs: DesktopBrowserTabState[]
  activeTabId?: string
}

export interface FloatingBrowserWindowBridge {
  invoke<T = void>(action: string, value?: unknown): Promise<T>
  onState(listener: (state: FloatingBrowserWindowState) => void): () => void
}

export type BrowserMenuWindowKind = BrowserMenuKind | 'context'

export interface BrowserMenuWindowPayload {
  kind: BrowserMenuWindowKind
  renderToken?: number
  state: DesktopBrowserState
  history: DesktopBrowserHistoryEntry[]
  application?: DesktopApplicationMenuState
  context?: DesktopContextMenuRequest
}

export interface BrowserMenuWindowBridge {
  invoke<T = void>(action: string, value?: unknown): Promise<T>
  selectContextMenuItem(request: DesktopContextMenuActionRequest): Promise<void>
  dismissContextMenu(requestId: string, restoreFocus?: boolean): Promise<void>
  onState(listener: (payload: BrowserMenuWindowPayload) => void): () => void
}

export type DesktopBrowserNavigationAction = 'back' | 'forward' | 'reload' | 'stop'

export interface DesktopState {
  appVersion: string
  platform: DesktopPlatform
  theme: ColorTheme
  harnessVersion?: string
  harnessUrl?: string
  harnessLoadId: number
  harnessLifecycle: HarnessLifecycle
  harnessMessage?: string
  runtimePreparationProgress?: number
  pluginFailure?: PluginInitializationFailure
  disabledPlugins: PluginRecoveryEntry[]
  updateStatus: HarnessUpdateStatus
  updateVersion?: string
  updateLatestVersion?: string
  updateVersions?: HarnessReleaseVersion[]
  updateProgress?: number
  updateMessage?: string
  development: DevelopmentState
  browser: DesktopBrowserState
  isMaximized: boolean
}

export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'
export type TitleMenuAction = 'update' | 'open-changes'

export interface DesktopBridge {
  getState(): Promise<DesktopState>
  windowAction(action: WindowAction): Promise<void>
  reportHarnessFrameLoaded(url: string): Promise<void>
  titleMenuAction(action: TitleMenuAction): Promise<void>
  checkForHarnessUpdate(): Promise<void>
  installHarnessVersion(version: string): Promise<void>
  openHarnessRelease(version: string): Promise<void>
  restartToApplyUpdate(): Promise<void>
  chooseDevelopmentPatch(): Promise<void>
  clearDevelopmentPatch(): Promise<void>
  restartHarnessForDevelopment(): Promise<void>
  copyDevelopmentHarnessUrl(): Promise<void>
  openDevelopmentHarnessUrl(): Promise<void>
  setDevelopmentCliEnabled(enabled: boolean): Promise<void>
  recoverFailedPlugin(): Promise<void>
  restoreRecoveredPlugin(entryId: string): Promise<void>
  runDevelopmentPlugin(request: DevelopmentPluginRequest): Promise<void>
  getPluginInventory(): Promise<PluginInventory>
  chooseLocalPluginDirectory(): Promise<string | undefined>
  installPlugin(request: PluginInstallRequest): Promise<PluginMutationResult>
  updatePlugin(request: PluginUpdateRequest): Promise<PluginMutationResult>
  removePlugin(request: PluginRemoveRequest): Promise<PluginMutationResult>
  setPluginActive(request: PluginActivationRequest): Promise<PluginMutationResult>
  copyPluginText(text: string): Promise<void>
  openPluginDocumentation(): Promise<void>
  setBrowserPanelOpen(open: boolean): Promise<void>
  setBrowserDisplayMode(mode: BrowserDisplayMode): Promise<void>
  openBrowserMenu(kind: BrowserMenuKind, anchor: DesktopBrowserMenuAnchor): Promise<void>
  setBrowserZoomFactor(factor: number): Promise<void>
  setBrowserDeviceViewport(viewport: DesktopBrowserViewport | null): Promise<void>
  previewBrowserDeviceViewport(viewport: DesktopBrowserViewport): Promise<void>
  setBrowserViewBounds(bounds: DesktopBrowserViewBounds | null): Promise<void>
  refreshBrowserShellSnapshot(): Promise<DesktopBrowserShellSnapshot | undefined>
  setBrowserShellOverlay(bounds: DesktopBrowserViewBounds | null): Promise<DesktopBrowserShellSnapshot | undefined>
  commitBrowserShellOverlay(): Promise<void>
  navigateBrowser(value: string): Promise<void>
  browserNavigationAction(action: DesktopBrowserNavigationAction): Promise<void>
  createBrowserTab(): Promise<void>
  selectBrowserTab(tabId: string): Promise<void>
  closeBrowserTab(tabId: string): Promise<void>
  getBrowserHistory(): Promise<DesktopBrowserHistoryEntry[]>
  clearBrowserHistory(): Promise<void>
  clearBrowserData(): Promise<void>
  selectContextMenuItem(request: DesktopContextMenuActionRequest): Promise<void>
  dismissContextMenu(requestId: string, restoreFocus?: boolean): Promise<void>
  onState(listener: (state: DesktopState) => void): () => void
  onApplicationMenuAction(listener: (action: DesktopApplicationMenuAction) => void): () => void
  onContextMenu(listener: (request: DesktopContextMenuRequest) => void): () => void
  onPointerInput(listener: (input: DesktopPointerInput) => void): () => void
}
