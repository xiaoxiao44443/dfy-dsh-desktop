import { ipcRenderer } from 'electron'

const CHANNEL = 'desktop-browser:pointer'
const MENU_CHANNEL = 'desktop-browser:page-menu'
const MENU_ACTION_CHANNEL = 'desktop-browser:page-menu-action'
const HOST_ID = 'dsh-desktop-browser-pointer'

interface PointerMessage {
  x?: unknown
  y?: unknown
  pressed?: unknown
  hidden?: unknown
  theme?: unknown
}

let pointerBody: HTMLElement | undefined
let pointerAnimation: Animation | undefined
let pointerPosition: { x: number; y: number } | undefined
let pointerPressed = false
let pointerDragged = false
let pageMenuHost: HTMLElement | undefined

function cancelPointerAnimation(): void {
  pointerAnimation?.cancel()
  pointerAnimation = undefined
}

function animatePointerClick(pointer: HTMLElement): void {
  cancelPointerAnimation()
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // A short rotation wave with a smooth envelope, returning exactly to rest.
  // It paints feedback only; no additional input or delay is sent to the page.
  const duration = 1410
  const frames = Array.from({ length: 86 }, (_, index) => {
    const progress = index / 85
    const angle = index === 0 || index === 85 ? 0
      : 12.5 * Math.sin(progress * duration / 660 * Math.PI * 2) * Math.sin(progress * Math.PI)
    return { offset: progress, transform: `rotate(${String(angle)}deg)` }
  })
  const animation = pointer.animate(frames, { duration, easing: 'linear' })
  pointerAnimation = animation
  animation.onfinish = () => {
    if (pointerAnimation === animation) pointerAnimation = undefined
  }
}

