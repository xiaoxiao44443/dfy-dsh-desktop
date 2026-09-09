import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mocks = vi.hoisted(() => ({
  showSaveDialog: vi.fn(), showItemInFolder: vi.fn(), writeFile: vi.fn(),
  readFile: vi.fn(), stat: vi.fn(), resolveImageRevealPath: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'downloads' ? '/test-downloads' : '/test-app-data' },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  shell: { showItemInFolder: mocks.showItemInFolder },
}))
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  readFile: mocks.readFile, writeFile: mocks.writeFile, stat: mocks.stat,
}))
vi.mock('../src/main/image-files.js', async (original) => ({
  ...await original<typeof import('../src/main/image-files.js')>(),
  resolveImageRevealPath: mocks.resolveImageRevealPath,
}))

import { findContextMenuImagePath, readContextMenuImage, revealContextMenuImage, saveContextMenuImage } from '../src/main/image-actions.js'
import type { ContextMenuImageSource } from '../src/main/image-actions.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2cikAAAAASUVORK5CYII=', 'base64')
const dataUrl = `data:application/octet-stream;base64,${png.toString('base64')}`
function source(url = 'blob:http://localhost/image') {
  const frame = { isDestroyed: () => false, url: 'http://localhost/session', executeJavaScript: vi.fn(async () => dataUrl) }
  const contents = { isDestroyed: () => false, session: { fetch: vi.fn() } }
  return { srcURL: url, x: 42, y: 64, frame, contents }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.readFile.mockResolvedValue(png)
  mocks.stat.mockResolvedValue({ isFile: () => true, size: png.length })
})
afterEach(() => { vi.useRealTimers() })

describe('image context-menu actions', () => {
  it('reads blob images in their source frame without re-encoding the original', async () => {
    const target = source()
    const image = await readContextMenuImage(target as unknown as ContextMenuImageSource)
    expect(image.data).toEqual(png)
    expect(image.extension).toBe('png')
    expect(target.frame.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('fetch(src'))
    expect(target.contents.session.fetch).not.toHaveBeenCalled()
  })

  it('opens the native save dialog with the requested local timestamp and writes to its selected path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 9, 19, 23, 54))
    const target = source()
    const owner = {} as never
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/chosen/副本.png' })
    await saveContextMenuImage(target as unknown as ContextMenuImageSource, owner)
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(owner, expect.objectContaining({
      title: '下载副本', buttonLabel: '保存',
      defaultPath: join('/test-downloads', 'DFY DSH 图像 2026年9月9日 19_23_54.png'),
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    }))
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith('/chosen/副本.png', png)
  })

  it('does not write any copy when the native save dialog is canceled', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true })
    await saveContextMenuImage(source() as unknown as ContextMenuImageSource, {} as never)
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.resolveImageRevealPath).not.toHaveBeenCalled()
  })

  it('reveals the resolved image using the native Explorer/Finder operation', async () => {
    mocks.resolveImageRevealPath.mockResolvedValue('/existing/image.png')
    const path = await findContextMenuImagePath(source() as unknown as ContextMenuImageSource, '/harness-home')
    expect(path).toBe('/existing/image.png')
    await revealContextMenuImage(path!)
    expect(mocks.resolveImageRevealPath).toHaveBeenCalledWith({ data: png, extension: 'png' }, {
      sourceUrl: 'blob:http://localhost/image', harnessHome: '/harness-home',
    })
    expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/existing/image.png')
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('leaves memory-only images without a reveal path or an implicit saved copy', async () => {
    mocks.resolveImageRevealPath.mockResolvedValue(undefined)
    expect(await findContextMenuImagePath(source() as unknown as ContextMenuImageSource, '/harness-home')).toBeUndefined()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('does not reveal a file removed while the menu was open', async () => {
    mocks.stat.mockRejectedValue(new Error('ENOENT'))
    await expect(revealContextMenuImage('/removed/image.png')).rejects.toThrow('ENOENT')
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it('reads local image bytes without a renderer fetch', async () => {
    const path = join(process.cwd(), '图像 #1.png')
    const target = source(pathToFileURL(path).href)
    expect((await readContextMenuImage(target as unknown as ContextMenuImageSource)).data).toEqual(png)
    expect(mocks.readFile).toHaveBeenCalledWith(path)
    expect(target.frame.executeJavaScript).not.toHaveBeenCalled()
  })

  it('uses browser-session fetch with the page referrer for cross-origin images', async () => {
    const target = source('https://images.example/image.png')
    target.frame.executeJavaScript.mockRejectedValue(new Error('CORS'))
    target.contents.session.fetch.mockResolvedValue(new Response(png))
    expect((await readContextMenuImage(target as unknown as ContextMenuImageSource)).data).toEqual(png)
    expect(target.contents.session.fetch).toHaveBeenCalledWith(target.srcURL, expect.objectContaining({
      credentials: 'include', referrer: 'http://localhost/session',
    }))
  })

  it('rejects non-images before opening a save dialog', async () => {
    const target = source()
    target.frame.executeJavaScript.mockResolvedValue('data:text/html;base64,PGh0bWw+SGk8L2h0bWw+')
    await expect(saveContextMenuImage(target as unknown as ContextMenuImageSource, {} as never)).rejects.toThrow()
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('does not try to fetch revoked blob URLs through the host network', async () => {
    const target = source()
    target.frame.executeJavaScript.mockRejectedValue(new Error('Blob URL revoked'))
    await expect(readContextMenuImage(target as unknown as ContextMenuImageSource)).rejects.toThrow('revoked')
    expect(target.contents.session.fetch).not.toHaveBeenCalled()
  })
})
