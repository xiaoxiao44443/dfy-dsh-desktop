import {
  Archive,
  ArrowLeft,
  Check,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Folder,
  History,
  Link,
  Monitor,
  MousePointer2,
  Pencil,
  Puzzle,
  Redo2,
  RefreshCw,
  Scissors,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ContextMenuIcon } from '../shared/context-menu.js'
import type {
  BrowserDisplayMode,
  BrowserMenuWindowPayload,
  DesktopApplicationMenuAction,
} from '../shared/contracts.js'

const contextIcons: Record<ContextMenuIcon, LucideIcon> = {
  copy: Copy,
  cut: Scissors,
  paste: ClipboardPaste,
  undo: Undo2,
  redo: Redo2,
  'select-all': MousePointer2,
  'external-link': ExternalLink,
  browser: Monitor,
  link: Link,
  plugin: Puzzle,
  archive: Archive,
  trash: Trash2,
  edit: Pencil,
  folder: Folder,
  settings: Settings,
  terminal: Terminal,
  sparkles: Sparkles,
  refresh: RefreshCw,
}

function invoke<T = void>(action: string, value?: unknown): Promise<T> {
  return window.browserMenu.invoke<T>(action, value)
}

function DisplayModeIcon({ mode }: { mode: BrowserDisplayMode }): React.JSX.Element {
  if (mode === 'floating') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/></svg>
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d={mode === 'split' ? 'M12 4v16' : 'M14 4v16'}/></svg>
}

function Separator(): React.JSX.Element {
  return <div className="menu-separator" role="separator" />
}

interface MenuItemProps {
  label: string
  icon?: ReactNode
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  compact?: boolean
  onClick: () => void
}

function MenuItem({ label, icon, checked, disabled, danger, compact, onClick }: MenuItemProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`menu-item${compact === true ? ' context-item' : ''}${danger === true ? ' danger' : ''}`}
      disabled={disabled === true}
      {...(checked === undefined ? {} : { 'aria-checked': checked })}
      onClick={onClick}
    >
      <span className="menu-icon">{checked === true && compact === true ? <Check aria-hidden="true" /> : icon}</span>
      <span className="menu-label">{label}</span>
      {compact === true ? null : <span className="menu-check">{checked === true ? <Check aria-hidden="true" /> : null}</span>}
    </button>
  )
}

function DisplayMenu({ payload }: { payload: BrowserMenuWindowPayload }): React.JSX.Element {
  const current = payload.state.settings.displayMode
  return (
    <>
      {(['split', 'drawer', 'floating'] as const).map((mode) => (
        <MenuItem
          key={mode}
          label={mode === 'split' ? '分栏' : mode === 'drawer' ? '抽屉' : '独立窗口'}
          icon={<DisplayModeIcon mode={mode} />}
          checked={current === mode}
          onClick={() => void invoke('set-mode', mode)}
        />
      ))}
    </>
  )
}

function SettingsMenu({ payload, showHistory }: { payload: BrowserMenuWindowPayload; showHistory: () => void }): React.JSX.Element {
  const zoom = payload.state.zoomFactor
  const viewportVisible = payload.state.viewport !== undefined
  return (
    <>
      <MenuItem label="历史记录" icon={<History aria-hidden="true" />} onClick={showHistory} />
      <MenuItem label="清除浏览数据" icon={<Trash2 aria-hidden="true" />} onClick={() => void invoke('clear-data')} />
      <Separator />
      <div className="zoom-row">
        <span>缩放</span>
        <button type="button" aria-label="缩小" disabled={zoom <= .5} onClick={() => void invoke('set-zoom', zoom - .1)}>−</button>
        <strong>{Math.round(zoom * 100)}%</strong>
        <button type="button" aria-label="放大" disabled={zoom >= 2} onClick={() => void invoke('set-zoom', zoom + .1)}>+</button>
        <button type="button" aria-label="重置缩放" title="重置" disabled={zoom === 1} onClick={() => void invoke('set-zoom', 1)}><RefreshCw aria-hidden="true" /></button>
      </div>
      <Separator />
      <MenuItem
        label={viewportVisible ? '隐藏设备工具栏' : '显示设备工具栏'}
        icon={<Monitor aria-hidden="true" />}
        disabled={payload.state.url.length === 0}
        onClick={() => void invoke('set-device-viewport', viewportVisible ? null : { width: 583, height: 860 })}
      />
    </>
  )
}

