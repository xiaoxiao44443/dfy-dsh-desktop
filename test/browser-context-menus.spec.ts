import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function setup(stat = vi.fn()) {
  const menus = new Map<string, { resolve(target: unknown, signal: AbortSignal): any }>()
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ opened: true }) }))
  let plugin: any
  runInNewContext(readFileSync(new URL('../resources/dsh-desktop-browser/lib/client.js', import.meta.url), 'utf8'), {
    URL, fetch,
    window: { __ModuleLoader__: { load: (entry: any) => { plugin = entry.factory(() => ({})) } } },
  })
  const dispose = plugin.installBrowserContextMenus({
    remote: { workspaceFiles: { stat } },
    contextMenus: { register: (contribution: any) => {
      menus.set(contribution.target, contribution)
      return () => menus.delete(contribution.target)
    } },
  })
  return { menus, fetch, dispose, stat }
}

describe('desktop destinations in official context menus', () => {
  it('preserves a captured URL and removes contributions on unload', async () => {
    const { menus, fetch, dispose } = setup()
    const menu = menus.get('url')!
    const target = { url: 'https://example.com/?q=%E4%B8%AD#item' }
    const [action] = menu.resolve(target, new AbortController().signal)
    target.url = 'https://other.example/'
    await action.run()
    expect(fetch).toHaveBeenCalledWith('/api/dsh-desktop/browser/open', expect.objectContaining({
      body: JSON.stringify({ url: 'https://example.com/?q=%E4%B8%AD#item' }),
    }))
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/x.exe']) {
      expect(menu.resolve({ url }, new AbortController().signal)).toEqual([])
    }
    dispose()
    expect(menus.size).toBe(0)
  })

  it('resolves HTML in its captured session and rejects cancelled metadata', async () => {
    const stat = vi.fn(async () => ({ ok: true, value: { absolutePath: 'E:\\项目 文件\\页面 #1.html' } }))
    const { menus, fetch } = setup(stat)
    const signal = new AbortController().signal
    const menu = menus.get('file')!
    const [action] = await menu.resolve({ sessionId: 'original', path: '页面 #1.html' }, signal)
    expect(stat).toHaveBeenCalledWith('original', '页面 #1.html', signal)
    await action.run()
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ url: 'E:\\项目 文件\\页面 #1.html' })
    expect(await menu.resolve({ sessionId: 'other', path: 'notes.txt' }, signal)).toEqual([])
    stat.mockResolvedValueOnce({ ok: false } as never)
    expect(await menu.resolve({ sessionId: 'other', path: 'missing.html' }, signal)).toEqual([])
    await expect(menu.resolve({ sessionId: 'other', path: 'page.html' }, AbortSignal.abort(new Error('closed')))).rejects.toThrow('closed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
