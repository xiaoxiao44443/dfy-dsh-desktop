import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserTools } from '../resources/dsh-desktop-browser/lib/index.js'

afterEach(() => vi.unstubAllGlobals())

async function runWithResponses(code: string, responses: Record<string, unknown>[]) {
  const pending = [...responses]
  vi.stubGlobal('fetch', vi.fn(async () => {
    const response = pending.shift()
    if (response === undefined) throw new Error('Unexpected browser action')
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  const tool = createBrowserTools('http://127.0.0.1:12345/v1/restart-harness', 'secret')[0]
  const result = await tool.execute({ code }, { agent: { id: 'session-feedback-test' } })
  expect(pending).toHaveLength(0)
  return JSON.parse(result)
}

describe('browser resource action feedback', () => {
  it('keeps verified input and hit status in summaries without exposing input text', async () => {
    const output = await runWithResponses(`
      const tab = await browser.tabs.new();
      await tab.playwright.getByRole('textbox', { name: 'Search' }).fill('private search');
      await tab.playwright.getByRole('button', { name: 'Search' }).click();
      return 'done';
    `, [
      { ok: true, tabId: 'feedback-test' },
      { ok: true, tabId: 'feedback-test', operation: 'fill', method: 'dom', characters: 14, inputVerified: true, value: 'private search' },
      { ok: true, tabId: 'feedback-test', operation: 'click', hitVerified: true },
    ])
    expect(output.actions[1]).toEqual({
      action: 'locator', ok: true, tabId: 'feedback-test', operation: 'fill', method: 'dom', characters: 14, inputVerified: true,
    })
    expect(output.actions[2]).toEqual({
      action: 'locator', ok: true, tabId: 'feedback-test', operation: 'click', hitVerified: true,
    })
    expect(JSON.stringify(output)).not.toContain('private search')
  })

  it('distinguishes a closed tab, remaining session tabs, and resulting panel visibility', async () => {
    const output = await runWithResponses(`
      const tab = await browser.tabs.new();
      await tab.close();
      await browser.tabs.finalize({ keep: [] });
      return 'done';
    `, [
      { ok: true, tabId: 'feedback-test' },
      { ok: true, tabId: 'feedback-test', panelOpen: true },
      { ok: true, closed: ['temporary-a', 'temporary-b'], released: ['user-tab'], tabs: [], panelOpen: true },
    ])
    expect(output.actions[1]).toEqual({ action: 'close', ok: true, tabId: 'feedback-test', panelOpen: true })
    expect(output.actions[2]).toEqual({
      action: 'finalize', ok: true, panelOpen: true, tabCount: 0, closedTabCount: 2, releasedTabCount: 1,
    })
  })

  it('retains false panel state when closing the final global tab', async () => {
    const output = await runWithResponses(`
      const tab = await browser.tabs.new();
      await tab.close();
      return 'done';
    `, [
      { ok: true, tabId: 'feedback-test' },
      { ok: true, tabId: 'feedback-test', panelOpen: false },
    ])
    expect(output.actions[1]).toEqual({ action: 'close', ok: true, tabId: 'feedback-test', panelOpen: false })
  })

  it.each(['failed', 'timeout'])('throws a %s navigation result with the specific desktop diagnostic', async (status) => {
    const message = '导航失败：当前 URL https://example.com/；预期 URL https://example.com/next；原因 ERR_CONNECTION_REFUSED'
    await expect(runWithResponses(`
      const tab = await browser.tabs.new();
      await tab.goto('https://example.com/next');
      return 'must not report success';
    `, [
      { ok: true, tabId: 'feedback-test' },
      { ok: false, tabId: 'feedback-test', status, reason: 'navigation-failed', message },
    ])).rejects.toThrow(message)
  })

  it('keeps screenshot pixel-to-CSS mapping in both action summaries and screenshot resources', async () => {
    const geometry = {
      width: 1400,
      height: 700,
      viewportWidth: 1280,
      viewportHeight: 800,
      coordinateMapping: { originX: 110, originY: 150, cssPixelsPerImagePixelX: 0.5, cssPixelsPerImagePixelY: 0.5 },
    }
    const output = await runWithResponses(`
      const tab = await browser.tabs.new();
      await tab.screenshot({ rect: { x: 110, y: 150, width: 700, height: 350 } });
      return 'done';
    `, [
      { ok: true, tabId: 'feedback-test' },
      {
        ok: true, tabId: 'feedback-test', resourceId: 'a'.repeat(43),
        path: '/tmp/region.png', mimeType: 'image/png', bytes: 1024,
        sourceUrl: 'https://example.com/', capturedAt: '2026-09-10T00:00:00.000Z', ...geometry,
      },
    ])
    expect(output.actions[1]).toEqual(expect.objectContaining({ action: 'screenshot', ...geometry }))
    expect(output.screenshotResources).toEqual([expect.objectContaining({
      resourceRef: expect.stringMatching(/^dfyr1_/), path: '/tmp/region.png', ...geometry,
    })])
  })
})
