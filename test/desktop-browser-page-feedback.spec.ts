import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserTabRuntime } from '../src/main/desktop-browser-types.js'

vi.mock('electron', () => ({
  app: {}, BrowserWindow: class {}, WebContentsView: class {}, clipboard: {}, ipcMain: {}, nativeImage: {}, session: {}, shell: {},
}))

import { DesktopBrowserService } from '../src/main/desktop-browser.js'

interface TestAccess {
  panelOpen: boolean
  activeTabId?: string
  tabs: Map<string, BrowserTabRuntime>
  sessionTabs: Map<string, Set<string>>
  sessionActiveTabs: Map<string, string>
  window: unknown
  changed(): void
  createTab(id: string): Promise<BrowserTabRuntime>
  snapshot(tab: BrowserTabRuntime): Promise<{ snapshot: string }>
  frameSnapshotSections(tab: BrowserTabRuntime): Promise<string[]>
  debuggerCommandFor(tab: BrowserTabRuntime, method: string, parameters: { expression: string }): Promise<unknown>
}

function fixture() {
  const service = new DesktopBrowserService('/unused-browser-test')
  const access = service as unknown as TestAccess
  access.panelOpen = true
  access.window = { isDestroyed: () => false }
  vi.spyOn(access, 'changed').mockImplementation(() => {})
  const create = vi.spyOn(access, 'createTab').mockRejectedValue(new Error('Should not create a replacement tab'))
  const hide = vi.spyOn(service, 'setPanelOpen').mockImplementation(async (open) => { access.panelOpen = open })
  vi.spyOn(service, 'selectTab').mockImplementation(async (id) => { access.activeTabId = id })
  function add(id: string, sessionId?: string) {
    const tab = {
      id, ...(sessionId === undefined ? {} : { sessionId }), title: id, url: 'https://example.com/',
      loading: false, agentActive: false, snapshotVersion: 0, snapshotTargets: new Map(),
      eventWaiters: new Map(), historyTimer: undefined,
      view: { webContents: { isDestroyed: () => false, close: vi.fn(), getURL: () => 'https://example.com/', getTitle: () => id } },
    } as unknown as BrowserTabRuntime
    access.tabs.set(id, tab)
    access.activeTabId = id
    if (sessionId !== undefined) {
      access.sessionTabs.set(sessionId, new Set([...(access.sessionTabs.get(sessionId) ?? []), id]))
      access.sessionActiveTabs.set(sessionId, id)
    }
    return tab
  }
  return { service, access, add, hide, create }
}

describe('agent tab cleanup', () => {
  it.each(['close', 'finalize'])('collapses the panel when %s removes the final global tab', async (action) => {
    const { service, access, add, hide, create } = fixture()
    const tab = add('agent', 'session-a')
    const result = await service.handleAgentRequest({ action, sessionId: 'session-a', tabId: tab.id, keep: [] })
    expect(result).toMatchObject({ ok: true, panelOpen: false })
    expect(access.tabs.size).toBe(0)
    expect(hide).toHaveBeenCalledWith(false)
    expect(create).not.toHaveBeenCalled()
    expect(tab.view.webContents.close).toHaveBeenCalledOnce()
  })

  it('finalizes only the caller session while preserving other sessions and user tabs', async () => {
    const { service, access, add, hide } = fixture()
    const user = add('user')
    const other = add('other', 'session-b')
    add('caller-1', 'session-a')
    add('caller-2', 'session-a')
    const result = await service.handleAgentRequest({ action: 'finalize', sessionId: 'session-a', keep: [] })
    expect(result).toMatchObject({ closed: ['caller-1', 'caller-2'], panelOpen: true })
    expect([...access.tabs.keys()]).toEqual(['user', 'other'])
    expect(hide).not.toHaveBeenCalled()
    expect(user.view.webContents.close).not.toHaveBeenCalled()
    expect(other.view.webContents.close).not.toHaveBeenCalled()
  })

  it('releases a claimed user tab and retains explicitly kept tabs during finalize', async () => {
    const { service, access, add, hide } = fixture()
    const claimed = add('claimed', 'session-a')
    claimed.claimedFromUser = true
    const kept = add('kept', 'session-a')
    const result = await service.handleAgentRequest({ action: 'finalize', sessionId: 'session-a', keep: [{ tabId: kept.id, status: 'handoff' }] })
    expect(result).toMatchObject({ closed: [], released: ['claimed'], panelOpen: true })
    expect(access.tabs.size).toBe(2)
    expect(claimed.sessionId).toBeUndefined()
    expect(kept.sessionId).toBe('session-a')
    expect(hide).not.toHaveBeenCalled()
  })
})

class Element {
  parentElement: Element | null = null
  style: Record<string, string> = {}
  attributes: Record<string, string> = {}
  constructor(readonly tagName: string, readonly innerText: string, public top: number) {}
  get textContent() { return this.innerText }
  getAttribute(name: string) { return this.attributes[name] ?? null }
  hasAttribute(name: string) { return name in this.attributes }
  matches(selector: string) { return selector.split(',').includes(this.tagName.toLowerCase()) }
  getBoundingClientRect() { return { left: 10, top: this.top, width: 100, height: 30, bottom: this.top + 30, right: 110 } }
}