function installPointer(): HTMLElement | undefined {
  const root = document.documentElement
  if (root === null) return undefined
  cancelPointerAnimation()
  pointerPosition = undefined
  pointerPressed = false
  pointerDragged = false
  document.getElementById(HOST_ID)?.remove()
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('aria-hidden', 'true')
  host.style.setProperty('all', 'initial', 'important')
  host.style.setProperty('position', 'fixed', 'important')
  host.style.setProperty('left', '0', 'important')
  host.style.setProperty('top', '0', 'important')
  host.style.setProperty('width', '16px', 'important')
  host.style.setProperty('height', '16px', 'important')
  host.style.setProperty('z-index', '2147483647', 'important')
  host.style.setProperty('pointer-events', 'none', 'important')
  host.style.setProperty('overflow', 'visible', 'important')
  host.style.setProperty('opacity', '0', 'important')
  host.style.setProperty('transform', 'translate3d(-40px,-40px,0)', 'important')
  host.style.setProperty('transition', 'opacity 90ms ease, filter 90ms ease', 'important')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host{--pointer-fill:#05070a;--pointer-stroke:rgba(255,255,255,.94);--pointer-glow:rgba(2,133,255,.9);--pointer-glow-soft:rgba(2,133,255,.48)}
    :host([data-theme="dark"]){--pointer-glow:rgba(75,183,255,.9);--pointer-glow-soft:rgba(75,183,255,.48)}
    .pointer{width:16px;height:16px;color:var(--pointer-fill);transform-origin:2.2px 2.2px;filter:drop-shadow(0 0 6px var(--pointer-glow)) drop-shadow(0 0 15px var(--pointer-glow-soft))}
    .pointer svg{display:block;overflow:visible}
    @media(prefers-color-scheme:dark){:host(:not([data-theme="light"])){--pointer-glow:rgba(75,183,255,.9);--pointer-glow-soft:rgba(75,183,255,.48)}}
  `
  const pointer = document.createElement('div')
  pointer.className = 'pointer'
  pointer.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg"><path d="M17.2607 12.4008C19.3774 11.2626 20.4357 10.6935 20.7035 10.0084C20.9359 9.41393 20.8705 8.74423 20.5276 8.20587C20.1324 7.58551 18.984 7.23176 16.6872 6.52425L8.00612 3.85014C6.06819 3.25318 5.09923 2.95471 4.45846 3.19669C3.90068 3.40733 3.46597 3.85584 3.27285 4.41993C3.051 5.06794 3.3796 6.02711 4.03681 7.94545L6.94793 16.4429C7.75632 18.8025 8.16052 19.9824 8.80519 20.3574C9.36428 20.6826 10.0461 20.7174 10.6354 20.4507C11.3149 20.1432 11.837 19.0106 12.8813 16.7454L13.6528 15.0719C13.819 14.7113 13.9021 14.531 14.0159 14.3736C14.1168 14.2338 14.2354 14.1078 14.3686 13.9984C14.5188 13.8752 14.6936 13.7812 15.0433 13.5932L17.2607 12.4008Z" fill="currentColor" stroke="var(--pointer-stroke)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" paint-order="stroke fill"/></svg>'
  pointerBody = pointer
  shadow.append(style, pointer)
  root.appendChild(host)
  return host
}

let pointerHost: HTMLElement | undefined

function ensurePointer(): HTMLElement | undefined {
  if (pointerHost?.isConnected === true) return pointerHost
  pointerHost = installPointer()
  return pointerHost
}

ipcRenderer.on(CHANNEL, (_event, raw: PointerMessage) => {
  const host = ensurePointer()
  if (host === undefined) return
  if (raw.theme === 'dark' || raw.theme === 'light') host.dataset.theme = raw.theme
  if (raw.hidden === true) {
    cancelPointerAnimation()
    pointerPosition = undefined
    pointerPressed = false
    pointerDragged = false
    host.style.setProperty('opacity', '0', 'important')
    return
  }
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return
  host.style.setProperty('transform', `translate3d(${String(Math.round(raw.x))}px,${String(Math.round(raw.y))}px,0)`, 'important')
  host.style.setProperty('opacity', '1', 'important')
  if (pointerBody === undefined) return
  const pressed = raw.pressed === true
  const moved = pointerPosition !== undefined && (pointerPosition.x !== raw.x || pointerPosition.y !== raw.y)
  if (pressed && !pointerPressed) pointerDragged = false
  if (moved && pointerPressed) pointerDragged = true
  if (moved || pressed) cancelPointerAnimation()
  if (pointerPressed && !pressed && !pointerDragged) animatePointerClick(pointerBody)
  pointerPosition = { x: raw.x, y: raw.y }
  pointerPressed = pressed
})

interface PageMenuPayload {
  kind?: unknown
  state?: {
    settings?: { displayMode?: unknown }
    url?: unknown
    zoomFactor?: unknown
    viewport?: { width?: unknown; height?: unknown }
  }
  history?: Array<{ url?: unknown; title?: unknown }>
}

function closePageMenu(): void {
  pageMenuHost?.remove()
  pageMenuHost = undefined
}

function menuIcon(path: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`
}

function installPageMenu(payload: PageMenuPayload): void {
  closePageMenu()
  const kind = payload.kind === 'display' ? 'display' : 'settings'
  const state = payload.state ?? {}
  const displayMode = state.settings?.displayMode === 'drawer' || state.settings?.displayMode === 'floating' ? state.settings.displayMode : 'split'
  const zoomFactor = typeof state.zoomFactor === 'number' ? state.zoomFactor : 1
  const viewport = state.viewport
  const hasViewport = typeof viewport?.width === 'number' && typeof viewport.height === 'number'
  const hasPage = typeof state.url === 'string' && state.url.length > 0
  const host = document.createElement('div')
  const shadow = host.attachShadow({ mode: 'closed' })
  const stylesheet = new CSSStyleSheet()
  stylesheet.replaceSync(`
    :host{all:initial;position:fixed;z-index:2147483647;top:12px;right:12px;width:max-content;max-width:calc(100vw - 24px);pointer-events:auto;color-scheme:light dark;--bg:rgba(249,250,252,.94);--text:#282d35;--muted:#747b87;--hover:rgba(36,42,52,.085);--active:rgba(36,42,52,.13);--border:rgba(31,36,45,.15);font-family:Inter,"Segoe UI Variable","Microsoft YaHei UI",sans-serif}
    *{box-sizing:border-box}.card{display:grid;width:max-content;min-width:176px;max-width:min(310px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:4px;color:var(--text);border:1px solid var(--border);border-radius:8px;background:var(--bg);box-shadow:0 20px 48px rgba(0,0,0,.32),0 5px 14px rgba(0,0,0,.18),inset 0 1px rgba(255,255,255,.09);backdrop-filter:blur(16px) saturate(1.45);animation:enter 110ms cubic-bezier(.2,.76,.28,1) both}
    button{font:inherit}.item{display:grid;width:100%;min-height:31px;grid-template-columns:16px minmax(0,1fr) 16px;align-items:center;gap:7px;padding:0 8px;color:var(--text);text-align:left;border:0;border-radius:6px;background:transparent;font-size:12.5px}.item:hover:not(:disabled),.icon:hover:not(:disabled){background:var(--hover)}.item:active:not(:disabled){background:var(--active)}.item:disabled{opacity:.42}.item svg,.icon svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;color:var(--muted)}.check{opacity:0}.item[aria-checked=true] .check{opacity:1;color:var(--text)}.separator{height:1px;margin:3px 6px;background:var(--border)}
    .zoom{display:grid;min-height:36px;grid-template-columns:minmax(0,1fr) 26px 48px 26px 26px;align-items:center;gap:2px;padding:0 8px;color:var(--text);font-size:12.5px}.icon{display:grid;width:26px;height:26px;place-items:center;padding:0;color:var(--muted);border:0;border-radius:6px;background:transparent}.zoom strong{text-align:center;font-weight:500}.head{display:grid;height:36px;grid-template-columns:28px 1fr 28px;align-items:center;padding:0 4px;color:var(--text);font-size:13px;font-weight:600}.head .icon{width:28px;height:28px}.history{display:grid;max-width:300px;gap:2px}.history button{display:block;width:100%;height:auto;padding:7px 8px;text-align:left}.history strong,.history small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history strong{font-size:12.5px;font-weight:500}.history small{margin-top:3px;color:var(--muted);font-size:11px}.empty{padding:18px 8px;color:var(--muted);text-align:center;font-size:12px}@keyframes enter{from{opacity:0;transform:translateY(-2px) scale(.975)}to{opacity:1;transform:none}}
    @media(prefers-color-scheme:dark){:host{--bg:rgba(34,36,41,.96);--text:#f0f1f4;--muted:#aaaeb8;--hover:rgba(255,255,255,.085);--active:rgba(255,255,255,.13);--border:rgba(255,255,255,.14)}}`)
  shadow.adoptedStyleSheets = [stylesheet]
  const card = document.createElement('div')
  card.className = 'card'
  shadow.append(card)

  const invoke = (action: string, value?: unknown): void => { closePageMenu(); void ipcRenderer.invoke(MENU_ACTION_CHANNEL, action, value) }
  const item = (label: string, icon: string, action: () => void, checked?: boolean, disabled = false): HTMLButtonElement => {
    const button = document.createElement('button')
    button.className = 'item'
    button.disabled = disabled
    if (checked !== undefined) button.setAttribute('aria-checked', String(checked))
    button.innerHTML = `${icon}<span>${label}</span>${menuIcon('<path class="check" d="m5 12 4 4L19 6"/>')}`
    button.addEventListener('click', action)
    return button
  }
  const separator = (): HTMLDivElement => { const node = document.createElement('div'); node.className = 'separator'; return node }

  const renderHistory = (): void => {
    card.replaceChildren()
    const head = document.createElement('div')
    head.className = 'head'
    head.innerHTML = `<button class="icon" aria-label="返回">${menuIcon('<path d="m15 18-6-6 6-6"/>')}</button><span>历史记录</span><span></span>`
    head.querySelector('button')?.addEventListener('click', () => installPageMenu({ ...payload, kind: 'settings' }))
    card.append(head, separator())
    const list = document.createElement('div')
    list.className = 'history'
    const entries = Array.isArray(payload.history) ? payload.history : []
    if (entries.length === 0) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '暂无浏览记录'; list.append(empty) }
    else entries.slice(0, 30).forEach((entry) => {
      if (typeof entry.url !== 'string') return
      const button = document.createElement('button')
      button.className = 'item'
      button.innerHTML = `<strong></strong><small></small>`
      const strong = button.querySelector('strong'); const small = button.querySelector('small')
      if (strong !== null) strong.textContent = typeof entry.title === 'string' && entry.title ? entry.title : entry.url
      if (small !== null) small.textContent = entry.url
      button.addEventListener('click', () => invoke('navigate', entry.url))
      list.append(button)
    })
    card.append(list)
  }

  if (kind === 'display') {
    card.append(
      item('分栏', menuIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'), () => invoke('set-mode', 'split'), displayMode === 'split'),
      item('抽屉', menuIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>'), () => invoke('set-mode', 'drawer'), displayMode === 'drawer'),
      item('独立窗口', menuIcon('<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>'), () => invoke('set-mode', 'floating'), displayMode === 'floating'),
    )
  } else {
    card.append(
      item('历史记录', menuIcon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'), renderHistory),
      item('清除浏览数据', menuIcon('<path d="M3 6h18M8 6V4h8v2M7 6l1 14h8l1-14"/>'), () => invoke('clear-data')),
      separator(),
    )
    const zoom = document.createElement('div')
    zoom.className = 'zoom'
    zoom.innerHTML = `<span>缩放</span><button class="icon" aria-label="缩小">−</button><strong>${String(Math.round(zoomFactor * 100))}%</strong><button class="icon" aria-label="放大">+</button><button class="icon" aria-label="重置">${menuIcon('<path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"/>')}</button>`
    const buttons = zoom.querySelectorAll('button')
    buttons[0]?.addEventListener('click', () => invoke('set-zoom', zoomFactor - .1))
    buttons[1]?.addEventListener('click', () => invoke('set-zoom', zoomFactor + .1))
    buttons[2]?.addEventListener('click', () => invoke('set-zoom', 1))
    card.append(zoom, separator(), item(hasViewport ? '隐藏设备工具栏' : '显示设备工具栏', menuIcon('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>'), () => invoke('set-device-viewport', hasViewport ? null : { width: 583, height: 860 }), undefined, !hasPage))
  }
  pageMenuHost = host
  document.documentElement.append(host)
}

ipcRenderer.on(MENU_CHANNEL, (_event, payload: PageMenuPayload) => installPageMenu(payload))
document.addEventListener('pointerdown', (event) => {
  if (pageMenuHost !== undefined && !event.composedPath().includes(pageMenuHost)) closePageMenu()
  void ipcRenderer.invoke(MENU_ACTION_CHANNEL, 'dismiss-menu')
}, true)

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { pointerHost = installPointer() }, { once: true })
} else {
  pointerHost = installPointer()
}
