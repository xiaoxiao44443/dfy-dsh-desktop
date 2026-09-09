import { createHash } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_IMAGE_FILE_BYTES = 64 * 1024 * 1024

export type ImageFile = { data: Buffer; extension: string }

function png(data: Buffer): boolean {
  if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR'
    || data.readUInt32BE(16) === 0 || data.readUInt32BE(20) === 0) return false
  let hasPixels = false
  for (let offset = 8; offset + 12 <= data.length;) {
    const size = data.readUInt32BE(offset)
    const end = offset + size + 12
    if (end > data.length) return false
    const kind = data.toString('ascii', offset + 4, offset + 8)
    if (kind === 'IDAT' && size > 0) hasPixels = true
    if (kind === 'IEND') return size === 0 && end === data.length && hasPixels
    offset = end
  }
  return false
}

function jpeg(data: Buffer): boolean {
  if (data.length < 12 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) return false
  let hasFrame = false
  for (let offset = 2; offset + 4 <= data.length;) {
    if (data[offset] !== 0xff) return false
    while (data[offset] === 0xff) offset += 1
    const marker = data[offset++]
    if (marker === undefined || offset + 2 > data.length) return false
    const size = data.readUInt16BE(offset)
    if (size < 2 || offset + size > data.length) return false
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size < 8 || data.readUInt16BE(offset + 3) === 0 || data.readUInt16BE(offset + 5) === 0) return false
      hasFrame = true
    }
    if (marker === 0xda) return hasFrame && offset + size < data.length - 2
    offset += size
  }
  return false
}

function gif(data: Buffer): boolean {
  if (data.length < 14 || !['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
    || data.readUInt16LE(6) === 0 || data.readUInt16LE(8) === 0) return false
  let offset = 13 + ((data[10]! & 0x80) === 0 ? 0 : 3 * 2 ** ((data[10]! & 7) + 1))
  let hasPixels = false
  while (offset < data.length) {
    const marker = data[offset++]
    if (marker === 0x3b) return hasPixels && offset === data.length
    if (marker === 0x2c) {
      if (offset + 9 >= data.length || data.readUInt16LE(offset + 4) === 0 || data.readUInt16LE(offset + 6) === 0) return false
      const flags = data[offset + 8]!
      offset += 9 + ((flags & 0x80) === 0 ? 0 : 3 * 2 ** ((flags & 7) + 1))
      const codeSize = data[offset++]
      if (codeSize === undefined || codeSize < 2 || codeSize > 8) return false
      hasPixels = true
    } else if (marker === 0x21) offset += 1 // Extension label, followed by data sub-blocks.
    else return false
    let blockSize: number | undefined
    do {
      blockSize = data[offset++]
      if (blockSize === undefined || offset + blockSize > data.length) return false
      offset += blockSize
    } while (blockSize > 0)
  }
  return false
}

function webp(data: Buffer): boolean {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) + 8 !== data.length) return false
  let hasPixels = false
  for (let offset = 12; offset + 8 <= data.length;) {
    const kind = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const end = offset + 8 + size + (size & 1)
    if (end > data.length) return false
    if (kind === 'VP8 ' && size >= 10 && data.toString('hex', offset + 11, offset + 14) === '9d012a'
      && (data.readUInt16LE(offset + 14) & 0x3fff) > 0 && (data.readUInt16LE(offset + 16) & 0x3fff) > 0) hasPixels = true
    if (kind === 'VP8L' && size >= 5 && data[offset + 8] === 0x2f) hasPixels = true
    if (kind === 'ANMF' && size >= 16) hasPixels = true
    if (end === data.length) return hasPixels
    offset = end
  }
  return false
}

/** Identify encoded images from bytes, without trusting a URL/MIME label or re-encoding pixels. */
export function imageFile(data: Buffer): ImageFile {
  if (data.length === 0 || data.length > MAX_IMAGE_FILE_BYTES) throw new Error('图片为空或超过 64 MiB 限制。')
  const extension = png(data) ? 'png' : jpeg(data) ? 'jpg' : gif(data) ? 'gif' : webp(data) ? 'webp' : undefined
  if (extension === undefined) throw new Error('图片数据无效或格式不受支持（支持 PNG、JPEG、GIF、WebP）。')
  return { data, extension }
}

export function imageCopyFilename(extension: string, now = new Date()): string {
  if (!['png', 'jpg', 'gif', 'webp'].includes(extension)) throw new Error('图片文件扩展名无效。')
  if (!Number.isFinite(now.getTime())) throw new Error('图片文件日期无效。')
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `DFY DSH 图像 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}.${extension}`
}

async function sameFile(path: string, data: Buffer): Promise<boolean> {
  const file = await open(path, 'r').catch(() => undefined)
  if (file === undefined) return false
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size !== data.length) return false
    // Bounded reads also handle a file that changes after stat without reading arbitrary amounts.
    const chunk = Buffer.alloc(Math.min(64 * 1024, data.length))
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, data.length - offset), offset)
      if (bytesRead === 0 || !chunk.subarray(0, bytesRead).equals(data.subarray(offset, offset + bytesRead))) return false
      offset += bytesRead
    }
    return (await file.read(chunk, 0, 1, offset)).bytesRead === 0
  } catch {
    return false
  } finally {
    await file.close()
  }
}

async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name))
}

export async function resolveImageRevealPath(image: ImageFile, options: {
  sourceUrl: string
  harnessHome: string
}): Promise<string | undefined> {
  // Recheck the caller-provided extension before using it in a filesystem path.
  image = imageFile(image.data)
  try {
    const url = new URL(options.sourceUrl)
    if (url.protocol === 'file:' && (url.hostname === '' || url.hostname === 'localhost')) {
      const source = fileURLToPath(url)
      if (isAbsolute(source) && !/^(?:\\\\|\/\/)/u.test(source) && await sameFile(source, image.data)) return source
    }
  } catch { /* A missing or non-file source can still belong to a durable image store. */ }

  const digest = createHash('sha256').update(image.data).digest('hex')
  if (isAbsolute(options.harnessHome)) {
    for (const project of await directories(join(options.harnessHome, 'sessions'))) {
      for (const session of await directories(project)) {
        const candidate = join(session, 'artifacts', 'images', digest, `image.${image.extension}`)
        if (await sameFile(candidate, image.data)) return candidate
      }
    }
    // Official dsh-attachment-local storedImagePath: objects/<first two digest chars>/<digest>.
    const attachment = join(options.harnessHome, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
    if (await sameFile(attachment, image.data)) return attachment
  }

  // Memory-only images have no file to reveal. Saving a copy is an explicit, separate action.
  return undefined
}
