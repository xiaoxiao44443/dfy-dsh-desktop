import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, dialog, shell } from 'electron'
import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import { imageCopyFilename, imageFile, MAX_IMAGE_FILE_BYTES, resolveImageRevealPath } from './image-files.js'
import type { ImageFile } from './image-files.js'
import { IMAGE_CONTEXT_KEY } from './image-context.js'

export interface ContextMenuImageSource {
  srcURL: string
  frame: WebFrameMain
  contents: WebContents
  x: number
  y: number
}

async function readImageResponse(response: Response): Promise<Buffer> {
  if (!response.ok || response.body === null) throw new Error('无法读取这张图片。')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_IMAGE_FILE_BYTES) throw new Error('图片超过 64 MB，无法保存。')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks)
}

/** Read the original encoded bytes, retaining GIF animation and image metadata. */
export async function readContextMenuImage(source: ContextMenuImageSource): Promise<ImageFile> {
  if (source.frame.isDestroyed() || source.contents.isDestroyed()) throw new Error('图片所在页面已关闭。')
  if (/^file:/iu.test(source.srcURL)) {
    const url = new URL(source.srcURL)
    if (url.hostname !== '') throw new Error('不支持网络共享图片路径。')
    const path = fileURLToPath(url)
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_IMAGE_FILE_BYTES) throw new Error('图片文件不存在或超过 64 MB。')
    return imageFile(await readFile(path))
  }
  if (source.srcURL !== '' && !/^(?:https?:|blob:|data:image\/)/iu.test(source.srcURL)) {
    throw new Error('不支持这个图片地址。')
  }
  try {
    // Blob URLs belong to the source frame. Reading there also reuses its HTTP
    // cache and credentials; no original resource is replaced with a screenshot.
    const result: unknown = await source.frame.executeJavaScript(`(async () => {
      let src = ${JSON.stringify(source.srcURL)}
      if (!src) {
        const captured = window[Symbol.for(${JSON.stringify(IMAGE_CONTEXT_KEY)})]
        if (!captured || Date.now() - captured.capturedAt > 300000) throw new Error('找不到右键选中的图片。')
        const target = captured.target
        if (target instanceof HTMLImageElement) src = target.currentSrc || target.src
        else if (target instanceof HTMLCanvasElement) {
          if (!target.width || !target.height || target.width * target.height > 100000000) throw new Error('画布为空或过大。')
          return target.toDataURL('image/png')
        }
        if (!src || !/^(?:https?:|blob:|data:image\\/)/i.test(src)) throw new Error('不支持这个图片地址。')
      }
      const response = await fetch(src, { signal: AbortSignal.timeout(15000) })
      if (!response.ok || !response.body) throw new Error('无法读取图片。')
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > ${MAX_IMAGE_FILE_BYTES}) throw new Error('图片超过 64 MB。')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      const blob = new Blob(chunks, { type: 'application/octet-stream' })
      return await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('无法读取图片数据。'))
        reader.readAsDataURL(blob)
      })
    })()`)
    if (typeof result !== 'string' || result.length > Math.ceil(MAX_IMAGE_FILE_BYTES * 4 / 3) + 100) {
      throw new Error('图片数据无效或过大。')
    }
    const encoded = /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(result)?.[1]
    if (encoded === undefined) throw new Error('图片数据无效。')
    return imageFile(Buffer.from(encoded, 'base64'))
  } catch (error) {
    if (!/^https?:\/\//iu.test(source.srcURL)) throw error
    // A displayed cross-origin image may not grant CORS access to page JS.
    // Electron's session fetch preserves browser cookies without disabling CORS.
    const response = await source.contents.session.fetch(source.srcURL, {
      credentials: 'include',
      signal: AbortSignal.timeout(15000),
      ...(/^https?:\/\//iu.test(source.frame.url) ? { referrer: source.frame.url } : {}),
    })
    return imageFile(await readImageResponse(response))
  }
}

export async function saveContextMenuImage(source: ContextMenuImageSource, owner: BrowserWindow): Promise<void> {
  const image = await readContextMenuImage(source)
  const selected = await dialog.showSaveDialog(owner, {
    title: '下载副本',
    buttonLabel: '保存',
    defaultPath: join(app.getPath('downloads'), imageCopyFilename(image.extension)),
    filters: [{ name: '图像', extensions: [image.extension] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  })
  if (selected.canceled || selected.filePath === undefined) return
  await writeFile(selected.filePath, image.data)
}

export async function findContextMenuImagePath(source: ContextMenuImageSource, harnessHome: string): Promise<string | undefined> {
  const image = await readContextMenuImage(source)
  return resolveImageRevealPath(image, {
    sourceUrl: source.srcURL,
    harnessHome,
  })
}

export async function revealContextMenuImage(path: string): Promise<void> {
  if (!(await stat(path)).isFile()) throw new Error('图片原文件已不存在。')
  shell.showItemInFolder(path)
}
