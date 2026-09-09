import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  Maximize2,
  Minimize2,
  MoreVertical,
  Plus,
  RotateCw,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type {
  BrowserDisplayMode,
  DesktopBrowserTabState,
  DesktopBrowserViewport,
  FloatingBrowserWindowState,
} from '../shared/contracts.js'
import { AgentPointerIcon } from './AgentPointerIcon.js'
import { BrowserAddressInput } from './BrowserAddressInput.js'

const EMPTY_STATE: FloatingBrowserWindowState = {
  loading: false,
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  maximized: false,
  displayMode: 'floating',
  zoomFactor: 1,
  viewport: null,
  viewBounds: null,
  tabs: [],
}

function invoke<T = void>(action: string, value?: unknown): Promise<T> {
  return window.floatingBrowser.invoke<T>(action, value)
}

function DisplayModeIcon({ mode }: { mode: BrowserDisplayMode }): React.JSX.Element {
  if (mode === 'floating') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/></svg>
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d={mode === 'split' ? 'M12 4v16' : 'M14 4v16'}/></svg>
}

function TabFavicon({ url }: { url?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return (
    <span className="floating-tab-favicon">
      <Globe2 aria-hidden="true" />
      {url !== undefined && !failed ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : null}
    </span>
  )
}

function BrowserTab({ tab, active }: { tab: DesktopBrowserTabState; active: boolean }): React.JSX.Element {
  const label = tab.url ? tab.title || tab.url : tab.sessionBound ? 'Agent 浏览器' : '新标签页'
  const tabRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) tabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div ref={tabRef} className={`floating-tab${active ? ' active' : ''}`} title={label}>
      <button
        type="button"
        className="floating-tab-main"
        role="tab"
        aria-selected={active}
        onClick={() => void invoke('select-tab', tab.id)}
      >
        {tab.loading ? <RotateCw className="floating-tab-loading" aria-label="正在加载" /> : <TabFavicon url={tab.faviconUrl} />}
        <span className="floating-tab-title">{label}</span>
        {tab.agentActive ? <AgentPointerIcon className="agent-pointer" /> : null}
      </button>
      <button type="button" className="floating-tab-close" aria-label={`关闭 ${label}`} onClick={() => void invoke('close-tab', tab.id)}>
        <X aria-hidden="true" />
      </button>
    </div>
  )
}

function DeviceResizeHandles({ state }: { state: FloatingBrowserWindowState }): React.JSX.Element | null {
  if (state.viewport === null || state.viewBounds === null) return null
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const viewport = state.viewport
    const viewBounds = state.viewBounds
    if (viewport === null || viewBounds === null) return
    const handle = event.currentTarget
    const direction = handle.dataset.direction ?? ''
    event.preventDefault()
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    const startX = event.clientX
    const startY = event.clientY
    const maxWidth = Math.max(240, Math.floor(window.innerWidth - 72))
    const maxHeight = Math.max(240, Math.floor(window.innerHeight - 90 - 44 - 72))
    const startWidth = Math.min(viewport.width, maxWidth)
    const startHeight = Math.min(viewport.height, maxHeight)
    const scale = Math.max(.1, viewBounds.width / viewport.width)
    let nextWidth = startWidth
    let nextHeight = startHeight
    let frame = 0
    const commit = (): void => {
      frame = 0
      void invoke('set-device-viewport', {
        width: Math.max(240, Math.min(maxWidth, Math.round(nextWidth))),
        height: Math.max(240, Math.min(maxHeight, Math.round(nextHeight))),
      })
    }
    const move = (pointer: PointerEvent): void => {
      const dx = (pointer.clientX - startX) / scale
      const dy = (pointer.clientY - startY) / scale
      if (direction.includes('e')) nextWidth = startWidth + dx
      if (direction.includes('w')) nextWidth = startWidth - dx
      if (direction.includes('s')) nextHeight = startHeight + dy
      if (direction.includes('n')) nextHeight = startHeight - dy
      if (frame === 0) frame = requestAnimationFrame(commit)
    }
    const finish = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        commit()
      }
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  const style = {
    left: state.viewBounds.x,
    top: state.viewBounds.y,
    width: state.viewBounds.width,
    height: state.viewBounds.height,
  }
  return (
    <div className="device-outline" style={style} aria-hidden="true">
      {['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map((direction) => (
        <div key={direction} className={`resize-handle ${direction}`} data-direction={direction} onPointerDown={startResize} />
      ))}
    </div>
  )
}