function HistoryMenu({ payload, goBack }: { payload: BrowserMenuWindowPayload; goBack: () => void }): React.JSX.Element {
  return (
    <>
      <div className="history-head">
        <button type="button" className="icon-button" aria-label="返回浏览器设置" onClick={goBack}><ArrowLeft aria-hidden="true" /></button>
        <strong>历史记录</strong>
        <span />
      </div>
      <Separator />
      <div className="history-list">
        {payload.history.length === 0 ? <p className="menu-empty">暂无浏览记录</p> : payload.history.slice(0, 30).map((entry) => (
          <button key={entry.id} type="button" className="history-entry" onClick={() => void invoke('navigate', entry.url)}>
            <strong>{entry.title || entry.url}</strong>
            <small>{entry.url}</small>
          </button>
        ))}
      </div>
    </>
  )
}

function ApplicationMenu({ payload }: { payload: BrowserMenuWindowPayload }): React.JSX.Element | null {
  const application = payload.application
  if (application === undefined) return null
  const status = application.updateStatus
  const updateTitle = 'Harness 更新'
  const updateMeta = status === 'ready' ? `待应用 ${application.updateVersion ?? ''}`.trim()
    : status === 'available' ? `最新 ${application.updateLatestVersion ?? application.updateVersion ?? ''}`.trim()
      : status === 'checking' ? '正在检查…'
        : status === 'downloading' ? `下载 ${application.updateProgress ?? 0}%`
          : status === 'current' ? '已是最新'
            : status === 'error' ? '检查失败'
              : '版本与下载'
  const updateDot = status === 'current' || status === 'ready' ? 'ready'
    : status === 'available' ? 'available'
    : status === 'checking' || status === 'downloading' ? 'busy'
      : status === 'error' ? 'error'
        : ''
  const desktopStatus = application.desktopUpdate.status
  const desktopUpdateMeta = desktopStatus === 'ready' ? '安装包已就绪'
    : desktopStatus === 'available' ? `可更新 ${application.desktopUpdate.version ?? ''}`.trim()
      : desktopStatus === 'checking' ? '正在检查…'
        : desktopStatus === 'downloading' ? `下载 ${application.desktopUpdate.progress ?? 0}%`
          : desktopStatus === 'current' ? application.appVersion
            : desktopStatus === 'error' ? '检查失败'
              : application.appVersion
  const desktopUpdateDot = desktopStatus === 'ready' ? 'ready'
    : desktopStatus === 'available' ? 'available'
      : desktopStatus === 'checking' || desktopStatus === 'downloading' ? 'busy'
        : desktopStatus === 'error' ? 'error'
          : ''
  const item = (label: string, meta: string, action: DesktopApplicationMenuAction, disabled = false, dot = ''): React.JSX.Element => (
    <button key={action} type="button" className="application-item" disabled={disabled} onClick={() => void invoke('application-action', action)}>
      <span>{label}</span><span className="application-meta">{meta}</span><span className={`application-dot${dot.length > 0 ? ` ${dot}` : ''}`} />
    </button>
  )
  return (
    <div className="application-menu">
      <div className="application-list">
        {item('开发工具', application.patchEnabled ? 'Patch 已启用' : 'Patch 与 CLI', 'development')}
        {item('插件管理', 'Profile 与来源', 'plugins')}
        {item(updateTitle, updateMeta, 'update', false, updateDot)}
        {item('版本说明与变更记录', application.harnessVersion ?? '尚未启动', 'release-notes')}
      </div>
      <footer className="application-footer"><button type="button" aria-label={`桌面端更新，${desktopUpdateMeta}`} onClick={() => void invoke('application-action', 'desktop-update')}><span>桌面端版本</span><span className="application-footer-meta"><span>{desktopUpdateMeta}</span>{desktopUpdateDot.length === 0 ? null : <span className={`application-dot ${desktopUpdateDot}`} />}</span></button></footer>
    </div>
  )
}

