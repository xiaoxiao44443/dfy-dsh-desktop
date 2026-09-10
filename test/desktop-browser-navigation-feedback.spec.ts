import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNavigationState, waitForNavigation, waitForNavigationStability } from '../src/main/desktop-browser-automation.js'
import type { BrowserTabRuntime } from '../src/main/desktop-browser-types.js'

afterEach(() => vi.useRealTimers())

function fixture(url = 'https://example.com/current') {
  const tab = {
    id: 'navigation-test', url, title: 'Page', navigationVersion: 1, lastNavigationKind: 'document',
    loading: false, networkActivityVersion: 0, networkIdleSince: Date.now() - 1_000,
    inflightRequests: new Set<string>(), inflightRequestDetails: new Map(),
    view: { webContents: { isDestroyed: () => false, getURL: () => url, getTitle: () => 'Page' } },
  } as unknown as BrowserTabRuntime
  const command = vi.fn(async () => ({ result: { value: { readyState: 'complete', title: 'Page', h1: '', text: 'Ready' } } }))
  return { tab, command }
}

describe('browser navigation feedback', () => {
  it('prioritizes current and expected URLs without dumping analytics request URLs', async () => {
    vi.useFakeTimers()
    const { tab, command } = fixture()
    tab.inflightRequests.add('analytics')
    tab.inflightRequestDetails?.set('analytics', { type: 'Fetch', url: `https://analytics.example/collect?secret=${'x'.repeat(8_000)}`, startedAt: Date.now() })
    const message = waitForNavigation(tab, { url: 'https://example.com/expected', timeoutMs: 250, waitUntil: 'networkidle' }, false, command)
      .catch((error: Error) => error.message)
    await vi.runAllTimersAsync()
    expect(await message).toContain('当前 URL：https://example.com/current')
    expect(await message).toContain('预期 URL：https://example.com/expected')
    expect(await message).toContain('当前 URL 未匹配预期 URL')
    expect(await message).not.toContain('analytics.example')
    expect((await message as string).length).toBeLessThan(500)
  })

  it('reports a real main-document failure rather than a generic timeout', async () => {
    const { tab, command } = fixture()
    tab.lastNavigationFailure = { url: 'https://example.com/target', message: 'ERR_NAME_NOT_RESOLVED (-105)', at: Date.now() }
    await expect(waitForNavigation(tab, { url: tab.lastNavigationFailure.url, timeoutMs: 250 }, false, command))
      .rejects.toThrow('ERR_NAME_NOT_RESOLVED (-105)')
    await expect(waitForNavigation(tab, { url: tab.lastNavigationFailure.url, timeoutMs: 250 }, false, command))
      .rejects.toThrow('导航失败。当前 URL：https://example.com/current。预期 URL：https://example.com/target')
  })

  it('does not mistake a prior failed attempt for a new navigation', async () => {
    vi.useFakeTimers()
    const { tab, command } = fixture()
    tab.lastNavigationFailure = { url: 'https://example.com/old', message: 'old failure', at: Date.now() - 1_000 }
    const before = await readNavigationState(tab, command)
    const result = waitForNavigationStability(tab, before, { timeoutMs: 250, waitUntil: 'load', requireNavigation: true }, command)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ status: 'timeout', reason: 'no-navigation' })
  })

  it('waits for a delayed retry of the same URL instead of reusing its earlier failure', async () => {
    vi.useFakeTimers()
    const { tab, command } = fixture()
    const targetUrl = 'https://example.com/retry'
    tab.lastNavigationFailure = { url: targetUrl, message: 'earlier failed attempt', at: Date.now() - 10_000 }
    const before = await readNavigationState(tab, command)
    // An action can schedule its navigation after expectNavigation starts
    // observing. Its before snapshot must not condemn the new attempt.
    setTimeout(() => {
      delete tab.lastNavigationFailure
      tab.navigationVersion += 1
      tab.view.webContents.getURL = () => targetUrl
    }, 80)
    const result = waitForNavigationStability(tab, before, {
      timeoutMs: 1_000, waitUntil: 'load', expectedUrl: targetUrl, requireNavigation: true,
    }, command)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ status: 'success', state: { url: targetUrl, version: before.version + 1 } })
    expect((await result).elapsedMs).toBeGreaterThanOrEqual(80)
  })

  it('still reports a new failure during an explicit navigation retry', async () => {
    vi.useFakeTimers()
    const { tab, command } = fixture()
    const targetUrl = 'https://example.com/retry'
    tab.lastNavigationFailure = { url: targetUrl, message: 'earlier failed attempt', at: Date.now() - 10_000 }
    const before = await readNavigationState(tab, command)
    setTimeout(() => {
      tab.lastNavigationFailure = { url: targetUrl, message: 'ERR_CONNECTION_REFUSED (-102)', at: Date.now() }
    }, 80)
    const result = waitForNavigationStability(tab, before, {
      timeoutMs: 1_000, waitUntil: 'load', expectedUrl: targetUrl, requireNavigation: true,
    }, command)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ status: 'failed', reason: 'navigation-failed',
      state: { failure: { message: 'ERR_CONNECTION_REFUSED (-102)' } } })
  })

  it('allows a loaded page to settle while background analytics requests keep changing', async () => {
    vi.useFakeTimers()
    const { tab, command } = fixture()
    const before = await readNavigationState(tab, command)
    tab.navigationVersion += 1
    command.mockImplementation(async () => {
      tab.networkActivityVersion = (tab.networkActivityVersion ?? 0) + 1
      tab.inflightRequests.add(`analytics-${tab.networkActivityVersion}`)
      return { result: { value: { readyState: 'complete', title: 'Page', h1: '', text: 'Ready' } } }
    })
    const result = waitForNavigationStability(tab, before, { timeoutMs: 1_000, waitUntil: 'load', requireNavigation: true }, command)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ status: 'success' })
    expect((await result).elapsedMs).toBeLessThan(500)
  })

  it('does not reject an already matching URL because a broad pattern also matches an old failure', async () => {
    const { tab, command } = fixture('https://example.com/ready')
    tab.lastNavigationFailure = { url: 'https://example.com/old-failed', message: 'old failure', at: Date.now() - 10_000 }
    const before = await readNavigationState(tab, command)
    const result = await waitForNavigationStability(tab, before, {
      timeoutMs: 250, waitUntil: 'commit', expectedUrl: 'https://example.com/*', requireNavigation: false, acceptCurrent: true,
    }, command)
    expect(result.status).toBe('success')
  })

  it('retains a local HTML URL when committing navigation state', async () => {
    const { tab, command } = fixture('file:///E:/pages/index.html')
    const before = await readNavigationState(tab, command)
    await waitForNavigationStability(tab, before, { timeoutMs: 250, waitUntil: 'commit', requireNavigation: false, acceptCurrent: true }, command)
    expect(tab.url).toBe('file:///E:/pages/index.html')
  })
})