function DeviceToolbar({ viewport, zoomFactor }: { viewport: DesktopBrowserViewport; zoomFactor: number }): React.JSX.Element {
  const widthRef = useRef<HTMLInputElement>(null)
  const heightRef = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(String(viewport.width))
  const [height, setHeight] = useState(String(viewport.height))
  useEffect(() => {
    if (document.activeElement !== widthRef.current) setWidth(String(viewport.width))
    if (document.activeElement !== heightRef.current) setHeight(String(viewport.height))
  }, [viewport.height, viewport.width])
  const setViewport = (next: DesktopBrowserViewport | null): void => { void invoke('set-device-viewport', next) }
  const commit = (): void => {
    const nextWidth = Math.max(240, Math.min(3840, Math.round(Number(width))))
    const nextHeight = Math.max(240, Math.min(2160, Math.round(Number(height))))
    if (Number.isFinite(nextWidth) && Number.isFinite(nextHeight)) setViewport({ width: nextWidth, height: nextHeight })
  }
  return (
    <div className="device-toolbar">
      <strong>尺寸:</strong>
      <span>响应式</span>
      <input ref={widthRef} type="number" min="240" max="3840" aria-label="设备宽度" value={width} onChange={(event) => setWidth(event.target.value)} onBlur={commit} />
      <span>×</span>
      <input ref={heightRef} type="number" min="240" max="2160" aria-label="设备高度" value={height} onChange={(event) => setHeight(event.target.value)} onBlur={commit} />
      <button type="button" aria-label="旋转设备" onClick={() => setViewport({ width: viewport.height, height: viewport.width })}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect width="10" height="14" x="3" y="8" rx="2"/><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4"/><path d="M8 18h.01"/></svg>
      </button>
      <span>{Math.round(zoomFactor * 100)}%</span>
      <button type="button" className="close-device" aria-label="关闭设备工具栏" onClick={() => setViewport(null)}><X aria-hidden="true" /></button>
    </div>
  )
}

export function BrowserWindowApp(): React.JSX.Element {
  const [state, setState] = useState<FloatingBrowserWindowState>(EMPTY_STATE)

  useEffect(() => {
    const dispose = window.floatingBrowser.onState(setState)
    void invoke('ready')
    return dispose
  }, [])
  useEffect(() => {
    document.title = state.title && state.url ? `${state.title} - DFY DSH Desktop 浏览器` : 'DFY DSH Desktop 浏览器'
  }, [state.title, state.url])
  const openMenu = (kind: 'display' | 'settings', button: HTMLButtonElement): void => {
    const rect = button.getBoundingClientRect()
    button.blur()
    void invoke('open-menu', { kind, anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
  }

  return (
    <main className="browser-window">
      <header className="browser-chrome">
        <div className="tabbar">
          <div className="floating-tabs" role="tablist" aria-label="浏览器标签页">
            {state.tabs.map((tab) => <BrowserTab key={tab.id} tab={tab} active={state.activeTabId === tab.id} />)}
            <button type="button" className="floating-new-tab" aria-label="新增标签页" title="新增标签页" onClick={() => void invoke('new-tab')}><Plus aria-hidden="true" /></button>
          </div>
          <div className="panel-controls">
            <button type="button" aria-label={state.maximized ? '还原窗口' : '最大化窗口'} title={state.maximized ? '还原窗口' : '最大化窗口'} onClick={(event) => { event.currentTarget.blur(); void invoke('maximize') }}>
              {state.maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            <button type="button" aria-label="选择浏览器显示方式" title={`显示方式：${state.displayMode}`} onClick={(event) => openMenu('display', event.currentTarget)}><DisplayModeIcon mode={state.displayMode} /></button>
            <button type="button" aria-label="隐藏浏览器" title="隐藏浏览器" onClick={() => void invoke('hide')}>
              <svg viewBox="0 0 24 24" strokeWidth="1.55" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M14.5 4.5v15" strokeLinecap="square"/></svg>
            </button>
          </div>
        </div>
        <div className="toolbar">
          <button type="button" aria-label="后退" disabled={!state.canGoBack} onClick={() => void invoke('back')}><ArrowLeft aria-hidden="true" /></button>
          <button type="button" aria-label="前进" disabled={!state.canGoForward} onClick={() => void invoke('forward')}><ArrowRight aria-hidden="true" /></button>
          <button type="button" className={state.loading ? 'loading' : ''} aria-label={state.loading ? '停止加载' : '重新加载'} onClick={() => void invoke('reload')}><RotateCw aria-hidden="true" /></button>
          <BrowserAddressInput className="address" url={state.url} onNavigate={(address) => invoke('navigate', address)} />
          <button type="button" aria-label="浏览器设置" onClick={(event) => openMenu('settings', event.currentTarget)}><MoreVertical aria-hidden="true" /></button>
        </div>
        {state.viewport === null ? null : <DeviceToolbar viewport={state.viewport} zoomFactor={state.zoomFactor} />}
      </header>
      <DeviceResizeHandles state={state} />
    </main>
  )
}