describe('snapshot page feedback', () => {
  it('omits CSS-hidden frames and marks offscreen controls inside rendered frames', async () => {
    const { access, add } = fixture()
    const tab = add('frames', 'session-a')
    const frameElement = Object.assign(new Element('IFRAME', '', 20), { name: 'shown', src: 'https://example.com/frame' })
    const hiddenElement = Object.assign(new Element('IFRAME', '', 40), { name: 'hidden', src: 'https://example.com/hidden' })
    hiddenElement.style.display = 'none'
    const control = new Element('BUTTON', 'Frame bottom action', 900)
    const style = (element: Element) => ({ display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible', ...element.style })
    const parentRuntime = createContext({
      document: { querySelectorAll: () => [frameElement, hiddenElement] }, getComputedStyle: style,
    })
    const childRuntime = createContext({
      location: { href: frameElement.src }, innerWidth: 800, innerHeight: 600, getComputedStyle: style,
      document: { title: 'Frame', body: { innerText: 'Frame body' }, querySelectorAll: (selector: string) => selector === 'iframe,frame' ? [] : [control] },
    })
    const shown = { name: frameElement.name, url: frameElement.src, frames: [], isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => runInContext(script, childRuntime)) }
    const hidden = { name: hiddenElement.name, url: hiddenElement.src, frames: [], isDestroyed: () => false, executeJavaScript: vi.fn() }
    Object.assign(tab.view.webContents, { mainFrame: { frames: [shown, hidden], isDestroyed: () => false,
      executeJavaScript: vi.fn(async (script: string) => runInContext(script, parentRuntime)) } })
    const sections = await access.frameSnapshotSections(tab)
    expect(sections).toHaveLength(1)
    expect(sections[0]).toContain('Frame bottom action” [outside frame viewport]')
    expect(hidden.executeJavaScript).not.toHaveBeenCalled()
  })

  it('includes meaningful offscreen controls, excludes hidden ancestors, and retains refs after scrolling', async () => {
    const { access, add } = fixture()
    const tab = add('snapshot', 'session-a')
    const first = new Element('BUTTON', 'First action', 20)
    const below = new Element('BUTTON', 'Below page action', 900)
    const hidden = new Element('BUTTON', 'CSS hidden action', 50)
    hidden.style.display = 'none'
    const transparent = new Element('BUTTON', 'Transparent ancestor action', 60)
    transparent.parentElement = new Element('DIV', '', 0)
    transparent.parentElement.style.opacity = '0'
    const collapsed = new Element('BUTTON', 'Hidden subtree action', 70)
    collapsed.parentElement = new Element('DIV', '', 0)
    collapsed.parentElement.style.contentVisibility = 'hidden'
    const outsideHeading = new Element('H2', 'Unrelated distant heading', 2_000)
    const elements = [first, below, hidden, transparent, collapsed, outsideHeading]
    const runtime = createContext({
      location: { href: tab.url }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
      document: { title: 'Example', querySelectorAll: () => elements, getElementById: () => undefined, body: { innerText: 'Example page', scrollHeight: 3_000 }, documentElement: { scrollWidth: 800, scrollHeight: 3_000 } },
      getComputedStyle: (element: Element) => ({ display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible', ...element.style }),
      HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, HTMLAnchorElement: class {},
    })
    vi.spyOn(access, 'debuggerCommandFor').mockImplementation(async (_tab, _method, parameters) => ({ result: { value: runInContext(parameters.expression, runtime) } }))
    vi.spyOn(access, 'frameSnapshotSections').mockResolvedValue([])
    const initial = (await access.snapshot(tab)).snapshot
    expect(initial).toContain('Below page action” [outside viewport]')
    expect(initial).not.toContain('CSS hidden action')
    expect(initial).not.toContain('Transparent ancestor action')
    expect(initial).not.toContain('Hidden subtree action')
    expect(initial).not.toContain('Unrelated distant heading')
    expect(initial).toContain('Page text (may include content outside viewport)')
    const initialRef = /\[(\d+)\] button “Below page action”/u.exec(initial)?.[1]
    const store = runInContext("globalThis[Symbol.for('dfy-dsh-desktop.browser.snapshot-refs')]", runtime) as { elements: Map<number, WeakRef<Element>> }
    expect(store.elements.get(Number(initialRef))?.deref()).toBe(below)
    expect(store.elements.size).toBe(2)
    below.top = 150
    const next = (await access.snapshot(tab)).snapshot
    expect(next).toContain(`[${initialRef}] button “Below page action” @`)
    expect(next).not.toContain('Below page action” [outside viewport]')
    for (let index = 0; index < 300; index += 1) elements.push(new Element('BUTTON', `Distant ${index}`, 2_000 + index * 40))
    const bounded = (await access.snapshot(tab)).snapshot
    expect((bounded.match(/\[outside viewport\]/gu) ?? []).length).toBe(40)
    expect(bounded).toContain('more elements omitted')
    expect(tab.snapshotTargets.size).toBe(42)
    expect(store.elements.size).toBe(42)
  })
})
