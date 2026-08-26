import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { browserScreenshotCaptureWindowOptions, normalizeBrowserAddress, normalizeBrowserSettings, resolveBrowserTabForDisplay } from '../src/main/desktop-browser.js'
import {
  evaluatePage,
  parseLocatorPlan,
  runNavigationWithRetry,
  waitForNavigationStability,
  type BrowserNavigationState,
} from '../src/main/desktop-browser-automation.js'
import type { BrowserTabRuntime } from '../src/main/desktop-browser-types.js'
import { BROWSER_CONTROL_DOCUMENTATION, BROWSER_SKILL, createBrowserTools } from '../resources/dsh-desktop-browser/lib/index.js'
import { getProcessResourceRegistry } from '../resources/dsh-desktop-browser/lib/resource-core-runtime.js'

afterEach(() => vi.unstubAllGlobals())

describe('desktop browser settings', () => {
  it('keeps its styles mounted with the settings section across plugin hot reloads', () => {
    const clientSource = readFileSync(new URL('../resources/dsh-desktop-browser/lib/client.js', import.meta.url), 'utf8')
    expect(clientSource).toContain('在 Finder 中显示')
    expect(clientSource).toContain('在资源管理器中显示')
    expect(clientSource).toContain('在文件管理器中显示')
    expect(clientSource).toContain('navigator.platform')
    const react = {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
        type,
        props: props ?? {},
        children,
      }),
      useCallback: (callback: unknown) => callback,
      useEffect: () => undefined,
      useState: (initial: unknown) => [initial, () => undefined],
    }
    let plugin: { apply(ctx: unknown): void } | undefined
    let settingsSection: (() => { children: Array<{ type: unknown, props: Record<string, unknown>, children: unknown[] }> }) | undefined
    const window = {
      __ModuleLoader__: {
        load(definition: { factory(require: (id: string) => unknown): { apply(ctx: unknown): void } }) {
          plugin = definition.factory((id) => id === 'react' ? react : {})
        },
      },
    }
    vm.runInNewContext(clientSource, { window })
    const effect = vi.fn()
    plugin?.apply({
      effect,
      slots: {
        inject: (_name: string, install: () => unknown) => install(),
        register: (_definition: unknown, component: typeof settingsSection) => {
          settingsSection = component
          return () => undefined
        },
      },
    })

    const tree = settingsSection?.()
    expect(effect).not.toHaveBeenCalled()
    expect(tree?.children[0]).toEqual(expect.objectContaining({
      type: 'style',
      props: expect.objectContaining({ id: 'dsh-desktop-browser-settings-styles' }),
      children: [expect.stringContaining('.dsh-desktop-browser-feature-icon svg { width: 42px; height: 42px; }')],
    }))
  })

  it('defaults to an enabled background browser and normalizes stored values', () => {
    expect(normalizeBrowserSettings(undefined)).toEqual({ enabled: true, agentOpenMode: 'background', displayMode: 'split' })
    expect(normalizeBrowserSettings({ enabled: false, agentOpenMode: 'visible', displayMode: 'floating' })).toEqual({
      enabled: false,
      agentOpenMode: 'visible',
      displayMode: 'floating',
    })
    expect(normalizeBrowserSettings({ enabled: 'yes', agentOpenMode: 'other', displayMode: 'other' })).toEqual({
      enabled: true,
      agentOpenMode: 'background',
      displayMode: 'split',
    })
  })

  it('accepts web addresses, preserves local HTTP, and searches shell input', () => {
    expect(normalizeBrowserAddress('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBrowserAddress('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserAddress('browser automation')).toBe(
      'https://www.bing.com/search?q=browser%20automation',
    )
    expect(() => normalizeBrowserAddress('browser automation', false)).toThrow('完整')
    expect(() => normalizeBrowserAddress('file:///tmp/example.html', false)).toThrow('完整')
  })

  it('reveals an existing background tab instead of creating a blank tab', () => {
    expect(resolveBrowserTabForDisplay([
      { id: 'agent-1', destroyed: false },
    ])).toBe('agent-1')
    expect(resolveBrowserTabForDisplay([
      { id: 'agent-1', destroyed: false },
      { id: 'manual', destroyed: false },
    ])).toBe('manual')
    expect(resolveBrowserTabForDisplay([
      { id: 'agent-1', destroyed: true },
    ])).toBeUndefined()
  })
})

describe('desktop browser screenshots', () => {
  it('uses a fully transparent compositor host for hidden-page capture', () => {
    expect(browserScreenshotCaptureWindowOptions({ width: 1280, height: 800 })).toEqual(expect.objectContaining({
      show: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      transparent: true,
      opacity: 0,
      backgroundColor: '#00000000',
      paintWhenInitiallyHidden: true,
      width: 1280,
      height: 800,
    }))
  })
})

