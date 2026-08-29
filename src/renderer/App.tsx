import { ArrowLeft, ArrowRight, Check, ChevronDown, Code2, Columns2, Copy, Download, FolderOpen, Globe2, History, Maximize2, Minimize2, Minus, MonitorSmartphone, MoreVertical, PanelRight, Plus, Puzzle, RotateCw, Search, Square, TabletSmartphone, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BrowserDisplayMode, DesktopApplicationMenuAction, DesktopBrowserHistoryEntry, DesktopBrowserShellSnapshot, DesktopBrowserViewport, DesktopState, DevelopmentState, ManagedPluginEntry, PluginInventory, PluginMutationResult, PluginRecoveryEntry, PluginSourceType } from '../shared/contracts.js'
import type { DesktopContextMenuRequest } from '../shared/context-menu.js'
import { AgentPointerIcon } from './AgentPointerIcon.js'
import { ContextMenu } from './ContextMenu.js'
import appIconUrl from '../../app-icon.png'
import titlebarIconUrl from '../../titlebar-icon.png'

const desktopApi = window.desktop
if (desktopApi === undefined) throw new Error('Desktop preload bridge is unavailable')
const BROWSER_DEVICE_FRAME_GUTTER = 12
const BROWSER_DEVICE_STAGE_GUTTER = 36
const BROWSER_DEVICE_TOTAL_GUTTER = (BROWSER_DEVICE_FRAME_GUTTER + BROWSER_DEVICE_STAGE_GUTTER) * 2

type DialogPhase = 'entering' | 'leaving' | undefined

interface BrowserShellSnapshotImage {
  dataUrl: string
  left: number
  top: number
  width: number
  height: number
}

function FloatingWindowIcon(): ReactNode {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4" /><rect width="10" height="7" x="12" y="13" rx="2" /></svg>
}

function BrowserPanelIcon({ open }: { open: boolean }): ReactNode {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />{open ? <path d="M14.5 4.5v15" strokeLinecap="square" /> : <path d="M17.25 8.5v7" />}</svg>
}

function usePresence(open: boolean, exitDuration = 130): { mounted: boolean; phase: DialogPhase } {
  const [mounted, setMounted] = useState(open)
  const [phase, setPhase] = useState<DialogPhase>(open ? 'entering' : undefined)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (open) {
      setMounted(true)
      setPhase('entering')
      timer = setTimeout(() => setPhase(undefined), 180)
    } else if (mounted) {
      setPhase('leaving')
      timer = setTimeout(() => {
        setMounted(false)
        setPhase(undefined)
      }, exitDuration)
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [exitDuration, mounted, open])

  return { mounted, phase }
}

function updatePresentation(state: DesktopState): {
  title: string
  detail: string
  dotClass: string
  disabled: boolean
} {
  const result = {
    title: 'Harness 更新',
    detail: '版本与下载',
    dotClass: 'item-dot',
    disabled: false,
  }
  if (state.updateStatus === 'ready') {
    return { ...result, detail: `待应用 ${state.updateVersion ?? ''}`.trim(), dotClass: 'item-dot active ready' }
  }
  if (state.updateStatus === 'available') {
    return { ...result, detail: `最新 ${state.updateLatestVersion ?? state.updateVersion ?? ''}`.trim(), dotClass: 'item-dot active available' }
  }
  if (state.updateStatus === 'checking') {
    return { ...result, detail: '正在检查…', dotClass: 'item-dot active busy' }
  }
  if (state.updateStatus === 'downloading') {
    return { ...result, detail: `下载 ${state.updateProgress ?? 0}%`, dotClass: 'item-dot active busy' }
  }
  if (state.updateStatus === 'error') {
    return { ...result, detail: '检查失败', dotClass: 'item-dot active error' }
  }
  if (state.updateStatus === 'current') {
    return { ...result, detail: '已是最新', dotClass: 'item-dot active ready' }
  }
  return result
}

function formatReleaseDate(value?: string): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

interface ModalProps {
  open: boolean
  className?: string
  labelledBy: string
  closeLabel: string
  onClose: () => void
  children: ReactNode
}

function Modal({ open, className = '', labelledBy, closeLabel, onClose, children }: ModalProps): ReactNode {
  const presence = usePresence(open)
  if (!presence.mounted) return null
  const phaseClass = presence.phase ?? ''
  return (
    <>
      <button className={`dialog-backdrop ${phaseClass}`} type="button" tabIndex={-1} aria-label={closeLabel} onPointerDown={onClose} />
      <section className={`app-dialog ${className} ${phaseClass}`.trim()} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </section>
    </>
  )
}

