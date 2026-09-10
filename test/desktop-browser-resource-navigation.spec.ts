import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserTools } from '../resources/dsh-desktop-browser/lib/index.js'

afterEach(() => vi.unstubAllGlobals())

function browserRunner() {
  const requests: Record<string, unknown>[] = []
  const before = { version: 7, url: 'https://example.com/', title: 'Example', h1: 'Example', text: 'Continue' }
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, options: RequestInit) => {
    const request = JSON.parse(String(options.body)) as Record<string, unknown>
    requests.push(request)
    const result = request.action === 'new'
      ? { ok: true, tabId: 'navigation-test' }
      : request.action === 'navigation-state'
        ? { ok: true, tabId: request.tabId, version: 7, before }
        : { ok: true, tabId: request.tabId, operation: request.operation }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
  return {
    requests,
    before,
    async run(code: string) {
      const output = await tool.execute({ code }, { agent: { id: 'session-navigation-test' } })
      return JSON.parse(output)
    },
  }
}

describe('browser resource navigation options', () => {
  it.each([
    ['a RegExp URL', '{ url: /example/ }', 'RegExp URL matchers are not supported'],
    ['an object URL', '{ url: {} }', 'string URL or glob'],
    ['an empty URL', '{ url: "" }', 'non-empty string'],
    ['a null URL', '{ url: null }', 'string URL or glob'],
    ['an oversized URL', '{ url: "a".repeat(4001) }', 'up to 4000 characters'],
    ['a low timeout', '{ timeoutMs: 249 }', 'integer from 250 to 60000'],
    ['a high timeout', '{ timeoutMs: 60001 }', 'integer from 250 to 60000'],
    ['a fractional timeout', '{ timeoutMs: 250.5 }', 'integer from 250 to 60000'],
    ['a nonnumeric timeout', '{ timeoutMs: "1000" }', 'integer from 250 to 60000'],
    ['a nonfinite timeout', '{ timeoutMs: NaN }', 'integer from 250 to 60000'],
    ['an unknown lifecycle', '{ waitUntil: "ready" }', 'waitUntil must be'],
    ['a boxed lifecycle', '{ waitUntil: new String("load") }', 'waitUntil must be'],
    ['null options', 'null', 'options must be an object'],
    ['array options', '[]', 'options must be an object'],
  ])('rejects %s before reading navigation state or running the action', async (_description, options, message) => {
    const browser = browserRunner()
    const output = await browser.run(`
      const tab = await browser.tabs.new();
      let actionRan = false;
      try {
        await tab.playwright.expectNavigation(async () => {
          actionRan = true;
          await tab.playwright.getByRole('link', { name: 'Continue' }).click();
        }, ${options});
        return { actionRan };
      } catch (error) {
        return { actionRan, error: String(error) };
      }
    `)
    expect(output.result).toEqual({ actionRan: false, error: expect.stringContaining(message) })
    expect(browser.requests.map((request) => request.action)).toEqual(['new'])
  })

  it.each(['commit', 'domcontentloaded', 'load', 'networkidle'])('passes string globs and the %s lifecycle unchanged', async (waitUntil) => {
    const browser = browserRunner()
    const output = await browser.run(`
      const tab = await browser.tabs.new();
      return await tab.playwright.expectNavigation(async () => {
        await tab.playwright.getByRole('link', { name: 'Continue' }).click();
        return 'submitted';
      }, { url: 'https://example.com/search?q=deepseek*', timeoutMs: 250, waitUntil: '${waitUntil}' });
    `)
    expect(output.result).toBe('submitted')
    expect(browser.requests.map((request) => request.action)).toEqual(['new', 'navigation-state', 'locator', 'wait-navigation'])
    expect(browser.requests[3]).toEqual(expect.objectContaining({
      url: 'https://example.com/search?q=deepseek*', timeoutMs: 250, waitUntil,
      afterVersion: 7, before: browser.before, sessionId: 'session-navigation-test',
    }))
  })

  it('uses the validated option values even if the action changes its options object', async () => {
    const browser = browserRunner()
    await browser.run(`
      const tab = await browser.tabs.new();
      const options = { url: 'https://example.com/*', timeoutMs: 60000, waitUntil: 'load' };
      await tab.playwright.expectNavigation(async () => {
        options.url = /changed/;
        options.timeoutMs = NaN;
        options.waitUntil = null;
      }, options);
    `)
    expect(browser.requests[2]).toEqual(expect.objectContaining({
      action: 'wait-navigation', url: 'https://example.com/*', timeoutMs: 60000, waitUntil: 'load',
    }))
  })

  it('keeps optional navigation defaults and propagates action failures without starting a wait', async () => {
    const browser = browserRunner()
    await expect(browser.run(`
      const tab = await browser.tabs.new();
      try {
        await tab.playwright.expectNavigation(async () => { throw new Error('Submission failed'); });
      } finally {
        await tab.close();
      }
    `)).rejects.toThrow('Submission failed')
    expect(browser.requests.map((request) => request.action)).toEqual(['new', 'navigation-state', 'close'])
  })

  it.each([
    ['waitForURL(/example/)', 'RegExp URL matchers are not supported'],
    ['waitForURL("https://example.com/*", { timeoutMs: Infinity })', 'timeoutMs must be'],
    ['waitForURL("https://example.com/*", { waitUntil: "ready" })', 'waitUntil must be'],
    ['waitForLoadState({ state: "commit" })', 'state must be'],
    ['waitForLoadState({ timeoutMs: 0 })', 'timeoutMs must be'],
  ])('validates %s without sending an invalid RPC', async (expression, message) => {
    const browser = browserRunner()
    await expect(browser.run(`const tab = await browser.tabs.new(); await tab.playwright.${expression};`)).rejects.toThrow(message)
    expect(browser.requests.map((request) => request.action)).toEqual(['new'])
  })

  it('preserves the URL glob and translates a valid load state for page waits', async () => {
    const browser = browserRunner()
    await browser.run(`
      const tab = await browser.tabs.new();
      await tab.playwright.waitForURL('https://example.com/*', { timeoutMs: 60000, waitUntil: 'commit' });
      await tab.playwright.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 250 });
    `)
    expect(browser.requests[1]).toEqual(expect.objectContaining({
      action: 'wait-url', url: 'https://example.com/*', timeoutMs: 60000, waitUntil: 'commit',
    }))
    expect(browser.requests[2]).toEqual(expect.objectContaining({
      action: 'wait-url', timeoutMs: 250, waitUntil: 'domcontentloaded',
    }))
  })
})