describe('desktop browser automation helpers', () => {
  it('parses locator plans outside the Electron window controller', () => {
    expect(parseLocatorPlan({ locator: [
      { kind: 'role', value: 'button', namePattern: '保存|Save', nameFlags: 'iu', exact: true },
      { kind: 'nth', value: '0' },
    ] })).toEqual([
      { kind: 'role', value: 'button', namePattern: '保存|Save', nameFlags: 'iu', exact: true },
      { kind: 'nth', value: '0' },
    ])
    expect(() => parseLocatorPlan({ locator: [{ kind: 'nth', value: 'first' }] })).toThrow('nth')
    expect(() => parseLocatorPlan({ locator: [{ kind: 'role', value: 'link', namePattern: '[' }] })).toThrow('正则')
  })

  it('keeps page evaluation read-only after moving it out of the controller', async () => {
    const tab = { id: 'agent-test' } as BrowserTabRuntime
    const command = vi.fn(async () => ({ result: { value: { title: 'Example' } } }))
    await expect(evaluatePage(tab, { script: '() => ({ title: document.title })' }, command)).resolves.toEqual({
      ok: true,
      tabId: 'agent-test',
      value: { title: 'Example' },
    })
    await expect(evaluatePage(tab, { script: '() => fetch("https://example.com")' }, command)).rejects.toThrow('只读')
    await expect(evaluatePage(tab, { script: '() => window.history.length' }, command)).resolves.toEqual({
      ok: true,
      tabId: 'agent-test',
      value: { title: 'Example' },
    })
    await expect(evaluatePage(tab, {
      script: `() => ({
        url: location.href,
        title: document.title,
        h1: Array.from(document.querySelectorAll('h1')).map((element) => element.textContent),
      })`,
    }, command)).resolves.toEqual({
      ok: true,
      tabId: 'agent-test',
      value: { title: 'Example' },
    })
    await expect(evaluatePage(tab, { script: '() => window.history.back()' }, command)).rejects.toThrow('只读')
    await expect(evaluatePage(tab, { script: '() => { location.href = "https://example.com/next" }' }, command)).rejects.toThrow('只读')
    await expect(evaluatePage(tab, { script: '() => location.assign("https://example.com/next")' }, command)).rejects.toThrow('只读')
    await expect(evaluatePage(tab, { script: '() => history.pushState({}, "", "/next")' }, command)).rejects.toThrow('只读')
    expect(command).toHaveBeenCalledTimes(3)
  })

  it('does not treat unchanged SPA title, H1, or text as a generic navigation blocker', async () => {
    const before: BrowserNavigationState = {
      version: 1,
      url: 'https://example.com/quickstart',
      title: 'Quickstart',
      h1: 'Quickstart',
      text: 'Old page',
      readyState: 'complete',
      loading: false,
      inflightRequests: 0,
      networkIdleMs: 1_000,
      kind: 'same-document',
    }
    const tab = {
      id: 'agent-spa',
      navigationVersion: 2,
      lastNavigationKind: 'same-document',
      loading: false,
      inflightRequests: new Set(),
      networkIdleSince: Date.now() - 1_000,
      view: { webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://example.com/providers',
        getTitle: () => 'Providers',
      } },
    } as unknown as BrowserTabRuntime
    const command = vi.fn(async () => ({ result: { value: {
      readyState: 'complete', title: 'Quickstart', h1: 'Quickstart', text: 'Old page',
    } } }))
    const outcome = await waitForNavigationStability(tab, before, {
      timeoutMs: 2_000,
      waitUntil: 'load',
      expectedUrl: 'https://example.com/providers',
      requireNavigation: true,
    }, command)
    expect(outcome).toEqual(expect.objectContaining({ status: 'success' }))
    expect(outcome.state).toEqual(expect.objectContaining({ title: 'Quickstart', h1: 'Quickstart' }))
    expect(outcome.elapsedMs).toBeLessThan(800)
    expect(command).toHaveBeenCalledTimes(3)
  })

  it('distinguishes no-op from a navigation timeout', async () => {
    const before: BrowserNavigationState = {
      version: 1,
      url: 'https://example.com/quickstart',
      title: 'Quickstart',
      h1: 'Quickstart',
      text: 'Old page',
      readyState: 'complete',
      loading: false,
      inflightRequests: 0,
      networkIdleMs: 1_000,
      kind: 'same-document',
    }
    const tab = {
      id: 'agent-nav-state',
      navigationVersion: 1,
      lastNavigationKind: 'same-document',
      loading: false,
      inflightRequests: new Set(),
      networkIdleSince: Date.now() - 1_000,
      view: { webContents: {
        isDestroyed: () => false,
        getURL: () => before.url,
        getTitle: () => before.title,
      } },
    } as unknown as BrowserTabRuntime
    const command = vi.fn(async () => ({ result: { value: {
      readyState: 'complete', title: before.title, h1: before.h1, text: before.text,
    } } }))
    const noOp = await waitForNavigationStability(tab, before, {
      timeoutMs: 1_000,
      waitUntil: 'load',
      requireNavigation: false,
      detectionTimeoutMs: 250,
    }, command)
    expect(noOp).toEqual(expect.objectContaining({ status: 'no-op', reason: 'no-navigation' }))

    tab.navigationVersion = 2
    const timeout = await waitForNavigationStability(tab, before, {
      timeoutMs: 250,
      waitUntil: 'load',
      expectedUrl: 'https://example.com/providers',
      requireNavigation: true,
    }, command)
    expect(timeout).toEqual(expect.objectContaining({ status: 'timeout', reason: 'expected-url' }))
  })

  it('waits for a real 500ms network quiet window when networkidle is requested', async () => {
    const before: BrowserNavigationState = {
      version: 1,
      url: 'https://example.com/start',
      title: 'Start',
      h1: 'Start',
      text: 'Start',
      readyState: 'complete',
      loading: false,
      inflightRequests: 1,
      networkIdleMs: 0,
      kind: 'document',
    }
    const tab = {
      id: 'agent-networkidle',
      navigationVersion: 2,
      lastNavigationKind: 'document',
      loading: false,
      inflightRequests: new Set(['request-1']),
      networkIdleSince: Number.POSITIVE_INFINITY,
      view: { webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://example.com/next',
        getTitle: () => 'Next',
      } },
    } as unknown as BrowserTabRuntime
    let reads = 0
    const command = vi.fn(async () => {
      reads += 1
      if (reads === 3) {
        tab.inflightRequests.clear()
        tab.networkIdleSince = Date.now() - 600
      }
      return { result: { value: { readyState: 'complete', title: 'Next', h1: 'Next', text: 'Next' } } }
    })
    const outcome = await waitForNavigationStability(tab, before, {
      timeoutMs: 2_000,
      waitUntil: 'networkidle',
      expectedUrl: 'https://example.com/next',
      requireNavigation: true,
    }, command)
    expect(outcome).toEqual(expect.objectContaining({ status: 'success' }))
    expect(reads).toBeGreaterThanOrEqual(5)
    expect(outcome.state).toEqual(expect.objectContaining({ inflightRequests: 0, networkIdleMs: expect.any(Number) }))
  })

  it('retries the same navigation action at most once', async () => {
    const state = {
      version: 1,
      url: 'https://example.com/providers',
      title: 'Providers',
      h1: 'Providers',
      text: 'Page',
      readyState: 'complete',
      loading: false,
      kind: 'same-document' as const,
    }
    const action = vi.fn(async () => undefined)
    const observe = vi.fn()
      .mockResolvedValueOnce({ status: 'timeout', reason: 'unstable-page', state, elapsedMs: 250 })
      .mockResolvedValueOnce({ status: 'success', state, elapsedMs: 300 })
    await expect(runNavigationWithRetry(action, observe)).resolves.toEqual(expect.objectContaining({
      attempts: 2,
      outcome: expect.objectContaining({ status: 'success' }),
    }))
    expect(action).toHaveBeenCalledTimes(2)
    expect(observe).toHaveBeenCalledTimes(2)
  })
})

