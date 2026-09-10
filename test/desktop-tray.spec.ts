import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

const mocks = vi.hoisted(() => ({
  items: [] as MenuItemConstructorOptions[],
  instances: [] as (EventEmitter & { destroy: ReturnType<typeof vi.fn>; setContextMenu: ReturnType<typeof vi.fn> })[],
  createImage: vi.fn(),
  template: vi.fn(),
  empty: false,
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    Menu: { buildFromTemplate: (items: MenuItemConstructorOptions[]) => { mocks.items = items; return items } },
    nativeImage: { createFromPath: mocks.createImage.mockImplementation(() => ({
      isEmpty: () => mocks.empty, setTemplateImage: mocks.template,
    })) },
    Tray: class extends Emitter {
      destroyed = false
      destroy = vi.fn(() => { this.destroyed = true })
      isDestroyed = () => this.destroyed
      setToolTip = vi.fn()
      setContextMenu = vi.fn()
      constructor(readonly image: unknown) { super(); mocks.instances.push(this) }
    },
  }
})

import { DesktopTray } from '../src/main/desktop-tray.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dfy-tray-'))
  mocks.items = []; mocks.instances = []; mocks.empty = false
  vi.clearAllMocks()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function fixture(platform: NodeJS.Platform = 'win32') {
  const options = {
    platform, iconsRoot: '/icons', version: '0.1.5-rc.1', settingsPath: join(root, 'tray-settings.json'),
    showWindow: vi.fn(async () => {}), quit: vi.fn(), onError: vi.fn(),
  }
  const service = new DesktopTray(options)
  const window = Object.assign(new EventEmitter(), { hide: vi.fn(), isDestroyed: () => false })
  service.start()
  service.attachWindow(window as unknown as BrowserWindow)
  const close = () => {
    const event = { defaultPrevented: false, preventDefault: vi.fn() }
    window.emit('close', event)
    return event
  }
  const click = (id: string, checked?: boolean) => {
    const item = mocks.items.find(entry => entry.id === id)!
    item.click?.({ ...item, checked } as never, undefined, {} as never)
  }
  return { options, service, window, close, click }
}

describe('desktop tray lifecycle', () => {
  it.each(['win32', 'darwin'] as const)('keeps the conversation window alive by default on %s and restores it from the menu', async (platform) => {
    const f = fixture(platform)
    expect(mocks.items.filter(item => item.type !== 'separator').map(item => item.label)).toEqual([
      '打开 DFY DSH Desktop', '关闭窗口时退出', '退出 DFY DSH Desktop',
    ])
    expect(mocks.items.find(item => item.id === 'quit-on-close')?.checked).toBe(false)
    expect(f.close().preventDefault).toHaveBeenCalledOnce()
    expect(f.window.hide).toHaveBeenCalledOnce()
    expect(f.options.quit).not.toHaveBeenCalled()
    f.click('show')
    await vi.waitFor(() => expect(f.options.showWindow).toHaveBeenCalledOnce())
    f.service.dispose()
  })

  it.each(['win32', 'darwin'] as const)('persists close-to-quit on %s, exits the whole app and allows opting back out', async (platform) => {
    const first = fixture(platform)
    first.click('quit-on-close', true)
    expect(JSON.parse(await readFile(first.options.settingsPath, 'utf8'))).toEqual({ quitOnClose: true })
    first.close()
    expect(first.options.quit).toHaveBeenCalledOnce()
    expect(first.window.hide).not.toHaveBeenCalled()
    first.service.dispose()
    const next = fixture(platform)
    expect(mocks.items.find(item => item.id === 'quit-on-close')?.checked).toBe(true)
    next.click('quit-on-close', false)
    next.close()
    expect(next.options.quit).not.toHaveBeenCalled()
    expect(next.window.hide).toHaveBeenCalledOnce()
    next.service.dispose()
    const last = fixture(platform)
    expect(mocks.items.find(item => item.id === 'quit-on-close')?.checked).toBe(false)
    last.service.dispose()
  })

  it('lets explicit quit and OS shutdown close normally instead of hiding again', () => {
    const f = fixture()
    f.click('quit')
    expect(f.options.quit).toHaveBeenCalledOnce()
    // index.ts disposes the tray synchronously in before-quit.
    f.service.dispose()
    expect(f.close().preventDefault).not.toHaveBeenCalled()
    expect(f.window.hide).not.toHaveBeenCalled()
    expect(mocks.instances.at(-1)?.destroy).toHaveBeenCalledOnce()
    f.service.dispose()
    expect(mocks.instances.at(-1)?.destroy).toHaveBeenCalledOnce()
    const shutdown = fixture()
    shutdown.window.emit('query-session-end', {})
    expect(shutdown.close().preventDefault).not.toHaveBeenCalled()
  })

  it('uses a macOS template and reserves left-click restoration for Windows', async () => {
    const mac = fixture('darwin')
    expect(mocks.createImage).toHaveBeenCalledWith(join('/icons', 'trayTemplate.png'))
    expect(mocks.template).toHaveBeenCalledWith(true)
    mocks.instances.at(-1)?.emit('click')
    expect(mac.options.showWindow).not.toHaveBeenCalled()
    mac.service.dispose()
    const win = fixture('win32')
    expect(mocks.instances.at(-1)).toHaveProperty('image', join('/icons', 'tray.ico'))
    mocks.instances.at(-1)?.emit('click')
    await vi.waitFor(() => expect(win.options.showWindow).toHaveBeenCalledOnce())
    win.service.dispose()
  })

  it('does not intercept close when the tray is unavailable or unsupported', () => {
    mocks.empty = true
    expect(() => fixture('darwin')).toThrow(/菜单栏图标/)
    expect(mocks.instances).toHaveLength(0)
    const f = fixture('linux')
    expect(f.service.isActive).toBe(false)
    expect(f.close().preventDefault).not.toHaveBeenCalled()
    f.service.dispose()
  })

  it('retains the previous preference and reports an unwritable settings path', async () => {
    const f = fixture()
    await rm(root, { recursive: true })
    await writeFile(root, 'not a directory')
    f.click('quit-on-close', true)
    expect(f.options.onError).toHaveBeenCalledOnce()
    f.close()
    expect(f.window.hide).toHaveBeenCalledOnce()
    expect(f.options.quit).not.toHaveBeenCalled()
    f.service.dispose()
  })

  it('defaults to close-to-hide for malformed or nonboolean saved settings', async () => {
    for (const text of ['{', 'null', '{"quitOnClose":"true"}']) {
      await writeFile(join(root, 'tray-settings.json'), text)
      const f = fixture()
      f.close()
      expect(f.window.hide).toHaveBeenCalledOnce()
      f.service.dispose()
    }
  })
})