function HarnessUpdatePanel({ open, state, onClose }: { open: boolean; state: DesktopState; onClose: () => void }): ReactNode {
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const [versionsExpanded, setVersionsExpanded] = useState(false)
  const busy = state.updateStatus === 'checking' || state.updateStatus === 'downloading' || actionPending
  const versions = state.updateVersions ?? []
  const latestVersion = state.updateLatestVersion ?? (state.updateStatus === 'available' ? state.updateVersion : undefined)
  const selectedVersion = state.updateStatus === 'ready' || state.updateStatus === 'downloading' ? state.updateVersion : undefined
  const progress = Math.min(100, Math.max(0, state.updateProgress ?? 0))

  useEffect(() => {
    if (!open) {
      setVersionsExpanded(false)
      return
    }
    if (state.updateStatus === 'checking' || state.updateStatus === 'downloading') return
    setActionError(undefined)
    void desktopApi.checkForHarnessUpdate().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }, [open])

  const install = async (version: string): Promise<void> => {
    setActionPending(true)
    setActionError(undefined)
    try {
      await desktopApi.installHarnessVersion(version)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionPending(false)
    }
  }

  const refresh = async (): Promise<void> => {
    setActionPending(true)
    setActionError(undefined)
    try {
      await desktopApi.checkForHarnessUpdate()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionPending(false)
    }
  }

  const statusTitle = state.updateStatus === 'checking' ? '正在获取版本信息'
    : state.updateStatus === 'downloading' ? `正在准备 Harness ${state.updateVersion ?? ''}`.trim()
      : state.updateStatus === 'ready' ? `Harness ${state.updateVersion ?? ''} 已准备好`.trim()
        : state.updateStatus === 'available' ? '发现可用的新版本'
          : state.updateStatus === 'current' ? '当前已是最新版本'
            : state.updateStatus === 'error' ? '更新操作失败'
              : '尚未检查版本'

  return (
    <Modal open={open} className="update-dialog" labelledBy="harness-update-title" closeLabel="关闭 Harness 更新" onClose={onClose}>
      <header className="dialog-header">
        <div className="dialog-heading"><span className="update-dialog-icon" aria-hidden="true"><Download /></span><div><h2 id="harness-update-title">Harness 更新</h2><p>查看最新版本、下载状态并选择指定版本安装</p></div></div>
        <button className="dialog-close" type="button" aria-label="关闭 Harness 更新" title="关闭" onClick={onClose}><X /></button>
      </header>
      <div className="dialog-content update-content">
        <div className="update-version-summary">
          <section><span>当前版本</span><strong>{state.harnessVersion ?? '尚未启动'}</strong></section>
          <section><span>latest 版本</span><strong>{latestVersion ?? (state.updateStatus === 'checking' ? '检查中…' : '—')}</strong></section>
        </div>

        <section className={`update-status-card status-${state.updateStatus}`} aria-live="polite">
          <div className="update-status-main"><div className="update-status-copy"><strong>{statusTitle}</strong><span>{state.updateMessage ?? '版本信息来自 DeepSeek Harness npm 仓库'}</span></div>{state.updateStatus === 'available' && latestVersion !== undefined ? <div className="update-latest-actions"><button className="update-latest-link" type="button" onClick={() => void desktopApi.openHarnessRelease(latestVersion)}>更新内容</button><button className="update-latest-button" type="button" disabled={busy} onClick={() => void install(latestVersion)}>安装最新版本</button></div> : null}</div>
          {state.updateStatus === 'downloading' ? (
            <div className="update-progress-row"><div className="update-progress-track"><span style={{ width: `${progress}%` }} /></div><output>{progress}%</output></div>
          ) : null}
        </section>

        {actionError ? <p className="update-error" role="alert">{actionError}</p> : null}

        <section className="update-release-section">
          <div className="update-release-heading"><button className="update-release-toggle" type="button" aria-expanded={versionsExpanded} aria-controls="harness-recent-versions" onClick={() => setVersionsExpanded((expanded) => !expanded)}><span><strong>近期版本</strong><small>选择指定版本安装</small></span><ChevronDown aria-hidden="true" /></button><button className="plugin-icon-button" type="button" aria-label={state.updateStatus === 'checking' ? '正在刷新版本列表' : '刷新版本列表'} title={state.updateStatus === 'checking' ? '正在刷新…' : '刷新'} disabled={busy} onClick={() => void refresh()}><RotateCw className={state.updateStatus === 'checking' ? 'spinning' : ''} /></button></div>
          <div id="harness-recent-versions" className={`update-release-collapse${versionsExpanded ? ' expanded' : ''}`} aria-hidden={!versionsExpanded} inert={!versionsExpanded}>
            <div className="update-release-collapse-inner">
              <div className="update-release-list" aria-busy={busy}>
                {versions.length === 0 ? <div className="update-release-empty">{state.updateStatus === 'error' ? '暂时无法读取版本列表。' : '正在读取近期版本…'}</div> : versions.map((entry) => {
                  const current = entry.version === state.harnessVersion
                  const selected = entry.version === selectedVersion
                  const latest = entry.version === latestVersion
                  const publishedAt = formatReleaseDate(entry.publishedAt)
                  return (
                    <article className={`update-release-row${selected ? ' selected' : ''}`} key={entry.version}>
                      <div className="update-release-version"><strong>{entry.version}</strong><div className="update-release-meta"><span>{publishedAt ?? '发布时间未知'}</span><button className="update-release-link" type="button" onClick={() => void desktopApi.openHarnessRelease(entry.version)}>更新内容</button></div></div>
                      <div className="update-release-tags">{latest ? <span className="latest">latest</span> : null}{current ? <span>当前</span> : null}{selected && !current ? <span className="selected">待应用</span> : null}</div>
                      <div className="update-release-actions">
                        {current && !selected ? <button type="button" disabled>正在使用</button>
                          : selected && state.updateStatus === 'ready' ? <button className="primary" type="button" onClick={() => void desktopApi.restartToApplyUpdate()}>重启应用</button>
                            : <button type="button" disabled={busy} onClick={() => void install(entry.version)}>{selected && state.updateStatus === 'downloading' ? '处理中…' : '安装'}</button>}
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          </div>
        </section>
      </div>
      <footer className="dialog-actions"><button className="dialog-button secondary" type="button" onClick={onClose}>关闭</button>{state.updateStatus === 'ready' ? <button className="dialog-button primary" type="button" onClick={() => void desktopApi.restartToApplyUpdate()}>重启并应用 {state.updateVersion}</button> : <button className="dialog-button primary" type="button" disabled={busy} onClick={() => void refresh()}>{state.updateStatus === 'error' ? '重新检查' : '检查更新'}</button>}</footer>
    </Modal>
  )
}

function DevelopmentPanel({
  open,
  state,
  harnessUrl,
  disabledPlugins,
  onClose,
}: {
  open: boolean
  state: DevelopmentState
  harnessUrl?: string
  disabledPlugins: PluginRecoveryEntry[]
  onClose: () => void
}): ReactNode {
  const [actionError, setActionError] = useState<string>()
  const [cliError, setCliError] = useState<string>()
  const [harnessUrlCopied, setHarnessUrlCopied] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) closeButton.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => { setHarnessUrlCopied(false) }, [open, harnessUrl])

  const runAction = useCallback(async (action: () => Promise<void>, closeOnSuccess = false) => {
    setActionError(undefined)
    try {
      await action()
      if (closeOnSuccess) onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [onClose])

  const patchPath = state.patchPath ?? ''
  const cliRegistered = state.cli.status === 'enabled' || state.cli.status === 'broken'
  const cliUnavailable = state.cli.status === 'unavailable'
    || state.cli.status === 'unsupported'
    || state.cli.status === 'conflict'
    || state.cli.status === 'error'
  const cliStatusLabel = state.cli.changing
    ? '处理中…'
    : state.cli.status === 'enabled'
      ? '已启用'
      : state.cli.status === 'broken'
        ? '待修复'
        : state.cli.status === 'conflict'
          ? '有冲突'
          : state.cli.status === 'error'
            ? '异常'
          : state.cli.status === 'unsupported'
              ? '不支持'
              : state.cli.status === 'unavailable'
                ? '未就绪'
                : '启用'
  const cliMessage = cliError
    ?? (state.cli.status === 'conflict' || state.cli.status === 'error' ? state.cli.message : undefined)
  const toggleCli = async (): Promise<void> => {
    setCliError(undefined)
    try {
      await desktopApi.setDevelopmentCliEnabled(!cliRegistered)
    } catch (error) {
      setCliError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Modal open={open} className="development-dialog" labelledBy="development-title" closeLabel="关闭开发工具" onClose={onClose}>
      <header className="dialog-header">
        <div className="dialog-heading">
          <span className="development-icon" aria-hidden="true"><Code2 /></span>
          <div><h2 id="development-title">Harness 开发工具</h2><p>桌面操作与 Harness 内部共享同一套 dsh 和 pnpm</p></div>
        </div>
        <button ref={closeButton} className="dialog-close" type="button" aria-label="关闭开发工具" title="关闭" onClick={onClose}><X /></button>
      </header>
      <div className="dialog-content development-content">
        <div className="development-runtime-row">
          <div className="runtime-badges" aria-label="开发运行时版本">
            <span><strong>dsh</strong><span>{state.dshVersion ?? '尚未启动'}</span></span>
            <span><strong>pnpm</strong><span>{state.pnpmVersion}</span></span>
          </div>
          <div className="cli-toggle" title={state.cli.message}>
            <strong>终端 dsh</strong>
            <span className="cli-toggle-status">{cliStatusLabel}</span>
            <button
              className="cli-toggle-control"
              type="button"
              role="switch"
              aria-label="终端 dsh"
              aria-checked={cliRegistered}
              disabled={state.cli.changing || cliUnavailable}
              onClick={() => void toggleCli()}
            >
              <span className="cli-toggle-track" aria-hidden="true" />
            </button>
          </div>
        </div>
        {cliMessage ? <p className="cli-status-message">{cliMessage}</p> : null}
        {actionError ? <p className="cli-status-message">{actionError}</p> : null}

        <section className="development-section">
          <div className="section-heading"><div><h3>Harness 地址</h3><p>在系统浏览器中打开后，可使用开发者工具测试插件的移动端排版。</p></div></div>
          <div className="development-url-row">
            <div className={`path-value ${harnessUrl ? '' : 'empty'}`} title={harnessUrl}>{harnessUrl ?? '尚未启动'}</div>
            <button className="compact-button subtle" type="button" disabled={!harnessUrl} onClick={() => void runAction(async () => {
              await desktopApi.copyDevelopmentHarnessUrl()
              setHarnessUrlCopied(true)
            })}>{harnessUrlCopied ? '已复制' : '复制地址'}</button>
            <button className="compact-button" type="button" disabled={!harnessUrl} onClick={() => void runAction(() => desktopApi.openDevelopmentHarnessUrl())}>在浏览器中打开</button>
          </div>
        </section>

        <section className="development-section">
          <div className="section-heading"><div><h3>Patch 配置</h3><p>等价于 <code>dsh web --patch &lt;配置文件&gt;</code>，重启 Harness 后生效。</p></div></div>
          <div className="patch-picker">
            <div className={`path-value ${patchPath ? '' : 'empty'}`} title={patchPath}>{patchPath || '未选择 Patch 配置'}</div>
            <button className="compact-button" type="button" disabled={state.restarting} onClick={() => void runAction(() => desktopApi.chooseDevelopmentPatch())}>选择文件</button>
            <button className="compact-button subtle" type="button" disabled={!patchPath || state.restarting} onClick={() => void runAction(() => desktopApi.clearDevelopmentPatch())}>清除</button>
          </div>
          <div className="section-actions"><button className="dialog-button primary" type="button" disabled={state.restarting} onClick={() => void runAction(() => desktopApi.restartHarnessForDevelopment(), true)}>{state.restarting ? '正在重启…' : patchPath ? '重启并应用' : '重启 Harness'}</button></div>
        </section>

        {disabledPlugins.length > 0 ? (
          <section className="development-section">
            <div className="section-heading"><div><h3>插件恢复</h3><p>这些插件因初始化失败被桌面端临时禁用；修复后可重新启用并重启 Harness。</p></div></div>
            <div className="recovered-plugin-list">
              {disabledPlugins.map((plugin) => (
                <div className="recovered-plugin-row" key={plugin.entryId}>
                  <div><strong>{plugin.pluginName}</strong><code>{plugin.entryId}</code></div>
                  <button className="compact-button" type="button" disabled={state.restarting} onClick={() => void runAction(() => desktopApi.restoreRecoveredPlugin(plugin.entryId), true)}>重新启用并重启</button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <p className="development-note">插件的安装、来源与 Profile 归属已移到独立的“插件管理”。创造模式仍由 Harness 内置预设管理。</p>
      </div>
      <footer className="dialog-actions"><button className="dialog-button secondary" type="button" onClick={onClose}>完成</button></footer>
    </Modal>
  )
}

const PLUGIN_SOURCE_LABELS: Record<PluginSourceType, string> = {
  builtin: '内置',
  local: '本地',
  git: 'Git',
  npm: 'npm',
  workspace: '工作区',
  unknown: '其他',
}

function PluginManager({
  open,
  harnessReady,
  restarting,
  onClose,
}: {
  open: boolean
  harnessReady: boolean
  restarting: boolean
  onClose: () => void
}): ReactNode {
  const [inventory, setInventory] = useState<PluginInventory>()
  const [selectedProfile, setSelectedProfile] = useState('')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [operating, setOperating] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string>()
  const [lastResult, setLastResult] = useState<PluginMutationResult>()
  const [restartRequired, setRestartRequired] = useState(false)
  const [removeConfirmation, setRemoveConfirmation] = useState<string>()
  const closeButton = useRef<HTMLButtonElement>(null)

  const loadInventory = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const next = await desktopApi.getPluginInventory()
      setInventory(next)
      setSelectedProfile((current) => next.profiles.some((profile) => profile.name === current)
        ? current
        : next.profiles.find((profile) => profile.name === 'web')?.name ?? next.profiles[0]?.name ?? '')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    closeButton.current?.focus({ preventScroll: true })
    void loadInventory()
  }, [loadInventory, open])

  useEffect(() => setRemoveConfirmation(undefined), [selectedProfile])

  const activeProfile = inventory?.profiles.find((profile) => profile.name === selectedProfile)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const managedPlugins = (activeProfile?.plugins ?? []).filter((plugin) => plugin.sourceType !== 'builtin')
  const matchingPlugins = managedPlugins.filter((plugin) => normalizedQuery.length === 0
    || `${plugin.name}\n${plugin.description ?? ''}\n${plugin.source}`.toLocaleLowerCase().includes(normalizedQuery))
  const localCount = managedPlugins.filter((plugin) => plugin.sourceType === 'local').length
  const missingCount = managedPlugins.filter((plugin) => plugin.status === 'missing').length

  const runMutation = useCallback(async (action: () => Promise<PluginMutationResult>, showResult = true) => {
    setOperating(true)
    setError(undefined)
    if (showResult) setLastResult(undefined)
    try {
      const result = await action()
      setInventory(result.inventory)
      if (showResult) setLastResult(result)
      if (result.exitCode === 0) setRestartRequired(true)
      else setError(`命令执行失败（退出码 ${result.exitCode}）。`)
      return result.exitCode === 0
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
      return false
    } finally {
      setOperating(false)
    }
  }, [])

  const install = async (): Promise<void> => {
    const value = source.trim()
    if (selectedProfile.length === 0 || value.length === 0) return
    setInstalling(true)
    try {
      if (await runMutation(() => desktopApi.installPlugin({ profile: selectedProfile, source: value }))) setSource('')
    } finally {
      setInstalling(false)
    }
  }

  const chooseLocal = async (): Promise<void> => {
    setError(undefined)
    try {
      const path = await desktopApi.chooseLocalPluginDirectory()
      if (path !== undefined) setSource(path)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    }
  }

  const remove = async (packageName: string): Promise<void> => {
    if (await runMutation(() => desktopApi.removePlugin({ profile: selectedProfile, packageName }))) {
      setRemoveConfirmation(undefined)
    }
  }

  const setActive = async (packageName: string, active: boolean): Promise<void> => {
    await runMutation(() => desktopApi.setPluginActive({ profile: selectedProfile, packageName, active }), false)
  }

  const restart = async (): Promise<void> => {
    setOperating(true)
    setError(undefined)
    try {
      await desktopApi.restartHarnessForDevelopment()
      setRestartRequired(false)
      onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setOperating(false)
    }
  }

  const renderPlugin = (plugin: ManagedPluginEntry): ReactNode => {
    const confirming = removeConfirmation === plugin.name
    const stateLabel = plugin.status === 'missing' ? '来源失效' : !plugin.toggleable ? '非插件依赖' : plugin.active ? '已启用' : '已停用'
    return (
      <div className={`plugin-row${plugin.status === 'missing' ? ' missing' : ''}`} key={plugin.name}>
        <div className="plugin-row-main">
          <div className="plugin-name-line"><strong>{plugin.name}</strong>{plugin.version ? <span>{plugin.version}</span> : null}</div>
          <p>{plugin.description ?? (plugin.sourceType === 'builtin' ? '由当前 Harness 运行时提供' : '暂无插件说明')}</p>
          <div className="plugin-source" title={plugin.source}><span className={`plugin-source-badge ${plugin.sourceType}`}>{PLUGIN_SOURCE_LABELS[plugin.sourceType]}</span><code>{plugin.source}</code></div>
        </div>
        <div className="plugin-row-actions">
          <div className="plugin-active-control">
            <button
              className="plugin-active-toggle"
              type="button"
              role="switch"
              aria-checked={plugin.active}
              aria-label={`${plugin.active ? '停用' : '启用'} ${plugin.name}`}
              title={plugin.toggleable ? `${plugin.active ? '停用' : '启用'}插件（重启 Harness 后生效）` : stateLabel}
              disabled={operating || !plugin.toggleable || plugin.status === 'missing'}
              onClick={() => void setActive(plugin.name, !plugin.active)}
            >
              <span className="plugin-toggle-track" aria-hidden="true"><span /></span>
            </button>
            <span className={`plugin-state ${plugin.status === 'missing' ? 'error' : plugin.active ? 'active' : ''}`}>{stateLabel}</span>
          </div>
          {plugin.removable ? confirming ? (
            <div className="plugin-remove-confirmation">
              <button className="compact-button subtle" type="button" disabled={operating} onClick={() => setRemoveConfirmation(undefined)}>取消</button>
              <button className="compact-button danger" type="button" disabled={operating} onClick={() => void remove(plugin.name)}>确认移除</button>
            </div>
          ) : <button className="plugin-remove-button" type="button" aria-label={`移除 ${plugin.name}`} title="移除插件" disabled={operating} onClick={() => setRemoveConfirmation(plugin.name)}><Trash2 /></button> : null}
        </div>
      </div>
    )
  }

  return (
    <Modal open={open} className="plugin-dialog" labelledBy="plugin-manager-title" closeLabel="关闭插件管理" onClose={onClose}>
      <header className="dialog-header plugin-dialog-header">
        <div className="dialog-heading">
          <span className="development-icon plugin-manager-icon" aria-hidden="true"><Puzzle /></span>
          <div><h2 id="plugin-manager-title">插件管理</h2><p>按 Profile 查看自定义插件、安装来源与当前状态</p></div>
        </div>
        <button ref={closeButton} className="dialog-close" type="button" aria-label="关闭插件管理" title="关闭" onClick={onClose}><X /></button>
      </header>

      <div className="dialog-content plugin-content">
        <div className="plugin-toolbar">
          <label className="plugin-profile-select"><span>Profile</span><select value={selectedProfile} disabled={loading || operating} onChange={(event) => setSelectedProfile(event.target.value)}>{inventory?.profiles.map((profile) => <option value={profile.name} key={profile.name}>{profile.name}</option>)}</select></label>
          <div className="plugin-summary"><span><strong>{managedPlugins.length}</strong> 个自定义插件</span><span><strong>{localCount}</strong> 个本地</span>{missingCount > 0 ? <span className="error"><strong>{missingCount}</strong> 个异常</span> : null}</div>
          <button className="plugin-icon-button" type="button" aria-label="刷新插件列表" title="刷新" disabled={loading || operating} onClick={() => void loadInventory()}><RotateCw className={loading ? 'spinning' : ''} /></button>
        </div>

        <section className="plugin-install-card">
          <div><strong>添加插件</strong><span>支持 npm 包名、Git 仓库地址和本地目录</span></div>
          <div className="plugin-install-fields">
            <input value={source} type="text" autoComplete="off" spellCheck="false" placeholder="例如 @scope/plugin 或 https://github.com/…" disabled={operating} onChange={(event) => setSource(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void install() }} />
            <button className="compact-button plugin-folder-button" type="button" disabled={operating} onClick={() => void chooseLocal()}><FolderOpen /><span>本地目录</span></button>
            <button className="dialog-button primary plugin-install-button" type="button" disabled={operating || !harnessReady || selectedProfile.length === 0 || source.trim().length === 0} onClick={() => void install()}><Plus />{installing ? '处理中…' : '添加'}</button>
          </div>
          {!harnessReady ? <p className="plugin-inline-note">Harness 就绪后可安装或移除；当前仍可查看已有插件。</p> : null}
        </section>

        {error ? <p className="plugin-error">{error}</p> : null}
        {lastResult ? <details className={`plugin-command-result${lastResult.exitCode === 0 ? '' : ' error'}`}><summary>{lastResult.exitCode === 0 ? '命令执行完成' : '查看失败输出'}<code>{lastResult.command}</code></summary><pre>{lastResult.output}</pre></details> : null}

        <div className="plugin-list-toolbar">
          <div className="plugin-restart-slot">
            {restartRequired ? <div className="plugin-restart-inline"><span>配置待重启生效</span><button type="button" disabled={operating || restarting} onClick={() => void restart()}>{restarting ? '正在重启…' : '立即重启'}</button></div> : null}
          </div>
          <div className="plugin-search"><Search aria-hidden="true" /><input value={query} type="search" placeholder="搜索名称、说明或来源" onChange={(event) => setQuery(event.target.value)} /></div>
        </div>

        <div className="plugin-list" aria-busy={loading}>
          {loading && inventory === undefined ? <div className="plugin-empty">正在读取 Profile…</div> : null}
          {!loading && inventory?.profiles.length === 0 ? <div className="plugin-empty">尚未发现已初始化的 Profile。</div> : null}
          {activeProfile?.error ? <div className="plugin-empty error">{activeProfile.error}</div> : null}
          {activeProfile !== undefined && !activeProfile.error && matchingPlugins.length === 0 ? <div className="plugin-empty">{query.trim() ? '没有匹配的插件。' : '这个 Profile 还没有安装自定义插件。'}</div> : null}
          {matchingPlugins.length > 0 ? <section className="plugin-group"><header><span>自定义插件</span><span>{matchingPlugins.length}</span></header><div>{matchingPlugins.map(renderPlugin)}</div></section> : null}
        </div>
      </div>

      <footer className="dialog-actions plugin-dialog-actions"><button className="plugin-docs-button" type="button" onClick={() => void desktopApi.openPluginDocumentation()}>官方插件文档</button><span /><button className="dialog-button secondary" type="button" onClick={onClose}>完成</button></footer>
    </Modal>
  )
}

export function App(): ReactNode {
  const [state, setState] = useState<DesktopState>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [developmentOpen, setDevelopmentOpen] = useState(false)
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false)
  const [startupActionPending, setStartupActionPending] = useState(false)
  const [startupActionError, setStartupActionError] = useState<string>()
  const [contextMenu, setContextMenu] = useState<DesktopContextMenuRequest>()
  const [browserAddress, setBrowserAddress] = useState('')
  const [browserAddressFocused, setBrowserAddressFocused] = useState(false)
  const [browserHistoryOpen, setBrowserHistoryOpen] = useState(false)
  const [browserHistory, setBrowserHistory] = useState<DesktopBrowserHistoryEntry[]>([])
  const [browserDisplayMenuOpen, setBrowserDisplayMenuOpen] = useState(false)
  const [browserSettingsMenuOpen, setBrowserSettingsMenuOpen] = useState(false)
  const [browserShellSnapshot, setBrowserShellSnapshot] = useState<BrowserShellSnapshotImage>()
  const [browserShellOverlayActive, setBrowserShellOverlayActive] = useState(false)
  const [shellMenuPresentationPending, setShellMenuPresentationPending] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(() => {
    const stored = Number(localStorage.getItem('desktop.browser.width'))
    return Number.isFinite(stored) && stored >= 360 ? stored : 620
  })
  const [browserExpanded, setBrowserExpanded] = useState(false)
  const harnessFrame = useRef<HTMLIFrameElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const browserViewHost = useRef<HTMLDivElement>(null)
  const browserSurfaceRef = useRef<HTMLDivElement>(null)
  const [browserSurfaceSize, setBrowserSurfaceSize] = useState({ width: 0, height: 0 })
  const [browserDevicePreview, setBrowserDevicePreview] = useState<DesktopBrowserViewport | undefined>(undefined)
  const browserNormalWidth = useRef(browserWidth)
  const contextMenuRef = useRef<DesktopContextMenuRequest | undefined>(undefined)
  const releaseCloseButton = useRef<HTMLButtonElement>(null)
  const shellOverlaySequence = useRef(0)
  const browserShellSnapshotRef = useRef<BrowserShellSnapshotImage | undefined>(undefined)
  const browserShellSnapshotGeneration = useRef(0)

  useEffect(() => {
    let disposed = false
    const unsubscribe = desktopApi.onState((nextState) => { if (!disposed) setState(nextState) })
    void desktopApi.getState().then((nextState) => { if (!disposed) setState(nextState) })
    return () => { disposed = true; unsubscribe() }
  }, [])

  useEffect(() => desktopApi.onContextMenu((request) => {
    contextMenuRef.current = request
    setContextMenu(request)
    setMenuOpen(false)
  }), [])

  useEffect(() => desktopApi.onApplicationMenuAction((action: DesktopApplicationMenuAction) => {
    setMenuOpen(false)
    if (action === 'plugins') setPluginManagerOpen(true)
    else if (action === 'development') setDevelopmentOpen(true)
    else if (action === 'release-notes') setReleaseNotesOpen(true)
    else if (action === 'update') setUpdateOpen(true)
  }), [])

  useEffect(() => desktopApi.onPointerInput(({ x, y }) => {
    const target = document.elementFromPoint(x, y)
    if (target === null || target.closest('#title-menu, #title-menu-popover') === null) setMenuOpen(false)

    const current = contextMenuRef.current
    if (current !== undefined && (target === null || target.closest('.context-menu-card') === null)) {
      contextMenuRef.current = undefined
      setContextMenu(undefined)
      void desktopApi.dismissContextMenu(current.requestId, false)
    }
  }), [])

  useEffect(() => {
    if (state === undefined) return
    document.documentElement.dataset.theme = state.theme
    document.documentElement.dataset.platform = state.platform
    document.body.classList.toggle('maximized', state.isMaximized)
  }, [state])

  useEffect(() => {
    if (!browserAddressFocused) setBrowserAddress(state?.browser.url ?? '')
  }, [browserAddressFocused, state?.browser.url])

  useEffect(() => {
    if (state?.browser.panelOpen === false) {
      setBrowserHistoryOpen(false)
      setBrowserDisplayMenuOpen(false)
      setBrowserSettingsMenuOpen(false)
      setBrowserWidth(browserNormalWidth.current)
      setBrowserExpanded(false)
    }
  }, [state?.browser.panelOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (pluginManagerOpen) setPluginManagerOpen(false)
      else if (developmentOpen) setDevelopmentOpen(false)
      else if (updateOpen) setUpdateOpen(false)
      else if (releaseNotesOpen) setReleaseNotesOpen(false)
      else if (menuOpen) setMenuOpen(false)
      else if (browserDisplayMenuOpen) setBrowserDisplayMenuOpen(false)
      else if (browserSettingsMenuOpen) setBrowserSettingsMenuOpen(false)
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [browserDisplayMenuOpen, browserSettingsMenuOpen, developmentOpen, menuOpen, pluginManagerOpen, releaseNotesOpen, updateOpen])

  useEffect(() => { if (releaseNotesOpen) releaseCloseButton.current?.focus({ preventScroll: true }) }, [releaseNotesOpen])

  useEffect(() => {
    setStartupActionPending(false)
    setStartupActionError(undefined)
  }, [state?.harnessLoadId, state?.pluginFailure?.entryId])

  const focusHarness = useCallback(() => {
    if (state?.harnessUrl) harnessFrame.current?.focus({ preventScroll: true })
  }, [state?.harnessUrl])
  const update = useMemo(() => state === undefined ? undefined : updatePresentation(state), [state])
  const ready = state?.harnessLifecycle === 'ready'
  const preparingRuntime = state?.harnessLifecycle === 'starting' && state.harnessVersion === undefined
  const runtimePreparationProgress = preparingRuntime ? state?.runtimePreparationProgress : undefined
  const harnessUrl = state?.harnessUrl ?? ''
  const availableUpdate = state?.updateVersion !== undefined && state.updateVersion !== state.harnessVersion
  const patchEnabled = Boolean(state?.development.patchPath)
  const pluginFailure = state?.pluginFailure
  const browserOpen = state?.browser.panelOpen === true && state.browser.settings.enabled
  const browserDisplayMode: BrowserDisplayMode = state?.browser.settings.displayMode ?? 'split'
  const browserModalOpen = releaseNotesOpen || updateOpen || developmentOpen || pluginManagerOpen
  const browserPanelOpen = browserOpen && browserDisplayMode !== 'floating'
  const browserMenuOpen = browserDisplayMenuOpen || browserSettingsMenuOpen
  const browserDisplayModeLabel = browserDisplayMode === 'split' ? '分栏' : browserDisplayMode === 'drawer' ? '抽屉' : '独立窗口'
  const browserViewport = state?.browser.viewport
  const renderedBrowserViewport = browserDevicePreview ?? browserViewport
  const browserDeviceMaxWidth = Math.max(240, Math.floor(browserSurfaceSize.width - BROWSER_DEVICE_TOTAL_GUTTER))
  const browserDeviceMaxHeight = Math.max(240, Math.floor(browserSurfaceSize.height - BROWSER_DEVICE_TOTAL_GUTTER))
  const browserDeviceScale = renderedBrowserViewport === undefined || browserSurfaceSize.width === 0 || browserSurfaceSize.height === 0
    ? 1
    : Math.max(0.1, Math.min(
      1,
      browserDeviceMaxWidth / renderedBrowserViewport.width,
      browserDeviceMaxHeight / renderedBrowserViewport.height,
    ))
  const browserDeviceRenderedHeight = renderedBrowserViewport === undefined
    ? 0
    : Math.max(1, Math.min(browserDeviceMaxHeight, Math.round(renderedBrowserViewport.height * browserDeviceScale)))

  useEffect(() => {
    if (!browserModalOpen || !browserOpen) return
    void desktopApi.setBrowserPanelOpen(false)
  }, [browserModalOpen, browserOpen])

  useEffect(() => {
    if (browserViewport === undefined) setBrowserDevicePreview(undefined)
    else setBrowserDevicePreview((preview) => preview?.width === browserViewport.width && preview.height === browserViewport.height ? undefined : preview)
  }, [browserViewport?.height, browserViewport?.width])

  useEffect(() => {
    setBrowserExpanded(false)
    if (browserDisplayMode !== 'floating') setBrowserWidth(browserNormalWidth.current)
  }, [browserDisplayMode])

  useEffect(() => {
    const surface = browserSurfaceRef.current
    if (surface === null) return
    const report = (): void => setBrowserSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight })
    const observer = new ResizeObserver(report)
    observer.observe(surface)
    report()
    return () => observer.disconnect()
  }, [browserPanelOpen, state?.browser.viewport])

  useEffect(() => {
    const host = browserViewHost.current
    const surface = browserSurfaceRef.current
    if (!browserPanelOpen || browserHistoryOpen || browserModalOpen || !state?.browser.url || host === null) {
      void desktopApi.setBrowserViewBounds(null)
      return
    }
    let frame = 0
    const report = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) {
          void desktopApi.setBrowserViewBounds(null)
          return
        }
        void desktopApi.setBrowserViewBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        })
      })
    }
    const observer = new ResizeObserver(report)
    observer.observe(host)
    if (surface !== null) observer.observe(surface)
    window.addEventListener('resize', report)
    report()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [browserHistoryOpen, browserModalOpen, browserPanelOpen, state?.browser.url, state?.browser.viewport?.height, state?.browser.viewport?.width])

  const clearBrowserShellSnapshot = useCallback(() => {
    browserShellSnapshotGeneration.current += 1
    browserShellSnapshotRef.current = undefined
    setBrowserShellSnapshot(undefined)
    setBrowserShellOverlayActive(false)
  }, [])

  const prepareBrowserShellSnapshot = useCallback(async (snapshot: DesktopBrowserShellSnapshot, generation = browserShellSnapshotGeneration.current): Promise<BrowserShellSnapshotImage | undefined> => {
    const alreadyDecoded = browserShellSnapshotRef.current?.dataUrl === snapshot.dataUrl
    if (!alreadyDecoded) {
      const decoded = await new Promise<boolean>((resolve) => {
        const image = new Image()
        image.onload = () => resolve(true)
        image.onerror = () => resolve(false)
        image.src = snapshot.dataUrl
      })
      if (!decoded) return undefined
    }
    if (generation !== browserShellSnapshotGeneration.current) return undefined
    const host = browserViewHost.current
    if (host === null) return undefined
    const hostRect = host.getBoundingClientRect()
    const prepared = {
      dataUrl: snapshot.dataUrl,
      left: snapshot.bounds.x - hostRect.x,
      top: snapshot.bounds.y - hostRect.y,
      width: snapshot.bounds.width,
      height: snapshot.bounds.height,
    }
    if (generation !== browserShellSnapshotGeneration.current) return undefined
    browserShellSnapshotRef.current = prepared
    setBrowserShellSnapshot(prepared)
    return prepared
  }, [])

  useEffect(() => {
    if (!browserPanelOpen || browserHistoryOpen || browserModalOpen || !state?.browser.url) {
      clearBrowserShellSnapshot()
      return
    }
    const generation = ++browserShellSnapshotGeneration.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      const snapshot = await desktopApi.refreshBrowserShellSnapshot().catch(() => undefined)
      if (!disposed && snapshot !== undefined) await prepareBrowserShellSnapshot(snapshot, generation)
      if (!disposed) timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => {
      disposed = true
      if (browserShellSnapshotGeneration.current === generation) clearBrowserShellSnapshot()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [browserHistoryOpen, browserModalOpen, browserPanelOpen, clearBrowserShellSnapshot, prepareBrowserShellSnapshot, state?.browser.url, state?.browser.viewport?.height, state?.browser.viewport?.width])

  useLayoutEffect(() => {
    const sequence = ++shellOverlaySequence.current
    const menuVisible = menuOpen || contextMenu !== undefined || browserMenuOpen
    if (!menuVisible) {
      setShellMenuPresentationPending(false)
      setBrowserShellOverlayActive(false)
      void desktopApi.setBrowserShellOverlay(null)
      return
    }
    setShellMenuPresentationPending(true)
    queueMicrotask(() => {
      if (shellOverlaySequence.current !== sequence) return
      const menus = [...document.querySelectorAll<HTMLElement>('#title-menu-popover, .context-menu-card')]
        .filter((element) => element.offsetWidth > 0 && element.offsetHeight > 0)
      if (menus.length === 0) {
        setShellMenuPresentationPending(false)
        setBrowserShellOverlayActive(false)
        void desktopApi.setBrowserShellOverlay(null)
        return
      }
      const rects = menus.map((element) => element.getBoundingClientRect())
      const left = Math.min(...rects.map((rect) => rect.left))
      const top = Math.min(...rects.map((rect) => rect.top))
      const right = Math.max(...rects.map((rect) => rect.right))
      const bottom = Math.max(...rects.map((rect) => rect.bottom))
      const host = browserViewHost.current
      if (host === null) {
        setShellMenuPresentationPending(false)
        setBrowserShellOverlayActive(false)
        void desktopApi.setBrowserShellOverlay(null)
        return
      }
      const hostRect = host.getBoundingClientRect()
      const overlapsBrowser = left < hostRect.right && right > hostRect.left && top < hostRect.bottom && bottom > hostRect.top
      if (!overlapsBrowser) {
        setShellMenuPresentationPending(false)
        setBrowserShellOverlayActive(false)
        void desktopApi.setBrowserShellOverlay(null)
        return
      }
      void desktopApi.refreshBrowserShellSnapshot()
        .then((snapshot) => snapshot === undefined ? undefined : prepareBrowserShellSnapshot(snapshot))
        .catch(() => undefined)
      void desktopApi.setBrowserShellOverlay({ x: left, y: top, width: right - left, height: bottom - top }).then(async (snapshot) => {
        if (shellOverlaySequence.current !== sequence) return
        if (snapshot === undefined) {
          setShellMenuPresentationPending(false)
          return
        }
        const prepared = await prepareBrowserShellSnapshot(snapshot)
        if (prepared === undefined || shellOverlaySequence.current !== sequence) {
          setShellMenuPresentationPending(false)
          return
        }
        setBrowserShellOverlayActive(true)
        await desktopApi.commitBrowserShellOverlay()
        requestAnimationFrame(() => {
          if (shellOverlaySequence.current === sequence) setShellMenuPresentationPending(false)
        })
      }).catch(() => {
        if (shellOverlaySequence.current === sequence) setShellMenuPresentationPending(false)
      })
    })
  }, [browserDisplayMenuOpen, browserSettingsMenuOpen, contextMenu, menuOpen, prepareBrowserShellSnapshot])

  useEffect(() => {
    const content = contentRef.current
    if (!browserPanelOpen || content === null) return
    const resize = (): void => {
      if (browserExpanded) {
        setBrowserWidth(content.clientWidth)
      } else {
        const reserved = browserDisplayMode === 'split' ? 360 : 48
        const maxNormal = Math.max(360, content.clientWidth - reserved)
        setBrowserWidth((current) => Math.min(maxNormal, Math.max(360, current)))
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(content)
    resize()
    return () => observer.disconnect()
  }, [browserDisplayMode, browserExpanded, browserPanelOpen])

  const startBrowserResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const content = contentRef.current
    if (content === null || browserExpanded || browserDisplayMode === 'floating') return
    event.preventDefault()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    let frame = 0
    let pendingWidth = browserNormalWidth.current
    const commit = (): void => {
      frame = 0
      browserNormalWidth.current = pendingWidth
      setBrowserWidth(pendingWidth)
    }
    const move = (pointer: PointerEvent): void => {
      const rect = content.getBoundingClientRect()
      const reserved = browserDisplayMode === 'split' ? 360 : 48
      pendingWidth = Math.min(Math.max(360, rect.width - reserved), Math.max(360, rect.right - pointer.clientX))
      if (frame === 0) frame = requestAnimationFrame(commit)
    }
    const finish = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        commit()
      }
      localStorage.setItem('desktop.browser.width', String(Math.round(pendingWidth)))
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [browserDisplayMode, browserExpanded])

  const toggleBrowserExpanded = useCallback(() => {
    const content = contentRef.current
    if (content === null) return
    if (browserExpanded) {
      if (browserDisplayMode !== 'floating') setBrowserWidth(browserNormalWidth.current)
      setBrowserExpanded(false)
      return
    }
    if (browserDisplayMode !== 'floating') browserNormalWidth.current = browserWidth
    setBrowserWidth(content.clientWidth)
    setBrowserExpanded(true)
  }, [browserDisplayMode, browserExpanded, browserWidth])

  const openBrowserHistory = useCallback(async () => {
    setBrowserDisplayMenuOpen(false)
    setBrowserSettingsMenuOpen(false)
    setBrowserHistory(await desktopApi.getBrowserHistory())
    setBrowserHistoryOpen(true)
  }, [])

  const navigateBrowser = useCallback(async (value: string) => {
    const address = value.trim()
    if (address.length === 0) return
    setBrowserHistoryOpen(false)
    await desktopApi.navigateBrowser(address)
  }, [])

  const selectBrowserDisplayMode = useCallback(async (mode: BrowserDisplayMode) => {
    setBrowserDisplayMenuOpen(false)
    await desktopApi.setBrowserDisplayMode(mode)
  }, [])

  const setDeviceViewport = useCallback((width: number, height: number) => {
    void desktopApi.setBrowserDeviceViewport({
      width: Math.max(240, Math.min(3840, Math.round(width))),
      height: Math.max(240, Math.min(2160, Math.round(height))),
    })
  }, [])

  const openBrowserMenu = useCallback((kind: 'display' | 'settings', _target: HTMLButtonElement) => {
    if (kind === 'display') { setBrowserSettingsMenuOpen(false); setBrowserDisplayMenuOpen((open) => !open) }
    else { setBrowserDisplayMenuOpen(false); setBrowserSettingsMenuOpen((open) => !open) }
  }, [])

  const startDeviceResize = useCallback((event: React.PointerEvent<HTMLDivElement>, direction: string) => {
    const viewport = state?.browser.viewport
    if (viewport === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    const startX = event.clientX
    const startY = event.clientY
    const scale = Math.max(0.1, browserDeviceScale)
    const maxWidth = Math.min(3840, Math.max(240, Math.floor(browserDeviceMaxWidth / scale)))
    const maxHeight = Math.min(2160, Math.max(240, Math.floor(browserDeviceMaxHeight / scale)))
    const startWidth = Math.min(viewport.width, maxWidth)
    const startHeight = Math.min(viewport.height, maxHeight)
    const frameElement = handle.closest<HTMLElement>('.browser-device-frame')
    let nextWidth = startWidth
    let nextHeight = startHeight
    let frame = 0
    const preview = (): void => {
      frame = 0
      const viewport = {
        width: Math.max(240, Math.min(maxWidth, Math.round(nextWidth))),
        height: Math.max(240, Math.min(maxHeight, Math.round(nextHeight))),
      }
      if (frameElement !== null) {
        frameElement.style.width = `${String(Math.round(viewport.width * scale) + BROWSER_DEVICE_FRAME_GUTTER * 2)}px`
        frameElement.style.height = `${String(Math.max(1, Math.min(browserDeviceMaxHeight, Math.round(viewport.height * scale))) + BROWSER_DEVICE_FRAME_GUTTER * 2)}px`
      }
      void desktopApi.previewBrowserDeviceViewport(viewport)
    }
    const move = (pointer: PointerEvent): void => {
      // The device frame is centered in the stage, so changing its size moves
      // each edge by half of the total delta. Compensate for that geometry so
      // the active handle follows the pointer one-for-one.
      const dx = ((pointer.clientX - startX) * 2) / scale
      const dy = ((pointer.clientY - startY) * 2) / scale
      if (direction.includes('e')) nextWidth = startWidth + dx
      if (direction.includes('w')) nextWidth = startWidth - dx
      if (direction.includes('s')) nextHeight = startHeight + dy
      if (direction.includes('n')) nextHeight = startHeight - dy
      if (frame === 0) frame = requestAnimationFrame(preview)
    }
    const finish = (): void => {
      if (frame !== 0) { cancelAnimationFrame(frame); preview() }
      const width = Math.max(240, Math.min(maxWidth, Math.round(nextWidth)))
      const height = Math.max(240, Math.min(maxHeight, Math.round(nextHeight)))
      setBrowserDevicePreview({ width, height })
      void desktopApi.setBrowserDeviceViewport({ width, height })
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [browserDeviceMaxHeight, browserDeviceMaxWidth, browserDeviceScale, state?.browser.viewport])

  const dismissContextMenu = useCallback((restoreFocus = true): void => {
    const current = contextMenuRef.current
    contextMenuRef.current = undefined
    setContextMenu(undefined)
    if (current !== undefined) void desktopApi.dismissContextMenu(current.requestId, restoreFocus)
  }, [])

  const selectContextMenuItem = useCallback((itemId: string): void => {
    const current = contextMenuRef.current
    if (current === undefined) return
    contextMenuRef.current = undefined
    setContextMenu(undefined)
    void desktopApi.selectContextMenuItem({
      requestId: current.requestId,
      itemId,
    })
  }, [])

  useEffect(() => {
    contextMenuRef.current = undefined
    setContextMenu(undefined)
  }, [state?.harnessLoadId, state?.harnessUrl])

  useEffect(() => {
    if (contextMenu === undefined) return
    const onWindowBlur = (): void => dismissContextMenu(false)
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [contextMenu, dismissContextMenu])

  const runStartupAction = async (action: () => Promise<void>): Promise<void> => {
    if (startupActionPending) return
    setStartupActionPending(true)
    setStartupActionError(undefined)
    try {
      await action()
    } catch (error) {
      setStartupActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setStartupActionPending(false)
    }
  }

  return (
    <>
      <main ref={contentRef} className="content">
        <section className="harness-pane">
          {harnessUrl ? <iframe key={state?.harnessLoadId} ref={harnessFrame} id="harness-frame" name="harness-frame" className="harness-frame" title="DeepSeek Harness" allow="clipboard-read; clipboard-write" src={harnessUrl} onLoad={() => void desktopApi.reportHarnessFrameLoaded(harnessUrl)} /> : null}
        {!ready ? (
          <section className={`startup ${state?.harnessLifecycle === 'error' ? 'error' : ''}`}>
            {runtimePreparationProgress !== undefined ? (
              <div
                className="startup-progress"
                role="progressbar"
                aria-label="Harness 运行时解压进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={runtimePreparationProgress}
              >
                <span className="startup-progress-value">{runtimePreparationProgress}</span>
                <span className="startup-progress-unit">%</span>
              </div>
            ) : <div className="loader" aria-hidden="true" />}
            <h1 id="startup-title">{pluginFailure ? 'Harness 插件初始化失败' : state?.harnessLifecycle === 'error' ? 'DeepSeek Harness 启动失败' : preparingRuntime ? '正在准备 DeepSeek Harness' : '正在启动 DeepSeek Harness'}</h1>
            <p id="startup-message">{state?.harnessMessage ?? '正在准备本地 Harness 服务…'}</p>
            {pluginFailure ? (
              <div className="plugin-recovery-actions">
                <p>可以先临时禁用 <strong>{pluginFailure.pluginName}</strong>，让 Harness 恢复启动。修好插件后可在“开发工具 → 插件恢复”中重新启用。</p>
                {pluginFailure.recoverable ? (
                  <button className="secondary-button recovery-button" type="button" disabled={startupActionPending} onClick={() => void runStartupAction(() => desktopApi.recoverFailedPlugin())}>
                    {startupActionPending ? '正在禁用并重启…' : '临时禁用该插件并重启'}
                  </button>
                ) : <p className="startup-action-error">这个内置桥接插件不能自动禁用，请重新安装桌面应用。</p>}
                {startupActionError ? <p className="startup-action-error" role="alert">{startupActionError}</p> : null}
              </div>
            ) : state?.harnessLifecycle === 'error' ? <button className="secondary-button" type="button" onClick={() => void desktopApi.checkForHarnessUpdate()}>重新检查更新</button> : null}
          </section>
        ) : null}
        </section>
        {browserPanelOpen ? (
          <aside className={`browser-pane mode-${browserDisplayMode}${browserExpanded ? ' expanded' : ''}`} style={browserExpanded ? undefined : { width: browserWidth }} aria-label="内置浏览器">
            {browserExpanded ? null : <div className="browser-resizer" role="separator" aria-orientation="vertical" onPointerDown={startBrowserResize} />}
            <header className="browser-chrome">
              <div className="browser-tabbar">
                <div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
                  {state?.browser.tabs.map((tab) => {
                    const label = tab.url ? tab.title || tab.url : tab.sessionBound ? 'Agent 浏览器' : '新标签页'
                    const selected = state.browser.activeTabId === tab.id
                    return <div key={tab.id} className={`browser-tab${selected ? ' active' : ''}`} title={label}>
                      <button className="browser-tab-main" type="button" role="tab" aria-selected={selected} onClick={() => void desktopApi.selectBrowserTab(tab.id)}>
                        {tab.loading ? <RotateCw className="browser-tab-loading" aria-label="正在加载" /> : <span className="browser-tab-favicon" aria-hidden="true"><Globe2 />{tab.faviconUrl ? <img src={tab.faviconUrl} alt="" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true }} /> : null}</span>}<span className="browser-tab-title">{label}</span>{tab.agentActive ? <AgentPointerIcon className="browser-agent-pointer" /> : null}
                      </button>
                      <button className="browser-tab-close" type="button" aria-label={`关闭 ${label}`} onClick={(event) => { event.stopPropagation(); void desktopApi.closeBrowserTab(tab.id) }}><X /></button>
                    </div>
                  })}
                  <button className="browser-new-tab" type="button" aria-label="新增标签页" title="新增标签页" onClick={() => void desktopApi.createBrowserTab()}><Plus /></button>
                </div>
                <div className="browser-panel-actions">
                  <button type="button" aria-label={browserExpanded ? '恢复面板宽度' : '展开面板'} title={browserExpanded ? '恢复面板宽度' : '展开面板'} onClick={toggleBrowserExpanded}>{browserExpanded ? <Minimize2 /> : <Maximize2 />}</button>
                  <button type="button" aria-label={`显示方式：${browserDisplayModeLabel}`} aria-expanded={browserDisplayMenuOpen} title={`显示方式：${browserDisplayModeLabel}`} onClick={(event) => openBrowserMenu('display', event.currentTarget)}>
                    {browserDisplayMode === 'split' ? <Columns2 /> : browserDisplayMode === 'drawer' ? <PanelRight /> : <FloatingWindowIcon />}
                  </button>
                  <button type="button" aria-label="隐藏浏览器" title="隐藏浏览器" onClick={() => void desktopApi.setBrowserPanelOpen(false)}><X /></button>
                </div>
              </div>
              <div className="browser-toolbar">
              <div className="browser-navigation">
                <button type="button" aria-label="后退" disabled={!state?.browser.canGoBack} onClick={() => void desktopApi.browserNavigationAction('back')}><ArrowLeft /></button>
                <button type="button" aria-label="前进" disabled={!state?.browser.canGoForward} onClick={() => void desktopApi.browserNavigationAction('forward')}><ArrowRight /></button>
                <button type="button" aria-label={state?.browser.loading ? '停止加载' : '重新加载'} onClick={() => void desktopApi.browserNavigationAction(state?.browser.loading ? 'stop' : 'reload')}><RotateCw className={state?.browser.loading ? 'browser-loading' : ''} /></button>
              </div>
              <form className="browser-address" onSubmit={(event) => { event.preventDefault(); void navigateBrowser(browserAddress) }}>
                <Globe2 aria-hidden="true" />
                <input value={browserAddress} aria-label="网页地址" placeholder="输入网址或搜索内容" spellCheck={false} onFocus={() => setBrowserAddressFocused(true)} onBlur={() => setBrowserAddressFocused(false)} onChange={(event) => setBrowserAddress(event.target.value)} />
              </form>
              <div className="browser-actions">
                <button type="button" aria-label="浏览器设置" aria-expanded={browserSettingsMenuOpen} onClick={(event) => openBrowserMenu('settings', event.currentTarget)}><MoreVertical /></button>
              </div>
              </div>
            </header>
            {state?.browser.viewport ? (
              <div className="browser-device-toolbar">
                <strong>尺寸:</strong><span>响应式</span>
                <input key={`width-${String(state.browser.viewport.width)}`} type="number" min={240} max={3840} defaultValue={state.browser.viewport.width} aria-label="设备宽度" onBlur={(event) => setDeviceViewport(Number(event.currentTarget.value), state.browser.viewport?.height ?? 860)} />
                <span>×</span>
                <input key={`height-${String(state.browser.viewport.height)}`} type="number" min={240} max={2160} defaultValue={state.browser.viewport.height} aria-label="设备高度" onBlur={(event) => setDeviceViewport(state.browser.viewport?.width ?? 583, Number(event.currentTarget.value))} />
                <button type="button" aria-label="旋转设备" title="旋转设备" onClick={() => setDeviceViewport(state.browser.viewport?.height ?? 860, state.browser.viewport?.width ?? 583)}><TabletSmartphone /></button>
                <span>{Math.round((state.browser.zoomFactor ?? 1) * 100)}%</span>
                <button className="device-toolbar-close" type="button" aria-label="关闭设备工具栏" title="关闭设备工具栏" onClick={() => void desktopApi.setBrowserDeviceViewport(null)}><X /></button>
              </div>
            ) : null}
            {browserMenuOpen ? (
              <div className={`browser-menu-layer${shellMenuPresentationPending ? ' shell-overlay-pending' : ''}${browserShellOverlayActive ? ' shell-overlay-synchronized' : ''}`} onPointerDown={() => { setBrowserDisplayMenuOpen(false); setBrowserSettingsMenuOpen(false) }}>
                {browserDisplayMenuOpen ? (
                  <div className="context-menu-card browser-popover display-popover" role="menu" aria-label="浏览器显示方式" onPointerDown={(event) => event.stopPropagation()}>
                    {([
                      ['split', '分栏', <Columns2 key="split" />],
                      ['drawer', '抽屉', <PanelRight key="drawer" />],
                      ['floating', '独立窗口', <FloatingWindowIcon key="floating" />],
                    ] as const).map(([mode, label, icon]) => (
                      <button key={mode} className="context-menu-item browser-mode-item" type="button" role="menuitemradio" aria-checked={browserDisplayMode === mode} onClick={() => void selectBrowserDisplayMode(mode)}>
                        <span className="context-menu-icon">{icon}</span><span className="context-menu-label">{label}</span>{browserDisplayMode === mode ? <Check className="browser-menu-check" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {browserSettingsMenuOpen ? (
                  <div className="context-menu-card browser-popover settings-popover" role="menu" aria-label="浏览器设置" onPointerDown={(event) => event.stopPropagation()}>
                    <button className="context-menu-item" type="button" role="menuitem" onClick={() => void openBrowserHistory()}><span className="context-menu-icon"><History /></span><span className="context-menu-label">历史记录</span></button>
                    <button className="context-menu-item" type="button" role="menuitem" onClick={() => { setBrowserSettingsMenuOpen(false); void desktopApi.clearBrowserData() }}><span className="context-menu-icon"><Trash2 /></span><span className="context-menu-label">清除浏览数据</span></button>
                    <div className="context-menu-separator" />
                    <div className="browser-zoom-row" role="group" aria-label="网页缩放">
                      <span>缩放</span>
                      <button type="button" aria-label="缩小" disabled={(state?.browser.zoomFactor ?? 1) <= 0.5} onClick={() => void desktopApi.setBrowserZoomFactor((state?.browser.zoomFactor ?? 1) - 0.1)}><Minus /></button>
                      <strong>{Math.round((state?.browser.zoomFactor ?? 1) * 100)}%</strong>
                      <button type="button" aria-label="放大" disabled={(state?.browser.zoomFactor ?? 1) >= 2} onClick={() => void desktopApi.setBrowserZoomFactor((state?.browser.zoomFactor ?? 1) + 0.1)}><Plus /></button>
                      <button type="button" aria-label="重置缩放" title="重置" disabled={(state?.browser.zoomFactor ?? 1) === 1} onClick={() => void desktopApi.setBrowserZoomFactor(1)}><RotateCw /></button>
                    </div>
                    <div className="context-menu-separator" />
                    <button className="context-menu-item" type="button" role="menuitem" disabled={!state?.browser.url} onClick={() => {
                      setBrowserSettingsMenuOpen(false)
                      void desktopApi.setBrowserDeviceViewport(state?.browser.viewport ? null : { width: 583, height: 860 })
                    }}>
                      <span className="context-menu-icon"><MonitorSmartphone /></span><span className="context-menu-label">{state?.browser.viewport ? '隐藏设备工具栏' : '显示设备工具栏'}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div ref={browserSurfaceRef} className={`browser-surface${browserViewport ? ' device-active' : ''}${browserShellOverlayActive ? ' shell-overlay-active' : ''}`}>
              {browserHistoryOpen ? (
                <section className="browser-history" aria-label="浏览历史">
                  <header><button className="browser-history-back" type="button" aria-label="返回网页" onClick={() => setBrowserHistoryOpen(false)}><ArrowLeft /></button><div><h2>浏览历史</h2><p>仅保存在这台设备的内置浏览器中</p></div><button type="button" disabled={browserHistory.length === 0} onClick={() => void desktopApi.clearBrowserHistory().then(() => setBrowserHistory([]))}>清除</button></header>
                  <div className="browser-history-list">
                    {browserHistory.length === 0 ? <p className="browser-empty">暂无浏览记录</p> : browserHistory.map((entry) => (
                      <button key={entry.id} type="button" onClick={() => void navigateBrowser(entry.url)}>
                        <Globe2 aria-hidden="true" /><span><strong>{entry.title}</strong><small>{entry.url}</small></span><time>{new Date(entry.visitedAt).toLocaleString()}</time>
                      </button>
                    ))}
                  </div>
                </section>
              ) : state?.browser.url && renderedBrowserViewport ? (
                <div className="browser-device-stage">
                  <div className="browser-device-frame" style={{ width: Math.round(renderedBrowserViewport.width * browserDeviceScale) + BROWSER_DEVICE_FRAME_GUTTER * 2, height: browserDeviceRenderedHeight + BROWSER_DEVICE_FRAME_GUTTER * 2 }}>
                    <div ref={browserViewHost} className="browser-view-host">
                      {browserShellSnapshot ? <img className="browser-shell-snapshot" src={browserShellSnapshot.dataUrl} alt="" aria-hidden="true" style={{ left: browserShellSnapshot.left, top: browserShellSnapshot.top, width: browserShellSnapshot.width, height: browserShellSnapshot.height }} /> : null}
                    </div>
                    {['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map((direction) => <div key={direction} className={`device-resize-handle ${direction}`} onPointerDown={(event) => startDeviceResize(event, direction)} />)}
                  </div>
                </div>
              ) : state?.browser.url ? <div ref={browserViewHost} className="browser-view-host">
                {browserShellSnapshot ? <img className="browser-shell-snapshot" src={browserShellSnapshot.dataUrl} alt="" aria-hidden="true" style={{ left: browserShellSnapshot.left, top: browserShellSnapshot.top, width: browserShellSnapshot.width, height: browserShellSnapshot.height }} /> : null}
              </div> : (
                <section className="browser-welcome"><Globe2 aria-hidden="true" /><h2>内置浏览器</h2><p>在上方输入网址，或让 Agent 在后台打开网页。</p></section>
              )}
            </div>
          </aside>
        ) : null}
      </main>

      <header className="titlebar">
        <button id="title-menu" className="brand" type="button" aria-label="打开应用菜单" aria-expanded={menuOpen} title="应用菜单" onClick={(event) => {
          event.currentTarget.blur()
          setMenuOpen((open) => !open)
        }}>
          <span className="brand-mark-shell" aria-hidden="true"><img className="brand-mark" src={titlebarIconUrl} alt="" draggable="false" /></span><span>DFY DSH Desktop</span><ChevronDown className="menu-chevron" aria-hidden="true" />
        </button>
        <div className="drag-region" aria-hidden="true" />
        {state?.browser.settings.enabled ? (
          <button className="titlebar-browser-button" type="button" aria-label={browserOpen ? '隐藏浏览器侧栏' : '显示浏览器侧栏'} aria-pressed={browserOpen} onClick={() => void desktopApi.setBrowserPanelOpen(!browserOpen)}>
            <BrowserPanelIcon open={browserOpen} />
          </button>
        ) : null}
        <div className="window-controls" aria-hidden={state?.platform === 'macos'}>
          <button id="minimize" className="window-button" type="button" aria-label="最小化" onClick={() => void desktopApi.windowAction('minimize')}><Minus /></button>
          <button id="maximize" className="window-button" type="button" aria-label={state?.isMaximized ? '还原' : '最大化'} onClick={() => void desktopApi.windowAction('toggle-maximize')}>{state?.isMaximized ? <Copy className="restore-icon" /> : <Square className="maximize-icon" />}</button>
          <button id="close" className="window-button close" type="button" aria-label="关闭" onClick={() => void desktopApi.windowAction('close')}><X /></button>
        </div>
      </header>

      {menuOpen && state !== undefined && update !== undefined ? (
        <section id="title-menu-popover" className={`menu-card${shellMenuPresentationPending ? ' shell-overlay-pending' : ''}${browserShellOverlayActive ? ' shell-overlay-synchronized' : ''}`} role="menu" aria-label="DFY DSH Desktop 应用菜单">
          <div className="menu-list">
            <button id="development-action" className="menu-item" type="button" role="menuitem" onClick={(event) => { event.currentTarget.blur(); setMenuOpen(false); setDevelopmentOpen(true) }}><span className="item-label">开发工具</span><span className="item-meta">{patchEnabled ? 'Patch 已启用' : 'Patch 与 CLI'}</span><span className="item-dot" aria-hidden="true" /></button>
            <button id="plugins-action" className="menu-item" type="button" role="menuitem" onClick={(event) => { event.currentTarget.blur(); setMenuOpen(false); setPluginManagerOpen(true) }}><span className="item-label">插件管理</span><span className="item-meta">Profile 与来源</span><span className="item-dot" aria-hidden="true" /></button>
            <button id="update-action" className="menu-item" type="button" role="menuitem" disabled={update.disabled} onClick={(event) => { event.currentTarget.blur(); setMenuOpen(false); setUpdateOpen(true) }}><span id="update-title" className="item-label">{update.title}</span><span className="item-meta">{update.detail}</span><span className={update.dotClass} aria-hidden="true" /></button>
            <button className="menu-item" type="button" role="menuitem" onClick={(event) => { event.currentTarget.blur(); setMenuOpen(false); setReleaseNotesOpen(true) }}><span className="item-label">版本说明与变更记录</span><span className="item-meta">{state.harnessVersion ?? '尚未启动'}</span></button>
          </div>
          <footer className="menu-footer"><span>桌面端版本</span><span id="version-label">{state.appVersion}</span></footer>
        </section>
      ) : null}

      {contextMenu === undefined ? null : (
        <ContextMenu
          menu={contextMenu}
          onSelect={selectContextMenuItem}
          presentationPending={shellMenuPresentationPending}
          presentationSynchronized={browserShellOverlayActive}
        />
      )}

      <Modal open={releaseNotesOpen} labelledBy="release-notes-title" closeLabel="关闭版本说明" onClose={() => { setReleaseNotesOpen(false); requestAnimationFrame(focusHarness) }}>
        <header className="dialog-header">
          <div className="dialog-heading"><img className="dialog-icon" src={appIconUrl} alt="" aria-hidden="true" draggable="false" /><div><h2 id="release-notes-title">版本说明</h2><p>DFY DSH Desktop</p></div></div>
          <button ref={releaseCloseButton} className="dialog-close" type="button" aria-label="关闭版本说明" title="关闭" onClick={() => setReleaseNotesOpen(false)}><X /></button>
        </header>
        <div className="dialog-content">
          <dl className="version-list"><div><dt>当前 Harness</dt><dd>{state?.harnessVersion ?? '尚未启动'}</dd></div><div><dt>桌面端</dt><dd>{state?.appVersion ?? '—'}</dd></div>{availableUpdate ? <div><dt>可用更新</dt><dd>{state?.updateVersion}</dd></div> : null}</dl>
          <p className="dialog-note">当前 Harness 的版本说明和完整变更记录可在 DeepSeek Harness 官方 GitHub Release 页面查看。</p>
        </div>
        <footer className="dialog-actions"><button className="dialog-button secondary" type="button" onClick={() => setReleaseNotesOpen(false)}>关闭</button><button className="dialog-button primary" type="button" onClick={(event) => { event.currentTarget.blur(); void desktopApi.titleMenuAction('open-changes') }}>查看官方 Release</button></footer>
      </Modal>

      {state !== undefined ? <HarnessUpdatePanel open={updateOpen} state={state} onClose={() => { setUpdateOpen(false); requestAnimationFrame(focusHarness) }} /> : null}
      {state !== undefined ? <PluginManager open={pluginManagerOpen} harnessReady={ready} restarting={state.development.restarting} onClose={() => { setPluginManagerOpen(false); requestAnimationFrame(focusHarness) }} /> : null}
      {state !== undefined ? <DevelopmentPanel open={developmentOpen} state={state.development} harnessUrl={state.harnessUrl} disabledPlugins={state.disabledPlugins} onClose={() => { setDevelopmentOpen(false); requestAnimationFrame(focusHarness) }} /> : null}
    </>
  )
}