describe('desktop browser plugin', () => {
  it('publishes one JavaScript browser tool and its runtime API', () => {
    const tools = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')
    expect(tools.map((tool) => tool.name)).toEqual(['browser_execute'])
    expect(tools[0]?.parameters.required).toEqual(['code'])
    expect(tools[0]?.parameters.properties.code).toEqual(expect.objectContaining({
      type: 'string',
      maxLength: 16000,
    }))
    expect(BROWSER_SKILL).toContain('background')
    expect(BROWSER_SKILL).toContain('browser_execute')
    expect(BROWSER_SKILL).toContain('return await browser.documentation()')
    expect(BROWSER_SKILL).toContain('exactly once')
    expect(BROWSER_SKILL).toContain('Never swallow a failed readiness wait')
    expect(BROWSER_SKILL).toContain('try/finally')
    expect(BROWSER_SKILL).toContain('Treat resourceRef as an opaque token')
    expect(BROWSER_SKILL).toContain('Do not copy a temporary screenshot into the workspace')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('browser.tabs.new')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('browser.tabs.finalize')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('tab.playwright.domSnapshot')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('getByRole')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('focus()')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('expectNavigation')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('waitForURL')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('action completion only')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('locator.waitFor() for business UI')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('do not copy the PNG into the workspace')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('never reconstruct, shorten, or rewrite it in prose')
    expect(BROWSER_CONTROL_DOCUMENTATION).not.toContain('SPA URL, title, H1, and page text have stabilized')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('tab.cua')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('stable element refs')
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('One script may perform several related browser actions')
    expect(BROWSER_SKILL).not.toMatch(/Ctrl|Alt|shortcut/iu)
    expect(BROWSER_CONTROL_DOCUMENTATION).toContain('claims the unused blank new tab')
  })

  it('returns the complete selected-browser guide without contacting the page host', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: 'return await browser.documentation();',
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output)).toEqual({
      result: BROWSER_CONTROL_DOCUMENTATION,
      actions: [],
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns screenshot metadata and an opaque resource ref without requiring image plugins', async () => {
    const resourceId = 'a'.repeat(43)
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return new Response(JSON.stringify(body.action === 'new'
        ? { ok: true, tabId: 'agent-shot' }
        : {
            ok: true,
            tabId: 'agent-shot',
            resourceId,
            path: '/tmp/browser-shot.png',
            mimeType: 'image/png',
            bytes: 8,
            width: 640,
            height: 480,
            sourceUrl: 'https://example.com/',
            capturedAt: '2026-08-20T00:00:00.000Z',
          }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: 'const tab = await browser.tabs.new(); return await tab.screenshot();',
    }, { agent: { id: 'session-a' } })
    const parsed = JSON.parse(output)
    expect(parsed.result).toEqual(expect.objectContaining({
      path: '/tmp/browser-shot.png',
      mimeType: 'image/png',
      width: 640,
      height: 480,
      resourceRef: expect.stringMatching(/^dfyr1_/),
    }))
    expect(parsed.screenshotResources).toEqual([expect.objectContaining({
      resourceRef: parsed.result.resourceRef,
      sourceUrl: 'https://example.com/',
    })])
    expect(tool.output.render({}, output).map((block: { type: string }) => block.type)).toEqual(['text'])
  })

  it('projects screenshots only for explicitly image-capable parent models', async () => {
    const resourceId = 'b'.repeat(43)
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const registry = getProcessResourceRegistry()
    const dispose = registry.registerProvider({
      id: 'desktop-browser',
      async resolve(reference: { id: string }) {
        return reference.id === resourceId
          ? { kind: 'image', data: png, bytes: png.byteLength, mediaType: 'image/png' }
          : undefined
      },
    })
    try {
      const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
        const body = JSON.parse(String(options.body))
        return new Response(JSON.stringify(body.action === 'new'
          ? { ok: true, tabId: 'agent-native-shot' }
          : {
              ok: true,
              tabId: 'agent-native-shot',
              resourceId,
              path: '/tmp/native-shot.png',
              mimeType: 'image/png',
              bytes: png.byteLength,
              width: 2,
              height: 2,
              sourceUrl: 'https://example.com/',
            }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
      vi.stubGlobal('fetch', fetchImpl)
      const attachment = {
        attachmentId: `sha256:${'1'.repeat(64)}`,
        mediaType: 'image/png',
        bytes: png.byteLength,
        width: 2,
        height: 2,
        name: 'native-shot.png',
      }
      const imageContext = {
        llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text', 'image'] })) },
        attachments: { saveImage: vi.fn(async () => attachment) },
      }
      const imageTool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret', imageContext)[0]
      const output = await imageTool.execute({
        code: 'const tab = await browser.tabs.new(); return await tab.screenshot();',
      }, { agent: { id: 'session-a', options: { provider: 'test', model: 'vision' } }, signal: new AbortController().signal })
      expect(imageContext.attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: png, mediaType: 'image/png' }))
      expect(imageTool.output.render({}, output).map((block: { type: string }) => block.type)).toEqual(['text', 'image'])

      const textContext = {
        llm: { resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text'] })) },
        attachments: { saveImage: vi.fn() },
      }
      const textTool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret', textContext)[0]
      const textOutput = await textTool.execute({
        code: 'const tab = await browser.tabs.new(); return await tab.screenshot();',
      }, { agent: { id: 'session-b', options: { provider: 'test', model: 'text' } }, signal: new AbortController().signal })
      expect(textContext.attachments.saveImage).not.toHaveBeenCalled()
      expect(textTool.output.render({}, textOutput).map((block: { type: string }) => block.type)).toEqual(['text'])
    } finally {
      dispose()
    }
  })

  it('exposes the Codex-shaped coordinate fallback without adding model tools', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return new Response(JSON.stringify(body.action === 'new' ? { ok: true, tabId: 'agent-cua' } : { ok: true, tabId: body.tabId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    await tool.execute({
      code: `const tab = await browser.tabs.new();
await tab.cua.move({ x: 10, y: 20 });
await tab.cua.click({ x: 10, y: 20 });
await tab.cua.double_click({ x: 12, y: 22 });
await tab.cua.drag({ path: [{ x: 1, y: 2 }, { x: 8, y: 9 }] });
await tab.cua.keypress({ keys: ['Control', 'A'] });
await tab.cua.type({ text: 'hello' });
await tab.cua.scroll({ x: 100, y: 120, scrollX: 0, scrollY: 500 });`,
    }, { agent: { id: 'session-a' } })
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(bodies.slice(1).map((body) => body.action)).toEqual(['hover', 'click', 'click', 'drag', 'press', 'type', 'scroll'])
    expect(bodies[3]).toEqual(expect.objectContaining({ clickCount: 2, x: 12, y: 22 }))
    expect(bodies[4]).toEqual(expect.objectContaining({ path: [{ x: 1, y: 2 }, { x: 8, y: 9 }] }))
    expect(bodies[5]).toEqual(expect.objectContaining({ key: 'Control+A' }))
    expect(bodies[7]).toEqual(expect.objectContaining({ deltaX: 0, deltaY: 500 }))
  })

  it('binds DOM CUA node ids to the latest snapshot version', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return new Response(JSON.stringify(body.action === 'new'
        ? { ok: true, tabId: 'agent-dom-cua' }
        : body.action === 'snapshot'
          ? { ok: true, tabId: body.tabId, snapshotVersion: 9, snapshot: '[14] button “Save”' }
          : { ok: true, tabId: body.tabId }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const dom = await tab.dom_cua.get_visible_dom();
await tab.dom_cua.click({ node_id: '[14]' });
return dom;`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toBe('[14] button “Save”')
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'click', tabId: 'agent-dom-cua', ref: 14, snapshotVersion: 9,
    }))
  })

  it('exposes bounded page inspection and console logs', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      if (body.action === 'new') return new Response(JSON.stringify({ ok: true, tabId: 'agent-dev' }))
      if (body.action === 'evaluate') return new Response(JSON.stringify({ ok: true, value: { title: 'Example' } }))
      return new Response(JSON.stringify({ ok: true, logs: [{ level: 'error', message: 'boom', timestamp: 'now' }] }))
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const page = await tab.playwright.evaluate((arg) => ({ title: document.title, arg }), { key: 1 });
const logs = await tab.dev.logs({ levels: ['error'], limit: 10 });
return { page, logs };`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toEqual({
      page: { title: 'Example' },
      logs: [{ level: 'error', message: 'boom', timestamp: 'now' }],
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'evaluate', tabId: 'agent-dev', argument: { key: 1 },
    }))
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'logs', tabId: 'agent-dev', levels: ['error'], limit: 10,
    }))
  })

  it('models file chooser, download, and JavaScript dialog lifecycles', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payload = body.action === 'new' ? { ok: true, tabId: 'agent-events' }
        : body.action === 'wait-event' && body.event === 'filechooser' ? { ok: true, eventId: 'chooser-1', multiple: false }
          : body.action === 'wait-event' ? { ok: true, eventId: 'download-1' }
            : body.action === 'download-path' ? { ok: true, path: '/tmp/result.txt' }
              : body.action === 'get-dialog' ? { ok: true, dialog: { type: 'prompt' } }
                : { ok: true, count: 1 }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const chooserPromise = tab.playwright.waitForEvent('filechooser');
await tab.playwright.getByText('Upload').click();
const chooser = await chooserPromise;
await chooser.setFiles('/tmp/upload.txt');
const download = await tab.playwright.waitForEvent('download');
const path = await download.path();
const dialog = await tab.getJsDialog();
await dialog.accept('answer');
return { path, multiple: chooser.isMultiple(), type: dialog.type };`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toEqual({ path: '/tmp/result.txt', multiple: false, type: 'prompt' })
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(bodies.map((body) => body.action)).toEqual([
      'new', 'wait-event', 'locator', 'filechooser-set-files', 'wait-event', 'download-path', 'get-dialog', 'handle-dialog',
    ])
    expect(bodies[3]).toEqual(expect.objectContaining({ eventId: 'chooser-1', paths: ['/tmp/upload.txt'] }))
    expect(bodies[7]).toEqual(expect.objectContaining({ accept: true, promptText: 'answer' }))
  })

  it('serializes navigation synchronization and page wait helpers', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      if (body.action === 'new') return new Response(JSON.stringify({ ok: true, tabId: 'agent-nav' }))
      if (body.action === 'navigation-state') return new Response(JSON.stringify({ ok: true, tabId: body.tabId, version: 7 }))
      return new Response(JSON.stringify({ ok: true, tabId: body.tabId, operation: body.operation }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const link = tab.playwright.getByRole('link', { name: 'Continue' });
await tab.playwright.expectNavigation(() => link.click(), { url: 'https://example.com/*', waitUntil: 'domcontentloaded' });
await tab.playwright.waitForURL('https://example.com/next', { waitUntil: 'load' });
await tab.playwright.waitForTimeout(5);
return tab.id;`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toBe('agent-nav')
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'navigation-state', tabId: 'agent-nav', sessionId: 'session-a',
    }))
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'locator', operation: 'click', tabId: 'agent-nav',
    }))
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'wait-navigation', afterVersion: 7, url: 'https://example.com/*', waitUntil: 'domcontentloaded',
    }))
    expect(JSON.parse(String(fetchImpl.mock.calls[4]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'wait-url', url: 'https://example.com/next', waitUntil: 'load',
    }))
    expect(JSON.parse(String(fetchImpl.mock.calls[5]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'wait-timeout', timeoutMs: 5,
    }))
  })

  it('runs several browser API calls while binding every action to the DSH session', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payload = body.action === 'new'
        ? { ok: true, tabId: 'agent-1', url: '' }
        : body.action === 'navigate'
          ? { ok: true, tabId: body.tabId, url: body.url }
          : { ok: true, tabId: body.tabId, snapshotVersion: 4, snapshot: 'Page snapshot' }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    if (tool === undefined) throw new Error('browser_execute missing')

    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
await tab.goto('https://example.com/');
return await tab.playwright.domSnapshot();`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output)).toEqual({
      result: 'Page snapshot',
      actions: [
        expect.objectContaining({ action: 'new', tabId: 'agent-1' }),
        expect.objectContaining({ action: 'navigate', tabId: 'agent-1' }),
        expect.objectContaining({ action: 'snapshot', tabId: 'agent-1', snapshotVersion: 4 }),
      ],
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual(new URL('http://127.0.0.1:12345/v1/browser/action'))
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'new', sessionId: 'session-a',
    })
    expect(fetchImpl.mock.calls[1]?.[0]).toEqual(new URL('http://127.0.0.1:12345/v1/browser/action'))
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      tabId: 'agent-1', url: 'https://example.com/', action: 'navigate', sessionId: 'session-a',
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      tabId: 'agent-1', action: 'snapshot', sessionId: 'session-a',
    })
    await expect(tool.execute({ code: 'return await browser.tabs.list()' }, {})).rejects.toThrow('calling DSH agent session')
  })

  it('serializes semantic Playwright locators and keeps their tab binding private', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      if (body.action === 'new') return new Response(JSON.stringify({ ok: true, tabId: 'agent-2' }))
      if (body.operation === 'count') return new Response(JSON.stringify({ ok: true, tabId: body.tabId, operation: 'count', count: 1 }))
      return new Response(JSON.stringify({ ok: true, tabId: body.tabId, operation: body.operation }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const form = tab.playwright.locator('form[data-testid="login"]');
const buttons = form.getByRole('button');
const count = await buttons.count();
const all = await buttons.all();
const labels = await buttons.allTextContents();
const button = buttons.nth(0);
await button.click();
await button.dblclick();
await button.focus();
await button.setChecked(true);
return { count, allCount: all.length, labels, tabId: tab.id };`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toEqual({ count: 1, allCount: 1, tabId: 'agent-2' })
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      tabId: 'agent-2',
      locator: [
        { kind: 'css', value: 'form[data-testid="login"]' },
        { kind: 'role', value: 'button', exact: false },
      ],
      operation: 'count',
      action: 'locator',
      sessionId: 'session-a',
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[4]?.[1]?.body))).toEqual(expect.objectContaining({
      tabId: 'agent-2',
      locator: [
        { kind: 'css', value: 'form[data-testid="login"]' },
        { kind: 'role', value: 'button', exact: false },
        { kind: 'nth', value: '0' },
      ],
      operation: 'click',
      action: 'locator',
      sessionId: 'session-a',
    }))
    expect(JSON.parse(String(fetchImpl.mock.calls[6]?.[1]?.body))).toEqual(expect.objectContaining({
      tabId: 'agent-2',
      operation: 'focus',
      action: 'locator',
      sessionId: 'session-a',
    }))
    expect(JSON.parse(String(fetchImpl.mock.calls[7]?.[1]?.body))).toEqual(expect.objectContaining({
      tabId: 'agent-2',
      operation: 'set-checked',
      checked: true,
      action: 'locator',
      sessionId: 'session-a',
    }))
  })

  it('does not infer or wait for navigation after a plain locator click', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payload = body.action === 'new'
        ? { ok: true, tabId: 'agent-plain-click' }
        : { ok: true, tabId: body.tabId, operation: body.operation }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const result = await tab.playwright.getByRole('button', { name: 'Continue' }).click();
return result === undefined;`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toBe(true)
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(bodies.map((body) => body.action)).toEqual(['new', 'locator'])
    expect(bodies[1]).toEqual(expect.objectContaining({ operation: 'click', tabId: 'agent-plain-click' }))
  })

  it('serializes regular-expression accessible names for role locators', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return new Response(JSON.stringify(body.action === 'new' ? { ok: true, tabId: 'agent-regex' } : { ok: true, count: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    await tool.execute({
      code: `const tab = await browser.tabs.new();
return await tab.playwright.getByRole('link', { name: /配置模型|Configure models/iu }).count();`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(expect.objectContaining({
      locator: [{ kind: 'role', value: 'link', namePattern: '配置模型|Configure models', nameFlags: 'iu', exact: false }],
    }))
  })

  it('serializes nested frame locators as frame-scoped locator plans', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return new Response(JSON.stringify(body.action === 'new'
        ? { ok: true, tabId: 'agent-frame' }
        : { ok: true, tabId: body.tabId, operation: body.operation, count: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const button = tab.playwright.frameLocator('iframe[name="outer"]').frameLocator('iframe.inner').getByRole('button', { name: 'Pay' });
return await button.count();`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toBe(1)
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(expect.objectContaining({
      locator: [
        { kind: 'frame', value: 'iframe[name="outer"]' },
        { kind: 'frame', value: 'iframe.inner' },
        { kind: 'role', value: 'button', name: 'Pay', exact: false },
      ],
      operation: 'count',
    }))
  })

  it('serializes locator filters and same-tab combinations', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return new Response(JSON.stringify(body.action === 'new' ? { ok: true, tabId: 'agent-filter' } : { ok: true, count: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    await tool.execute({
      code: `const tab = await browser.tabs.new();
const buttons = tab.playwright.getByRole('button');
const ready = tab.playwright.getByText(/ready/iu);
const save = buttons.filter({ hasText: /Save/iu, hasNotText: 'draft', has: ready, visible: true });
const exact = save.and(tab.playwright.getByTestId('save'));
const either = exact.or(tab.playwright.getByText('Save now'));
return await either.count();`,
    }, { agent: { id: 'session-a' } })
    const body = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))
    expect(body.locator.map((step: { kind: string }) => step.kind)).toEqual(['role', 'filter', 'and', 'or'])
    expect(JSON.parse(body.locator[1].value)).toEqual({
      hasText: { value: 'Save', namePattern: 'Save', nameFlags: 'iu' },
      hasNotText: { value: 'draft' },
      has: [{ kind: 'text', value: 'ready', namePattern: 'ready', nameFlags: 'iu', exact: false }],
      visible: true,
    })
    expect(JSON.parse(body.locator[2].value)).toEqual([{ kind: 'testid', value: 'save' }])
  })

  it('serializes read-only locator evaluation', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return new Response(JSON.stringify(body.action === 'new' ? { ok: true, tabId: 'agent-locator-eval' } : { ok: true, value: 'Save' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
return await tab.playwright.getByRole('button', { name: 'Save' }).evaluate((element, suffix) => element.textContent + suffix, '');`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toBe('Save')
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(expect.objectContaining({
      action: 'locator', operation: 'evaluate', argument: '', tabId: 'agent-locator-eval',
    }))
  })

  it('serializes extended locator operations and option descriptors', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payload = body.action === 'new'
        ? { ok: true, tabId: 'agent-locator-extended' }
        : body.operation === 'evaluate-all'
          ? { ok: true, value: ['A', 'B'] }
          : { ok: true, operation: body.operation }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
const field = tab.playwright.getByLabel(/model/i);
await field.pressSequentially('abc');
await field.selectOption([{ label: 'DeepSeek' }, { index: 2 }]);
await field.downloadMedia();
return await field.evaluateAll((elements) => elements.map((element) => element.textContent));`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toEqual(['A', 'B'])
    const bodies = fetchImpl.mock.calls.slice(1).map((call) => JSON.parse(String(call[1]?.body)))
    expect(bodies.map((body) => body.operation)).toEqual(['press-sequentially', 'select-option', 'download-media', 'evaluate-all'])
    expect(bodies[1]?.values).toEqual([{ label: 'DeepSeek' }, { index: 2 }])
    expect(bodies[0]?.locator).toEqual([{ kind: 'label', value: 'model', namePattern: 'model', nameFlags: 'i', exact: false }])
  })

  it('exposes user tabs, browser capabilities, clipboard, content export, and pageAssets', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payloads: Record<string, unknown> = {
        'user-tabs': { ok: true, tabs: [{ id: 'manual', providerTabId: 'manual', title: 'Manual', url: 'https://example.com/' }] },
        'claim-tab': { ok: true, tabId: 'manual' },
        'browser-history': { ok: true, entries: [{ dateVisited: '2026-08-20T00:00:00.000Z', url: 'https://example.com/' }] },
        'browser-visibility': { ok: true, visible: body.visible ?? false },
        'browser-viewport': { ok: true, viewport: body.width === undefined ? null : { width: body.width, height: body.height } },
        'clipboard-read-text': { ok: true, text: 'copied' },
        'content-export': { ok: true, path: 'C:/tmp/page.html' },
        'page-assets-list': { ok: true, tabId: body.tabId, id: 'inventory-1', assets: [], inlineSvgs: [], pageUrl: 'https://example.com/', summary: { totalCount: 0 } },
        'page-assets-bundle': { ok: true, tabId: body.tabId, assets: [], failures: [], directoryPath: 'C:/tmp/assets', manifestPath: 'C:/tmp/assets/manifest.json', summary: { requestedCount: 0 } },
      }
      return new Response(JSON.stringify(payloads[body.action] ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const open = await browser.user.openTabs();
const tab = await browser.user.claimTab(open[0]);
await browser.nameSession('API parity');
await tab.markHandoff();
const history = await browser.user.history({ queries: ['example'], limit: 5 });
const visibility = await browser.capabilities.get('visibility');
await visibility.set(false);
const viewport = await browser.capabilities.get('viewport');
await viewport.set({ width: 800, height: 600 });
await viewport.reset();
await tab.clipboard.writeText('hello');
const copied = await tab.clipboard.readText();
const exported = await tab.content.export();
const assets = await tab.capabilities.get('pageAssets');
const inventory = await assets.list();
const bundle = await assets.bundle({ inventoryId: inventory.id, kinds: ['image'] });
return { tabId: tab.id, history, copied, exported, inventoryId: inventory.id, manifestPath: bundle.manifestPath };`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toEqual(expect.objectContaining({
      tabId: 'manual', copied: 'copied', exported: 'C:/tmp/page.html', inventoryId: 'inventory-1', manifestPath: 'C:/tmp/assets/manifest.json',
    }))
    const actions = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).action)
    expect(actions).toEqual([
      'user-tabs', 'claim-tab', 'name-session', 'mark-tab', 'browser-history', 'browser-visibility',
      'browser-viewport', 'browser-viewport', 'clipboard-write-text', 'clipboard-read-text',
      'content-export', 'page-assets-list', 'page-assets-bundle',
    ])
  })

  it('does not expose Node globals to browser scripts', async () => {
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({ code: 'return { process: typeof process, require: typeof require, browser: typeof browser }' }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toEqual({ process: 'undefined', require: 'undefined', browser: 'object' })
    await expect(tool.execute({
      code: 'return browser.tabs.new.constructor("return process")()',
    }, { agent: { id: 'session-a' } })).rejects.toThrow('Code generation from strings disallowed')
  })

  it('lists, selects, and binds tab operations through Codex-style Tab objects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      activeTabId: 'agent-1',
      panelOpen: false,
      tabs: [{ id: 'agent-1', url: 'https://example.com/' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tabs = await browser.tabs.list();
const selected = await browser.tabs.selected();
return { firstTab: tabs[0], selectedId: selected?.id, url: await selected?.url() };`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toEqual({
      firstTab: { id: 'agent-1', url: 'https://example.com/' },
      selectedId: 'agent-1',
      url: 'https://example.com/',
    })
  })

  it('finalizes tabs with Tab objects and reports completed action traces on failure', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      if (body.action === 'tabs') {
        return new Response(JSON.stringify({
          ok: true,
          activeTabId: 'agent-1',
          tabs: [{ id: 'agent-1', title: 'Example', url: 'https://example.com/' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, closed: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.get('agent-1');
await browser.tabs.finalize({ keep: [{ tab, status: 'handoff' }] });
return tab.id;`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toBe('agent-1')
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      keep: [{ tabId: 'agent-1', status: 'handoff' }],
      action: 'finalize',
      sessionId: 'session-a',
    })

    await expect(tool.execute({
      code: `await browser.tabs.list();
throw new Error('after tabs');`,
    }, { agent: { id: 'session-a' } })).rejects.toThrow('Completed browser actions')
  })

  it('supports detailed workflows beyond the old 40-action limit', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payload = body.action === 'new'
        ? { ok: true, tabId: 'agent-budget' }
        : body.action === 'tabs'
          ? { ok: true, tabs: [{ id: 'agent-budget', url: 'https://example.com/' }] }
          : { ok: true, tabId: body.tabId }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    const output = await tool.execute({
      code: `const tab = await browser.tabs.new();
try {
  for (let index = 0; index < 60; index += 1) await browser.tabs.list();
  return 'completed';
} finally {
  await tab.close();
  await browser.tabs.finalize({ keep: [] });
}`,
    }, { agent: { id: 'session-a' } })
    expect(JSON.parse(output).result).toBe('completed')
    const actions = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).action)
    expect(actions.slice(-2)).toEqual(['close', 'finalize'])
  })

  it('reserves close and finalize actions after the ordinary action budget is exhausted', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payload = body.action === 'new'
        ? { ok: true, tabId: 'agent-budget-cleanup' }
        : body.action === 'tabs'
          ? { ok: true, tabs: [{ id: 'agent-budget-cleanup', url: 'https://example.com/' }] }
          : { ok: true, tabId: body.tabId }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    await expect(tool.execute({
      code: `const tab = await browser.tabs.new();
try {
  for (let index = 0; index < 80; index += 1) await browser.tabs.list();
} finally {
  await tab.close();
  await browser.tabs.finalize({ keep: [] });
}`,
    }, { agent: { id: 'session-a' } })).rejects.toThrow('exceeded 80 ordinary actions')
    const actions = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).action)
    expect(actions.slice(-2)).toEqual(['close', 'finalize'])
  })

  it('reports history no-op and timeout distinctly while finally closes the temporary tab', async () => {
    const fetchImpl = vi.fn(async (_url: URL, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      const payload = body.action === 'new'
        ? { ok: true, tabId: 'agent-history' }
        : body.action === 'back'
          ? { ok: true, status: 'no-op', reason: 'no-history-entry', tabId: body.tabId, attempts: 0 }
          : body.action === 'forward'
            ? { ok: false, status: 'timeout', reason: 'unstable-page', tabId: body.tabId, attempts: 2 }
            : { ok: true, tabId: body.tabId }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
    await expect(tool.execute({
      code: `const tab = await browser.tabs.new();
try {
  const back = await tab.back();
  if (back.status !== 'no-op') throw new Error('expected no-op');
  await tab.forward();
} finally {
  await tab.close();
}`,
    }, { agent: { id: 'session-a' } })).rejects.toThrow('Browser navigation timeout: unstable-page')
    const actions = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).action)
    expect(actions).toEqual(['new', 'back', 'forward', 'close'])
  })
})
