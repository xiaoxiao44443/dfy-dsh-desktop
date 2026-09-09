import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getApplicationInfoForProtocol: vi.fn() },
  shell: { openExternal: vi.fn() },
}))
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import { createDefaultBrowserOpener } from '../src/main/default-browser.js'

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function fixture(platform: NodeJS.Platform = 'win32') {
  const run = vi.fn(async () => '')
  const openExternal = vi.fn(async () => {})
  const applicationPathForProtocol = vi.fn(async () => 'C:\\Program Files\\Browser\\browser.exe')
  const isFile = vi.fn(async () => true)
  const open = createDefaultBrowserOpener({ platform, run, openExternal, applicationPathForProtocol, isFile })
  return { open, run, openExternal, applicationPathForProtocol, isFile }
}

describe('openInDefaultBrowser', () => {
  it('keeps HTTP(S) opening through Electron without consulting file associations', async () => {
    const context = fixture()
    await context.open('https://example.com/page.html')
    expect(context.openExternal).toHaveBeenCalledWith('https://example.com/page.html')
    expect(context.applicationPathForProtocol).not.toHaveBeenCalled()
    expect(context.isFile).not.toHaveBeenCalled()
  })

  it('opens HTML in the HTTPS browser even when the HTML association could be an editor', async () => {
    const context = fixture()
    const path = 'C:\\网页 文件\\视频 & $(calc) ` % #.html'
    const url = pathToFileURL(path, { windows: true }).href + '?mode=one&next=two#播放'
    await context.open(url)
    expect(context.applicationPathForProtocol).toHaveBeenCalledExactlyOnceWith('https://')
    expect(context.isFile).toHaveBeenCalledWith(path)
    expect(context.run).toHaveBeenCalledExactlyOnceWith('C:\\Program Files\\Browser\\browser.exe', [new URL(url).href], false)
    expect(context.openExternal).not.toHaveBeenCalled()
  })

  it('passes a single URL argument to a hidden, shell-free browser launch', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child as never
    })
    const open = createDefaultBrowserOpener({
      platform: 'win32', isFile: async () => true,
      applicationPathForProtocol: async () => 'C:\\Program Files\\Browser\\browser.exe',
    })
    const url = 'file:///C:/pages/a%20%26%20b.html'
    await open(url)
    expect(spawn).toHaveBeenCalledWith('C:\\Program Files\\Browser\\browser.exe', [url], {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('reports a browser launch failure without falling back to the HTML application', async () => {
    const context = fixture()
    context.run.mockRejectedValue(new Error('spawn browser.exe ENOENT'))
    await expect(context.open('file:///C:/page.html')).rejects.toThrow('无法在系统默认浏览器中打开本地网页：spawn browser.exe ENOENT')
    expect(context.openExternal).not.toHaveBeenCalled()
  })

  it.each(['', 'browser.exe', 'C:\\Browser\\launch.cmd'])('rejects an unresolved default-browser executable: %s', async (path) => {
    const context = fixture()
    context.applicationPathForProtocol.mockResolvedValue(path)
    await expect(context.open('file:///C:/page.html')).rejects.toThrow('无法确定系统默认浏览器')
    expect(context.run).not.toHaveBeenCalled()
  })

  it('checks the original file exists and is a regular file before launching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'default-browser-'))
    roots.push(root)
    const page = join(root, '中文 网页.html')
    const directory = join(root, 'directory.html')
    await writeFile(page, '<!doctype html><title>test</title>')
    await mkdir(directory)
    const run = vi.fn(async () => '')
    const open = createDefaultBrowserOpener({ run, applicationPathForProtocol: async () => process.platform === 'darwin' ? '/Applications/Browser.app' : 'C:\\Browser\\browser.exe' })
    await expect(open(pathToFileURL(join(root, 'missing.html')).href)).rejects.toThrow('ENOENT')
    await expect(open(pathToFileURL(directory).href)).rejects.toThrow('不是普通文件')
    expect(run).not.toHaveBeenCalled()
    if (process.platform === 'linux') run.mockResolvedValueOnce('browser.desktop')
    await open(pathToFileURL(page).href)
    expect(run).toHaveBeenCalled()
  })

  it.each(['file://server/share/page.html', 'file:///C:/page.exe', 'file:///C:/page.html%00', 'file:///C:/page%2Finner.html', 'javascript:alert(1)'])('rejects an unsupported file target: %s', async (url) => {
    const context = fixture()
    await expect(context.open(url)).rejects.toThrow('只支持')
    expect(context.run).not.toHaveBeenCalled()
    expect(context.openExternal).not.toHaveBeenCalled()
  })

  it('selects the macOS HTTPS browser explicitly when opening a local file', async () => {
    const context = fixture('darwin')
    context.applicationPathForProtocol.mockResolvedValue('/Applications/Default Browser.app')
    await context.open('file:///Users/person/page.html')
    expect(context.run).toHaveBeenCalledWith('/usr/bin/open', ['-a', '/Applications/Default Browser.app', 'file:///Users/person/page.html'], true)
  })

  it('launches the Linux default browser desktop entry without changing file associations', async () => {
    const context = fixture('linux')
    context.run.mockResolvedValueOnce('org.mozilla.firefox.desktop\n')
    await context.open('file:///home/person/page.html')
    expect(context.run.mock.calls).toEqual([
      ['xdg-settings', ['get', 'default-web-browser'], true],
      ['gtk-launch', ['org.mozilla.firefox.desktop', 'file:///home/person/page.html'], true],
    ])
  })

  it('rejects invalid Linux default-browser settings instead of executing a command', async () => {
    const context = fixture('linux')
    context.run.mockResolvedValueOnce('browser.desktop; touch /tmp/unwanted')
    await expect(context.open('file:///home/person/page.html')).rejects.toThrow('无法确定系统默认浏览器')
    expect(context.run).toHaveBeenCalledOnce()
  })
})