function ContextMenu({ payload }: { payload: BrowserMenuWindowPayload }): React.JSX.Element | null {
  const context = payload.context
  if (context === undefined) return null
  return (
    <>
      {context.items.map((entry) => {
        if (entry.kind === 'separator') return <Separator key={entry.id} />
        const Icon = entry.icon === undefined ? undefined : contextIcons[entry.icon]
        return (
          <MenuItem
            key={entry.id}
            label={entry.label}
            icon={Icon === undefined ? null : <Icon aria-hidden="true" />}
            checked={entry.checked}
            disabled={!entry.enabled}
            danger={entry.danger}
            compact
            onClick={() => void window.browserMenu.selectContextMenuItem({ requestId: context.requestId, itemId: entry.id })}
          />
        )
      })}
    </>
  )
}

export function BrowserMenuApp(): React.JSX.Element | null {
  const [payload, setPayload] = useState<BrowserMenuWindowPayload>()
  const [settingsView, setSettingsView] = useState<'settings' | 'history'>('settings')
  const cardRef = useRef<HTMLDivElement>(null)
  const reportedToken = useRef<number | undefined>(undefined)

  useEffect(() => {
    const dispose = window.browserMenu.onState((next) => {
      setSettingsView('settings')
      setPayload(next)
    })
    void invoke('menu-ready')
    return dispose
  }, [])

  useLayoutEffect(() => {
    if (payload === undefined || cardRef.current === null) return
    const frame = requestAnimationFrame(() => {
      const contextHeight = Math.max(40, Math.ceil(cardRef.current?.scrollHeight ?? 40))
      const size = payload.kind === 'application' ? { width: 326, height: 150 }
        : payload.kind === 'display' ? { width: 220, height: 116 }
          : payload.kind === 'settings' && settingsView === 'history' ? { width: 272, height: 360 }
            : payload.kind === 'settings' ? { width: 272, height: 210 }
              : { width: 212, height: contextHeight }
      void invoke('resize-menu', size)
      if (payload.renderToken !== undefined && reportedToken.current !== payload.renderToken) {
        reportedToken.current = payload.renderToken
        requestAnimationFrame(() => void invoke('menu-rendered', payload.renderToken))
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [payload, settingsView])

  useEffect(() => {
    const pointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node) || cardRef.current?.contains(target) === true) return
      if (event.button === 2) return
      if (payload?.kind === 'context' && payload.context !== undefined) {
        void window.browserMenu.dismissContextMenu(payload.context.requestId, true)
      } else void invoke('dismiss-menu')
    }
    const contextMenu = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node) || cardRef.current?.contains(target) === true) return
      event.preventDefault()
      void invoke('reopen-context-menu', { x: event.clientX, y: event.clientY })
    }
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (payload?.kind === 'context' && payload.context !== undefined) {
        void window.browserMenu.dismissContextMenu(payload.context.requestId, true)
      } else void invoke('dismiss-menu')
    }
    document.addEventListener('pointerdown', pointerDown)
    document.addEventListener('contextmenu', contextMenu)
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('pointerdown', pointerDown)
      document.removeEventListener('contextmenu', contextMenu)
      document.removeEventListener('keydown', keyDown)
    }
  }, [payload])

  if (payload === undefined) return null
  const content = payload.kind === 'context' ? <ContextMenu payload={payload} />
    : payload.kind === 'application' ? <ApplicationMenu payload={payload} />
      : payload.kind === 'display' ? <DisplayMenu payload={payload} />
        : settingsView === 'history' ? <HistoryMenu payload={payload} goBack={() => setSettingsView('settings')} />
          : <SettingsMenu payload={payload} showHistory={() => setSettingsView('history')} />
  return <div ref={cardRef} className={`browser-menu-card kind-${payload.kind}`}>{content}</div>
}
